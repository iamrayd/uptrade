import { test } from "node:test";
import assert from "node:assert/strict";
import { breaks, engulfing, fvgAt, levels, orderBlockFor, pinBar, rejects, swings, zoneState, type Zone } from "../../supabase/functions/_shared/bot/structure.ts";
import { CANDIDATES, fvg, liquiditySweep, orderBlock } from "../../supabase/functions/_shared/bot/strategies.ts";
import { atr } from "../../supabase/functions/_shared/bot/indicators.ts";
import type { Candle, Signal } from "../../supabase/functions/_shared/bot/types.ts";

// Hand-built candles, so each detector and each rule is checked against a picture a trader
// would draw, not against itself.

const bar = (open: number, high: number, low: number, close: number): Omit<Candle, "time"> => ({ open, high, low, close, volume: 100 });
/** Numbers the bars from 0, one hour apart. */
const series = (list: Omit<Candle, "time">[]): Candle[] => list.map((c, i) => ({ ...c, time: i * 3600 }));
/** `n` quiet bars around `price`: 0.2 of range, alternating colour, so ATR is about 0.2. */
const quiet = (n: number, price: number) => Array.from({ length: n }, (_, i) => (i % 2 ? bar(price + 0.02, price + 0.1, price - 0.1, price - 0.02) : bar(price - 0.02, price + 0.1, price - 0.1, price + 0.02)));
/** `n` bars drifting from `from` by `step` a bar, each closing in the direction of the drift. */
const drift = (n: number, from: number, step: number) =>
  Array.from({ length: n }, (_, i) => {
    const o = from + i * step;
    const c = o + step;
    return bar(o, Math.max(o, c) + 0.05, Math.min(o, c) - 0.05, c);
  });
const sig = (r: ReturnType<typeof fvg.entry>): Signal => {
  assert.ok(r && !("skip" in r), "expected a signal");
  return r as Signal;
};

// ───────── swings and breaks ─────────

test("swings: a pivot needs lower highs on both sides and exists only once its right side has closed", () => {
  // Highs: a peak of 105 at index 5.
  const c = series([...quiet(3, 100), bar(100, 101, 99.9, 100.8), bar(100.8, 103, 100.7, 102.8), bar(102.8, 105, 102.5, 104), bar(104, 104.2, 102, 102.2), bar(102.2, 102.4, 101, 101.2), bar(101.2, 101.4, 100.4, 100.6), ...quiet(3, 100.5)]);
  const highs = (upTo: number) => swings(c, 3, 3, upTo).filter((p) => p.kind === "high");
  assert.deepEqual(highs(c.length - 1).map((p) => [p.i, p.price]), [[5, 105]]);
  // No look-ahead: with only two bars closed after the peak it is not a swing yet.
  assert.deepEqual(highs(7), []);
  assert.deepEqual(highs(8).map((p) => p.i), [5], "confirmed exactly `right` bars later");
  // What is known at bar k is the same whether or not later bars exist.
  for (let k = 3; k < c.length; k++) assert.deepEqual(swings(c, 3, 3, k), swings(c.slice(0, k + 1), 3, 3));
  // Equal highs are not a swing (no pivot in a flat run).
  assert.deepEqual(swings(series(quiet(20, 100)), 3, 3), []);
});

test("breaks: the first close beyond a swing, and only after the swing was confirmed", () => {
  const base = [...quiet(4, 100), bar(100, 102, 99.9, 101.5), bar(101.5, 101.6, 100.5, 100.7), bar(100.7, 100.9, 100.2, 100.4), bar(100.4, 100.6, 100.1, 100.3)];
  // Swing high 102 at index 4, confirmed at index 7. A wick above it is not a break; a close is.
  const c = series([...base, bar(100.3, 102.5, 100.2, 101), bar(101, 103, 100.9, 102.8), bar(102.8, 104, 102.7, 103.9)]);
  const pivots = swings(c, 3, 3);
  const b = breaks(c, pivots, 3).filter((x) => x.side === "long");
  assert.deepEqual(b.map((x) => [x.i, x.level]), [[9, 102]], "bar 8 only wicked above; bar 9 closed above; bar 10 is not a second break");
  assert.deepEqual(breaks(c, pivots, 3, 8), [], "nothing is known before the breaking bar closes");
  // A close through the high before the swing is confirmed means it was never a swing to break.
  const early = series([...quiet(4, 100), bar(100, 102, 99.9, 101.5), bar(101.5, 101.6, 100.5, 100.7), bar(100.7, 103, 100.6, 102.9), ...quiet(5, 103)]);
  assert.deepEqual(breaks(early, swings(early, 3, 3), 3).filter((x) => x.level === 102), []);
});

// ───────── fair value gaps, order blocks, zones ─────────

