import { test } from "node:test";
import assert from "node:assert/strict";
import * as appInd from "../../src/lib/indicators.ts";
import * as ind from "../../supabase/functions/_shared/bot/indicators.ts";
import { checkExit, closeMath, liqPrice, roundStop, sizePosition, tighterStop, toTick, TAKER_FEE, LIQ_BUFFER } from "../../supabase/functions/_shared/bot/risk.ts";
import { STRATEGIES } from "../../supabase/functions/_shared/bot/strategies.ts";
import { backtest } from "../../supabase/functions/_shared/bot/backtest.ts";
import type { Candle } from "../../supabase/functions/_shared/bot/types.ts";
import { aggregate, syntheticMinutes } from "./helpers.ts";

const close = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b));
const S = { riskPct: 0.02, maxLeverage: 20, slots: 3 };
const T0 = 1_700_000_000 - (1_700_000_000 % 86400);
const bars = (n: number, f: (i: number) => number): Candle[] =>
  Array.from({ length: n }, (_, i) => {
    const c = f(i);
    return { time: T0 + i * 3600, open: f(i - 1 < 0 ? 0 : i - 1), high: c * 1.002, low: c * 0.998, close: c, volume: 100 };
  });

// ───────── indicators ─────────

test("bot indicators match the app's chart indicators exactly", () => {
  const cl = syntheticMinutes(7, T0, 800, 100).map((c) => c.close);
  const same = (a: (number | null)[], b: (number | null)[]) => {
    assert.equal(a.length, b.length);
    a.forEach((v, i) => assert.ok(v === b[i] || (v != null && b[i] != null && close(v, b[i]!)), `index ${i}: ${v} vs ${b[i]}`));
  };
  same(ind.sma(cl, 20), appInd.sma(cl, 20));
  same(ind.ema(cl, 200), appInd.ema(cl, 200));
  same(ind.rsi(cl, 14), appInd.rsi(cl, 14));
  const b1 = ind.bollinger(cl, 20, 2), b2 = appInd.bollinger(cl, 20, 2);
  same(b1.upper, b2.upper);
  same(b1.lower, b2.lower);
  const m1 = ind.macd(cl, 12, 26, 9), m2 = appInd.macd(cl, 12, 26, 9);
  same(m1.line, m2.line);
  same(m1.signal, m2.signal);
});

test("ATR is Wilder's RMA of true range, seeded with an SMA", () => {
  const c: Candle[] = [
    { time: 0, open: 10, high: 11, low: 9, close: 10, volume: 1 }, // TR 2
    { time: 1, open: 10, high: 12, low: 10, close: 11, volume: 1 }, // TR 2
    { time: 2, open: 11, high: 11, low: 8, close: 9, volume: 1 }, // TR 3
    { time: 3, open: 9, high: 13, low: 9, close: 12, volume: 1 }, // TR max(4, 4, 0) = 4
  ];
  const a = ind.atr(c, 3);
  assert.equal(a[1], null);
  assert.ok(close(a[2]!, 7 / 3));
  assert.ok(close(a[3]!, (7 / 3 * 2 + 4) / 3));
});

test("DMI/ADX and Supertrend read a steady uptrend as an uptrend", () => {
  const up = bars(300, (i) => 100 * 1.003 ** i);
  const d = ind.dmi(up, 14);
  assert.ok(d.plusDI[299]! > d.minusDI[299]!);
  assert.ok(d.adx[299]! > 25);
  const st = ind.supertrend(up, 3, 10);
  assert.equal(st.dir[299], 1);
  assert.ok(st.line[299]! < up[299].close);
  const down = bars(300, (i) => 100 * 0.997 ** i);
  const st2 = ind.supertrend(down, 3, 10);
  assert.equal(st2.dir[299], -1);
  assert.ok(st2.line[299]! > down[299].close);
});

// ───────── risk ─────────

test("sizing risks 2% of equity (fees included) with the lowest leverage that fits", () => {
  const s = sizePosition({ side: "long", entry: 100, stop: 98, equity: 100, freeBalance: 100, stepSize: 0.001, settings: S });
  assert.ok(!("skip" in s));
  if ("skip" in s) return;
  assert.ok(s.riskUsd <= 2 + 1e-9 && s.riskUsd > 1.99, `risk ${s.riskUsd}`);
  assert.equal(s.leverage, 3); // ~$98 notional into a $33.33 budget
  assert.ok(s.margin + s.entryFee <= 100 / 3 + 1e-9);
  assert.ok(s.liqPrice < 98 - 2 * (LIQ_BUFFER - 1), "liquidation sits beyond the stop with buffer");
});