test("fvgAt: three candles that do not overlap, with a displacement in the middle", () => {
  // Bullish: low of the third (101.2) above the high of the first (100.1).
  const up = series([bar(100, 100.1, 99.9, 100), bar(100, 101.5, 99.95, 101.4), bar(101.4, 101.8, 101.2, 101.7)]);
  assert.deepEqual(fvgAt(up, 2, 0.5), { side: "long", top: 101.2, bottom: 100.1, i: 2 });
  // Bearish mirror.
  const down = series([bar(100, 100.1, 99.9, 100), bar(100, 100.05, 98.5, 98.6), bar(98.6, 98.8, 98.2, 98.3)]);
  assert.deepEqual(fvgAt(down, 2, 0.5), { side: "short", top: 99.9, bottom: 98.8, i: 2 });
  // The neighbours overlap: no gap.
  assert.equal(fvgAt(series([bar(100, 100.1, 99.9, 100), bar(100, 101.5, 99.95, 101.4), bar(101.4, 101.8, 100.05, 101.7)]), 2, 0.5), null);
  // A gap, but the middle candle is smaller than the ATR asked for: drift, not displacement.
  assert.equal(fvgAt(up, 2, 2), null);
  assert.equal(fvgAt(up, 1, 0.5), null, "needs three candles");
});

test("zoneState and rejects: fresh until traded into, broken once a bar closes through", () => {
  const z: Zone = { side: "long", top: 101, bottom: 100, i: 0 };
  const c = series([bar(102, 102.5, 101.5, 102), bar(102, 102.4, 101.2, 102.2), bar(102.2, 102.3, 100.6, 101.8), bar(101.8, 101.9, 99.5, 100.4), bar(100.4, 100.5, 99.2, 99.6)]);
  assert.equal(zoneState(c, z, 1), "fresh");
  assert.equal(zoneState(c, z, 2), "tapped");
  assert.equal(zoneState(c, z, 3), "tapped", "a wick through the bottom that closes back inside does not break it");
  assert.equal(zoneState(c, z, 4), "broken");
  assert.equal(rejects(c, z, 1), false, "never reached the zone");
  assert.equal(rejects(c, z, 2), false, "reached it but closed red");
  const green = series([bar(102, 102.5, 101.5, 102), bar(101.2, 101.9, 100.6, 101.7)]);
  assert.equal(rejects(green, z, 1), true, "traded into the zone and closed green above its middle");
  const weak = series([bar(102, 102.5, 101.5, 102), bar(100.2, 100.5, 100.1, 100.4)]);
  assert.equal(rejects(weak, z, 1), false, "green, but closed in the lower half");
  // Short zone: the mirror.
  const zs: Zone = { side: "short", top: 101, bottom: 100, i: 0 };
  assert.equal(rejects(series([bar(99, 99.2, 98.8, 99), bar(99.8, 100.4, 99.2, 99.3)]), zs, 1), true);
});

test("orderBlockFor: the last candle against the move before the break, if the move is large enough", () => {
  const c = series([...quiet(4, 100), bar(100.2, 100.3, 99.7, 99.8), bar(99.8, 101.1, 99.75, 101), bar(101, 102.7, 100.9, 102.6)]);
  const brk = { i: 6, side: "long" as const, level: 102, pivot: { i: 0, price: 102, kind: "high" as const } };
  assert.deepEqual(orderBlockFor(c, brk, 0.5), { side: "long", top: 100.3, bottom: 99.7, i: 6 }, "the down candle at index 4");
  assert.equal(orderBlockFor(c, brk, 3), null, "a 2.9 move is under 1.5 × ATR 3");
  assert.equal(orderBlockFor(c, brk, 0.5, 1), null, "no down candle within one bar of the break");
});

// ───────── levels and patterns ─────────

test("levels: swings within the width are one level; a lone swing is not a level", () => {
  const p = (i: number, price: number, kind: "high" | "low" = "high") => ({ i, price, kind });
  const lv = levels([p(1, 100), p(9, 100.3, "low"), p(20, 100.1), p(30, 105), p(40, 110), p(50, 110.4)], 0.5);
  assert.deepEqual(lv.map((l) => [+l.price.toFixed(4), l.touches, l.last]), [[100.1333, 3, 20], [110.2, 2, 50]]);
  assert.deepEqual(levels([p(1, 100), p(2, 100.3)], 0.5, 3), [], "minTouches");
});

test("patterns: engulfing and pin bars, both directions", () => {
  const c = series([bar(100.5, 100.6, 99.9, 100), bar(99.9, 100.9, 99.8, 100.7), bar(100.7, 100.8, 100.6, 100.75), bar(100.9, 101, 100, 100.2)]);
  assert.equal(engulfing(c, 1), "long", "a green body covering the red body before it");
  assert.equal(engulfing(c, 2), null);
  assert.equal(engulfing(c, 3), "short");
  assert.equal(engulfing(c, 0), null);
  assert.equal(pinBar(series([bar(100, 100.1, 98.5, 99.95)]), 0), "long", "long lower wick");
  assert.equal(pinBar(series([bar(100, 101.5, 99.9, 100.05)]), 0), "short", "long upper wick");
  assert.equal(pinBar(series([bar(100, 100.5, 99.5, 100.2)]), 0), null);
  assert.equal(pinBar(series([bar(100, 100, 100, 100)]), 0), null, "no range");
});

// ───────── Fair Value Gap: the rule set ─────────

/** 260 rising bars (so the close is above EMA 200), a displacement that leaves a gap, two bars above it. */
function fvgSetup() {
  const up = drift(260, 100, 0.02); // ends at 105.2
  const a = bar(105.2, 105.3, 105.15, 105.22); // first candle: high 105.3
  const m = bar(105.22, 106.3, 105.2, 106.25); // displacement: body 1.03
  const b = bar(106.25, 106.5, 106.1, 106.4); // third candle: low 106.1 → gap 105.3 – 106.1
  const after = [bar(106.4, 106.7, 106.3, 106.6), bar(106.6, 106.8, 106.35, 106.5)]; // stay above the gap
  return { bars: [...up, a, m, b, ...after], top: 106.1, bottom: 105.3 };
}

test("fvg: the first retrace into the gap that closes green above its middle is a long", () => {
  const s = fvgSetup();
  const entryBar = bar(106.3, 106.45, 105.8, 106.35); // into the gap (low 105.8), green, close above the middle 105.7
  const c = series([...s.bars, entryBar]);
  const a = atr(c, 14)[c.length - 1]!;
  const g = sig(fvg.entry(c));
  assert.equal(g.side, "long");
  assert.ok(Math.abs(g.stop - (s.bottom - 0.25 * a)) < 1e-9, "stop below the gap by 0.25 ATR");
  assert.ok(Math.abs(g.takeProfit! - (106.35 + 2 * (106.35 - g.stop))) < 1e-9, "2R from the close");
  assert.equal(g.indicators.gapTop, s.top);
  assert.equal(g.indicators.gapBottom, s.bottom);
  assert.match(g.reason, /fair value gap/);
  // The bar before the retrace is not a signal: nothing has traded into the gap yet.
  assert.equal(fvg.entry(series(s.bars)), null);
});

test("fvg: no signal on a red retrace, a second visit, a gap that was closed through, or against EMA 200", () => {
  const s = fvgSetup();
  assert.equal(fvg.entry(series([...s.bars, bar(106.4, 106.45, 105.8, 105.9)])), null, "red bar");
  assert.equal(fvg.entry(series([...s.bars, bar(105.5, 105.65, 105.35, 105.6)])), null, "green, but closed in the lower half of the gap");
  const visited = [...s.bars, bar(106.5, 106.6, 105.9, 106.2), bar(106.2, 106.6, 106.15, 106.5)];
  assert.equal(fvg.entry(series([...visited, bar(106.3, 106.45, 105.8, 106.35)])), null, "the gap was already traded into");
  const closed = [...s.bars, bar(106.5, 106.6, 105.0, 105.1)];
  assert.equal(fvg.entry(series([...closed, bar(105.1, 106.5, 105.05, 106.4)])), null, "a bar closed below the gap: it is gone");
  // The same picture far below EMA 200: 260 falling bars, then a bullish gap. Longs against the trend are not taken.
  const down = drift(260, 120, -0.05); // ends at 107
  const counter = [...down, bar(107, 107.1, 106.95, 107.02), bar(107.02, 108.1, 107, 108.05), bar(108.05, 108.3, 107.9, 108.2), bar(108.2, 108.5, 108.1, 108.4), bar(108.1, 108.25, 107.6, 108.15)];
  assert.equal(fvg.entry(series(counter)), null, "close below EMA 200");
});

test("fvg: the bearish mirror is a short", () => {
  const down = drift(260, 120, -0.02); // ends at 114.8
  const c = series([...down, bar(114.8, 114.85, 114.7, 114.78), bar(114.78, 114.8, 113.7, 113.75), bar(113.75, 113.9, 113.5, 113.6), bar(113.6, 113.7, 113.3, 113.4), bar(113.7, 114.2, 113.55, 113.65)]);
  const g = sig(fvg.entry(c));
  assert.equal(g.side, "short");
  assert.ok(g.stop > 114.7, "stop above the gap (113.9 – 114.7)");
  assert.ok(g.takeProfit! < 113.65);
});

// ───────── Order Block: the rule set ─────────