test("tight stops use more leverage but never above the cap; wide stops get capped for liquidation safety", () => {
  const tight = sizePosition({ side: "short", entry: 100, stop: 100.3, equity: 100, freeBalance: 100, stepSize: 0.001, settings: S });
  if ("skip" in tight) throw new Error(tight.skip);
  assert.ok(tight.leverage <= 20);
  assert.ok(tight.margin + tight.entryFee <= 100 / 3 + 1e-9);
  assert.ok(tight.liqPrice > 100.3);
  assert.ok(tight.riskPctActual <= 0.02 + 1e-12);

  const wide = sizePosition({ side: "long", entry: 100, stop: 90, equity: 100, freeBalance: 100, stepSize: 0.001, settings: S });
  if ("skip" in wide) throw new Error(wide.skip);
  const liqDist = (100 - wide.liqPrice) / 100;
  assert.ok(liqDist >= 0.1 * LIQ_BUFFER - 1e-9, `liq ${wide.liqPrice}`);
});

test("when the margin budget can't carry 2% risk, size shrinks (never leverage above the cap)", () => {
  const s = sizePosition({ side: "long", entry: 100, stop: 99.8, equity: 100, freeBalance: 100, stepSize: 0.001, settings: { ...S, maxLeverage: 5 } });
  if ("skip" in s) throw new Error(s.skip);
  assert.equal(s.leverage, 5);
  assert.ok(s.riskPctActual < 0.02);
  assert.ok(s.notes.some((n) => n.includes("Size cut")));
  assert.ok(s.margin + s.entryFee <= 100 / 3 + 1e-9);
});

test("sizing refuses bad stops, too-tight stops and dust", () => {
  assert.ok("skip" in sizePosition({ side: "long", entry: 100, stop: 101, equity: 100, freeBalance: 100, stepSize: 0.001, settings: S }));
  assert.ok("skip" in sizePosition({ side: "long", entry: 100, stop: 99.95, equity: 100, freeBalance: 100, stepSize: 0.001, settings: S }));
  assert.ok("skip" in sizePosition({ side: "long", entry: 100, stop: 98, equity: 100, freeBalance: 0.2, stepSize: 0.001, settings: S }));
  assert.ok("skip" in sizePosition({ side: "long", entry: 100000, stop: 98000, equity: 100, freeBalance: 100, stepSize: 0.01, settings: S }));
});

test("liqPrice matches the database formula", () => {
  assert.ok(close(liqPrice("long", 100, 1, 10), (100 - 10) / 0.995));
  assert.ok(close(liqPrice("short", 100, 1, 10), (100 + 10) / 1.005));
  assert.equal(liqPrice("long", 100, 1, 100), 0);
});

test("checkExit: gaps, stop-first on ambiguous bars, maker targets", () => {
  const L = { side: "long" as const, stop: 95, takeProfit: 110, liqPrice: 80, trailed: false };
  const c = (o: number, h: number, l: number, cl: number): Candle => ({ time: 0, open: o, high: h, low: l, close: cl, volume: 1 });
  assert.equal(checkExit(L, c(100, 105, 96, 101)), null);
  assert.deepEqual(checkExit(L, c(100, 111, 94, 101))?.reason, "stop_loss"); // both touched → stop
  assert.equal(checkExit(L, c(100, 111, 94, 101))?.price, 95);
  assert.equal(checkExit(L, c(93, 94, 92, 93))?.price, 93); // gap below stop → fills at open
  assert.equal(checkExit(L, c(79, 81, 70, 75))?.reason, "liquidation");
  const tp = checkExit(L, c(100, 112, 99, 111));
  assert.equal(tp?.reason, "take_profit");
  assert.equal(tp?.feeRate, 0);
  assert.equal(checkExit({ ...L, trailed: true }, c(100, 101, 94, 95))?.reason, "trailing_stop");
  const Sh = { side: "short" as const, stop: 105, takeProfit: 90, liqPrice: 120, trailed: false };
  assert.equal(checkExit(Sh, c(100, 106, 89, 100))?.reason, "stop_loss");
  assert.equal(checkExit(Sh, c(100, 101, 89, 95))?.price, 90);
});