/** A swing high at 102, the last down candle before the rally that closes above it, then two bars above the block. */
function obSetup() {
  const base = quiet(250, 100);
  const swing = [bar(100, 100.6, 99.95, 100.5), bar(100.5, 101.1, 100.4, 101), bar(101, 102, 100.9, 101.5), bar(101.5, 101.6, 100.9, 101), bar(101, 101.1, 100.4, 100.5), bar(100.5, 100.6, 100.1, 100.2)];
  const block = bar(100.2, 100.3, 99.7, 99.8); // the last down candle: zone 99.7 – 100.3
  const impulse = [bar(99.8, 101.1, 99.75, 101), bar(101, 102.7, 100.9, 102.6)]; // closes above the swing high 102
  const after = [bar(102.6, 102.7, 102.3, 102.4), bar(102.4, 102.5, 101.4, 101.5), bar(101.5, 101.6, 100.5, 100.6)];
  return { bars: [...base, ...swing, block, ...impulse, ...after], top: 100.3, bottom: 99.7 };
}

test("order_block: the first retest of the block that closes green above its middle is a long", () => {
  const s = obSetup();
  const c = series([...s.bars, bar(100.6, 101, 100.2, 100.9)]); // low 100.2 is inside the block
  const a = atr(c, 14)[c.length - 1]!;
  const g = sig(orderBlock.entry(c));
  assert.equal(g.side, "long");
  assert.ok(Math.abs(g.stop - (s.bottom - 0.25 * a)) < 1e-9, "stop below the block by 0.25 ATR");
  assert.ok(Math.abs(g.takeProfit! - (100.9 + 2 * (100.9 - g.stop))) < 1e-9, "2R from the close");
  assert.equal(g.indicators.blockTop, s.top);
  assert.equal(g.indicators.blockBottom, s.bottom);
  assert.equal(g.indicators.brokenSwing, 102);
  assert.match(g.reason, /order block/);
  assert.equal(orderBlock.entry(series(s.bars)), null, "price has not come back to the block yet");
});

test("order_block: no signal on a red retest, a second visit, or without a break of structure", () => {
  const s = obSetup();
  assert.equal(orderBlock.entry(series([...s.bars, bar(100.6, 100.7, 100.1, 100.15)])), null, "red bar");
  const visited = [...s.bars, bar(100.6, 100.8, 100.25, 100.5), bar(100.5, 101, 100.45, 100.9)];
  assert.equal(orderBlock.entry(series([...visited, bar(100.9, 101.2, 100.2, 101.1)])), null, "the block was already retested");
  // The same down candle and retest, but the rally stopped under the swing high: no break, no block.
  const noBreak = [...quiet(250, 100), bar(100, 100.6, 99.95, 100.5), bar(100.5, 101.1, 100.4, 101), bar(101, 102, 100.9, 101.5), bar(101.5, 101.6, 100.9, 101), bar(101, 101.1, 100.4, 100.5), bar(100.5, 100.6, 100.1, 100.2),
    bar(100.2, 100.3, 99.7, 99.8), bar(99.8, 101.1, 99.75, 101), bar(101, 101.9, 100.9, 101.8), bar(101.8, 101.9, 100.5, 100.6), bar(100.6, 101, 100.2, 100.9)];
  assert.equal(orderBlock.entry(series(noBreak)), null);
});

// ───────── Liquidity sweep (a candidate, not live) ─────────

test("liquidity_sweep: a wick under an untouched swing low that closes back above it is a long", () => {
  const base = [...quiet(60, 100), bar(100, 100.1, 99.5, 99.6), bar(99.6, 99.7, 99, 99.5), bar(99.5, 99.9, 99.4, 99.8), bar(99.8, 100.1, 99.7, 100), ...quiet(6, 100)];
  const c = series([...base, bar(99.9, 100, 98.8, 99.6)]);
  const g = sig(liquiditySweep.entry(c));
  assert.equal(g.side, "long");
  assert.equal(g.indicators.sweptLevel, 99);
  assert.ok(g.stop < 98.8, "stop under the wick");
  assert.equal(liquiditySweep.entry(series([...base, bar(99.9, 100, 98.8, 98.9)])), null, "closed below the swing: a breakdown, not a sweep");
  const swept = [...base, bar(99.9, 100, 98.9, 99.7), ...quiet(2, 99.8)];
  assert.equal(liquiditySweep.entry(series([...swept, bar(99.8, 99.9, 98.7, 99.5)])), null, "that low was already taken");
});

// ───────── every candidate ─────────

test("no rule set signals in a dead flat market", () => {
  const flat = series(Array.from({ length: 600 }, () => bar(100, 100, 100, 100)));
  const quietMarket = series(quiet(600, 100));
  for (const s of CANDIDATES) {
    assert.equal(s.entry(flat), null, `${s.key} on a flat line`);
    assert.equal(s.entry(quietMarket), null, `${s.key} on a quiet range`);
  }
});