test("closeMath caps losses at the margin and liquidation forfeits it all", () => {
  const n = closeMath({ side: "long", entry: 100, exit: 102, qty: 1, margin: 10, feeRate: TAKER_FEE, liquidation: false });
  assert.ok(close(n.pnl, 2) && close(n.fee, 102 * TAKER_FEE));
  const capped = closeMath({ side: "long", entry: 100, exit: 80, qty: 1, margin: 10, feeRate: TAKER_FEE, liquidation: false });
  assert.equal(capped.pnl, -10);
  assert.equal(capped.fee, 0);
  const liq = closeMath({ side: "short", entry: 100, exit: 109.45, qty: 1, margin: 10, feeRate: 0, liquidation: true });
  assert.ok(close(10 + liq.pnl - liq.fee, 0), "margin + pnl - fee = 0: whole margin lost");
});

test("tighterStop only moves stops in the trade's favour", () => {
  assert.equal(tighterStop("long", 95, 96), 96);
  assert.equal(tighterStop("long", 95, 94), null);
  assert.equal(tighterStop("short", 105, 104), 104);
  assert.equal(tighterStop("short", 105, 106), null);
  assert.equal(tighterStop("long", 95, undefined), null);
  assert.equal(tighterStop("long", 26837.309, 26837.309 + 1e-11), null, "storage rounding noise is not a stop move");
});

test("prices snap to the exchange tick; stops round away from price", () => {
  assert.equal(roundStop("long", 74.30789, 0.01), 74.3);
  assert.equal(roundStop("short", 74.30189, 0.01), 74.31);
  assert.equal(roundStop("long", 74.3, 0.01), 74.3);
  assert.equal(toTick(3996.1162129887, 0.01, "nearest"), 3996.12);
  assert.equal(toTick(0.000012345, 0.00000001, "down"), 0.00001234);
});

// ───────── strategies ─────────

test("every strategy emits well-formed signals on synthetic markets", () => {
  for (const tfSec of [300, 3600]) {
    const c = aggregate(syntheticMinutes(11, T0, tfSec === 300 ? 60 * 24 * 12 : 60 * 24 * 80, 100), tfSec);
    for (const s of STRATEGIES) {
      let signals = 0;
      let skips = 0;
      for (let i = s.warmup; i < c.length; i++) {
        const hist = c.slice(Math.max(0, i + 1 - 600), i + 1);
        const sig = s.entry(hist);
        if (!sig) continue;
        if ("skip" in sig) {
          assert.ok(sig.skip.length > 10);
          skips++;
          continue;
        }
        signals++;
        const px = hist[hist.length - 1].close;
        assert.ok(sig.side === "long" ? sig.stop < px : sig.stop > px, `${s.key}: stop on wrong side`);
        if (sig.takeProfit != null) assert.ok(sig.side === "long" ? sig.takeProfit > px : sig.takeProfit < px, `${s.key}: target on wrong side`);
        assert.ok(sig.reason.length > 30);
        for (const v of Object.values(sig.indicators)) assert.ok(Number.isFinite(v), `${s.key}: non-finite indicator`);
        // manage() must also behave on the same history
        const m = s.manage(hist, { side: sig.side, entryPrice: px, stop: sig.stop, takeProfit: sig.takeProfit, barsHeld: 1 });
        if (m.stop != null) assert.ok(Number.isFinite(m.stop));
      }
      assert.ok(signals + skips > 0, `${s.key} never signalled on ${tfSec}s bars`);
    }
  }
});

// ───────── backtest ─────────

test("backtest accounting balances: final equity = start + sum of trade net PnL", () => {
  const syms = { AAAUSDT: 200, BBBUSDT: 30, CCCUSDT: 2 };
  const data = Object.fromEntries(
    Object.entries(syms).map(([s, p], k) => [s, aggregate(syntheticMinutes(100 + k, T0, 60 * 24 * 30, p), 900)]),
  );
  const from = data.AAAUSDT[400].time;
  for (const s of STRATEGIES) {
    const r = backtest({ strategy: s, timeframe: "15m", candlesBySymbol: data, filters: { AAAUSDT: { step: 0.001, tick: 0.01 }, BBBUSDT: { step: 0.01, tick: 0.001 }, CCCUSDT: { step: 0.1, tick: 0.0001 } }, settings: S, startBalance: 100, from });
    const sum = r.tradeList.reduce((x, t) => x + t.net, 0);
    assert.ok(close(r.finalEquity, 100 + sum, 1e-9), `${s.key}: ${r.finalEquity} vs ${100 + sum}`);
    assert.ok(r.finalEquity >= 0);
    for (const t of r.tradeList) {
      // A stop can gap, but a loss can never exceed the margin + fees (isolated).
      assert.ok(t.r > -5, `${s.key}: ${t.r}R loss`);
      assert.ok(t.entryTime >= from);
    }
  }
});
