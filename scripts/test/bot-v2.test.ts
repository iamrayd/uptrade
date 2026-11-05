// Strategy v2 (docs/strategies/V2-PLAN.md): retired setups, trailing-exit strategies,
// discipline per timeframe, maker entries and the backtester's cost model.

import { test } from "node:test";
import assert from "node:assert/strict";
import { cooldownUntil, disciplineFor, riskMultiplier, type RecentTrade } from "../../supabase/functions/_shared/bot/discipline.ts";
import { isRetired, probationTune } from "../../supabase/functions/_shared/bot/tuning.ts";
import { emaTrend, emaTrendV2, macdAdx, macdAdxV2, STRATEGIES, STRATEGY_BY_KEY } from "../../supabase/functions/_shared/bot/strategies.ts";
import { baseKey, confluence } from "../../supabase/functions/_shared/bot/confluence.ts";
import { limitFilled, makerTimeoutMs, MAKER_FEE, sizePosition, TAKER_FEE } from "../../supabase/functions/_shared/bot/risk.ts";
import { backtest } from "../../supabase/functions/_shared/bot/backtest.ts";
import type { Candle, StrategyDef } from "../../supabase/functions/_shared/bot/types.ts";
import { aggregate, syntheticMinutes } from "./helpers.ts";

const NOW = Date.UTC(2026, 10, 5);
const H = 3600_000;
const trade = (symbol: string, r: number, minsAgo: number): RecentTrade => ({ symbol, r, closed_at: new Date(NOW - minsAgo * 60_000).toISOString() });
const T0 = 1_700_000_000 - (1_700_000_000 % 86400);
const S = { riskPct: 0.02, maxLeverage: 20, slots: 3 };

// ───────── 1. retired setups ─────────

test("the persistent losers are retired: short timeframes for every strategy, plus the named higher-timeframe setups and their news twins", () => {
  for (const s of STRATEGIES.filter((x) => !x.pool)) for (const tf of ["5m", "15m", "30m"]) assert.equal(isRetired(s.key, tf), true, `${s.key} ${tf}`);
  assert.equal(isRetired("aggro", "15m"), false, "the aggressive accounts are outside the retired list: their playbook decides");
  for (const [k, tf] of [["ema_trend", "1h"], ["donchian", "1h"], ["supertrend", "1h"], ["macd_adx", "4h"], ["supertrend", "4h"]]) assert.equal(isRetired(k, tf), true, `${k} ${tf}`);
  assert.equal(isRetired("donchian_news", "1h"), true, "a news twin shares its original's trigger and exits");
  assert.equal(isRetired("supertrend_news", "4h"), true);
  for (const [k, tf] of [["donchian", "4h"], ["donchian", "1d"], ["supertrend", "1d"], ["macd_adx", "1h"], ["ema_trend", "4h"], ["bb_rsi", "1h"]]) assert.equal(isRetired(k, tf), false, `${k} ${tf}`);
  // The v2 strategies are new rule sets: only the short timeframes are closed to them.
  assert.equal(isRetired("ema_trend_v2", "1h"), false);
  assert.equal(isRetired("macd_adx_v2", "4h"), false);
  assert.equal(isRetired("ema_trend_v2", "15m"), true);
});

test("a retired setup is put on probation at once and no replay record promotes it", () => {
  const winners = Array.from({ length: 40 }, (_, i) => (i % 10 < 7 ? 2 : -1));
  const old = new Date(NOW - 10 * 86400_000).toISOString();
  const fresh = new Date(NOW - 86400_000).toISOString();
  assert.equal(probationTune({ probation: true, changedAt: old, replayRs: winners, verdict: "promising", now: NOW, retired: true }), null, "never promoted");
  assert.equal(probationTune({ probation: false, changedAt: fresh, replayRs: [], verdict: "promising", now: NOW, retired: true }), true, "the flip cooldown does not delay retirement");
  // Unchanged for everything else.
  assert.equal(probationTune({ probation: true, changedAt: old, replayRs: winners, verdict: "needs_data", now: NOW }), false);
});

// ───────── 2. trailing-exit strategies ─────────

/** Hourly bars from closes, with a fixed ±0.2% range. */
const bars = (closes: number[]): Candle[] =>
  closes.map((c, i) => ({ time: T0 + i * 3600, open: i ? closes[i - 1] : c, high: Math.max(c, i ? closes[i - 1] : c) * 1.002, low: Math.min(c, i ? closes[i - 1] : c) * 0.998, close: c, volume: 100 }));

test("the v2 strategies are registered under new keys and leave the originals untouched", () => {
  assert.equal(STRATEGY_BY_KEY.ema_trend_v2, emaTrendV2);
  assert.equal(STRATEGY_BY_KEY.macd_adx_v2, macdAdxV2);
  assert.equal(STRATEGY_BY_KEY.ema_trend, emaTrend);
  assert.equal(emaTrend.version, 1);
  assert.match(emaTrend.rules, /opposite EMA 9\/21 cross closes the trade/);
  assert.match(macdAdx.rules, /opposite MACD\/signal cross closes the trade/);
  assert.equal(new Set(STRATEGIES.map((s) => s.key)).size, STRATEGIES.length);
  assert.ok(!STRATEGIES.some((s) => /_v2_news$/.test(s.key)), "no news twin of a v2 strategy yet");
  // The confluence gate and the mistake tags read a v2 strategy as its original.
  assert.equal(baseKey("ema_trend_v2"), "ema_trend");
  assert.equal(baseKey("macd_adx_v2"), "macd_adx");
  assert.equal(baseKey("macd_adx_news"), "macd_adx");
});

test("v2 entries are the originals' triggers and stops, without the fixed 2R target", () => {
  for (const [v1, v2] of [[emaTrend, emaTrendV2], [macdAdx, macdAdxV2]] as [StrategyDef, StrategyDef][]) {
    const c = aggregate(syntheticMinutes(11, T0, 60 * 24 * 120, 100), 3600);
    let signals = 0;
    for (let i = v1.warmup; i < c.length; i++) {
      const hist = c.slice(Math.max(0, i + 1 - 600), i + 1);
      const a = v1.entry(hist);
      const b = v2.entry(hist);
      if (!a || "skip" in a) {
        assert.deepEqual(b, a, `${v2.key}: skips and no-signals match the original`);
        continue;
      }
      signals++;
      assert.ok(b && !("skip" in b));
      if (!b || "skip" in b) continue;
      assert.equal(b.side, a.side);
      assert.equal(b.stop, a.stop);
      assert.equal(b.takeProfit, null, `${v2.key}: no fixed target`);
      assert.ok(a.takeProfit != null);
      const cf1 = confluence({ strategy: v1.key, timeframe: "1h", side: a.side, candles: hist, entry: hist[hist.length - 1].close, stop: a.stop });
      const cf2 = confluence({ strategy: v2.key, timeframe: "1h", side: b.side, candles: hist, entry: hist[hist.length - 1].close, stop: b.stop });
      assert.equal(cf2.score, cf1.score, "same confluence reading as the original");
    }
    assert.ok(signals > 5, `${v2.key}: ${signals} signals`);
  }
});

test("v2 management trails a chandelier stop and never exits on the opposite cross", () => {
  // A long that runs up, then rolls over: v1 exits on the cross back, v2 only moves its stop.
  const up = Array.from({ length: 300 }, (_, i) => 100 * 1.002 ** i);
  const top = up[up.length - 1];
  const roll = Array.from({ length: 12 }, (_, i) => top * 0.994 ** (i + 1));
  const c = bars([...up, ...roll]);
  const entryPrice = up[260];
  const open = { side: "long" as const, entryPrice, stop: entryPrice * 0.97, takeProfit: null };
  let v1Exit = false;
  for (let n = 301; n <= c.length; n++) {
    const hist = c.slice(0, n);
    const view = { ...open, barsHeld: n - 261 };
    if (emaTrend.manage(hist, view).exit) v1Exit = true;
    for (const s of [emaTrendV2, macdAdxV2]) {
      const m = s.manage(hist, view);
      assert.equal(m.exit, undefined, `${s.key} must not exit on a signal`);
      assert.ok(m.stop != null && Number.isFinite(m.stop));
      // Chandelier: the highest high since entry minus trailAtr × ATR, so it sits below that high.
      const hh = Math.max(...hist.slice(-view.barsHeld).map((x) => x.high));
      assert.ok(m.stop! < hh);
      assert.ok(hh - m.stop! > 0 && (hh - m.stop!) / hh < 0.1);
    }
  }
  assert.ok(v1Exit, "the original would have closed on the opposite cross");
  // The stop follows the run: later in the trend it is higher (the engine only ever tightens).
  const early = emaTrendV2.manage(c.slice(0, 270), { ...open, barsHeld: 9 }).stop!;
  const late = emaTrendV2.manage(c.slice(0, 300), { ...open, barsHeld: 39 }).stop!;
  assert.ok(late > early);
  // Shorts mirror: the stop sits above the lowest low since entry.
  const down = bars(Array.from({ length: 300 }, (_, i) => 100 * 0.998 ** i));
  const ms = macdAdxV2.manage(down, { side: "short", entryPrice: down[260].close, stop: down[260].close * 1.03, takeProfit: null, barsHeld: 39 });
  assert.ok(ms.stop! > Math.min(...down.slice(-39).map((x) => x.low)));
  // Nothing to trail before the first bar after entry has closed.
  assert.deepEqual(emaTrendV2.manage(c.slice(0, 261), { ...open, barsHeld: 0 }), {});
});

// ───────── 3. discipline per timeframe ─────────

test("discipline per timeframe: off on 1d, shorter cooldowns on 4h, unchanged on 1h and below", () => {
  assert.deepEqual(disciplineFor("1h"), { cooldownBars: 3, streakCooldownBars: 6, riskCuts: true });
  assert.deepEqual(disciplineFor("15m"), disciplineFor("1h"));
  assert.deepEqual(disciplineFor(undefined), disciplineFor("1h"));
  assert.deepEqual(disciplineFor("4h"), { cooldownBars: 1, streakCooldownBars: 2, riskCuts: true });
  assert.deepEqual(disciplineFor("1d"), { cooldownBars: 0, streakCooldownBars: 0, riskCuts: false });

  const streak = [trade("BTCUSDT", -1, 300), trade("ETHUSDT", -1, 200), trade("SOLUSDT", -1, 100)];
  // 1d: no risk cut for a streak, a poor average or a deep drawdown.
  assert.deepEqual(riskMultiplier({ equity: 30, startBalance: 100, recent: streak, timeframe: "1d" }), { mult: 1, note: null });
  assert.equal(riskMultiplier({ equity: 30, startBalance: 100, recent: streak, timeframe: "4h" }).mult, 0.25);
  assert.equal(riskMultiplier({ equity: 100, startBalance: 100, recent: streak, timeframe: "1h" }).mult, 0.5);
  assert.equal(riskMultiplier({ equity: 100, startBalance: 100, recent: streak }).mult, 0.5, "no timeframe: the default rules");

  // Cooldowns: none on 1d; 1 bar per symbol and 2 bars after a streak on 4h.
  const lost = [trade("BTCUSDT", -1, 20)];
  assert.equal(cooldownUntil(lost, "BTCUSDT", 24 * H, "1d"), null);
  assert.equal(cooldownUntil(streak, "XRPUSDT", 24 * H, "1d"), null);
  assert.equal(cooldownUntil(lost, "BTCUSDT", 4 * H, "4h")!.until, NOW - 20 * 60_000 + 4 * H);
  assert.equal(cooldownUntil(streak, "XRPUSDT", 4 * H, "4h")!.until, NOW - 100 * 60_000 + 2 * 4 * H);
  assert.match(cooldownUntil(streak, "XRPUSDT", 4 * H, "4h")!.why, /wait 2 bars/);
  assert.equal(cooldownUntil(lost, "BTCUSDT", H, "1h")!.until, NOW - 20 * 60_000 + 3 * H);
  assert.equal(cooldownUntil(lost, "BTCUSDT", H)!.until, NOW - 20 * 60_000 + 3 * H);
});

// ───────── 4. maker entries ─────────

test("a maker entry is sized without an entry fee, so the same risk buys slightly more size", () => {
  const taker = sizePosition({ side: "long", entry: 100, stop: 98, equity: 100, freeBalance: 100, stepSize: 0.0001, settings: S });
  const maker = sizePosition({ side: "long", entry: 100, stop: 98, equity: 100, freeBalance: 100, stepSize: 0.0001, settings: S, entryFeeRate: MAKER_FEE });
  if ("skip" in taker || "skip" in maker) throw new Error("sizing skipped");
  assert.equal(maker.entryFee, 0);
  assert.ok(Math.abs(taker.entryFee - taker.notional * TAKER_FEE) < 1e-12);
  assert.ok(maker.qty > taker.qty);
  assert.ok(maker.riskUsd <= 2 + 1e-9 && maker.riskUsd > 1.99);
  // Risk at the stop: the price move plus the taker fee on the stop fill only.
  assert.ok(Math.abs(maker.riskUsd - maker.qty * (2 + 98 * TAKER_FEE)) < 1e-9);
});

test("a resting limit fills only when price trades through it, and it lapses after a timeout that scales with the bar", () => {
  const c = (low: number, high: number): Candle => ({ time: 0, open: 100, high, low, close: 100, volume: 1 });
  assert.equal(limitFilled("long", 100, c(99.9, 100.5)), true);
  assert.equal(limitFilled("long", 100, c(100, 100.5)), false, "a touch is not a fill: the order may still be queued");
  assert.equal(limitFilled("short", 100, c(99.5, 100.1)), true);
  assert.equal(limitFilled("short", 100, c(99.5, 100)), false);
  assert.equal(makerTimeoutMs("1h"), 15 * 60_000);
  assert.equal(makerTimeoutMs("4h"), 60 * 60_000);
  assert.equal(makerTimeoutMs("1d"), 60 * 60_000, "capped at an hour");
  assert.equal(makerTimeoutMs("5m"), 2 * 60_000, "at least two minutes");
});

// ───────── 5. backtester realism ─────────

const data = () =>
  Object.fromEntries(Object.entries({ AAAUSDT: 200, BBBUSDT: 30, CCCUSDT: 2 }).map(([s, p], k) => [s, aggregate(syntheticMinutes(100 + k, T0, 60 * 24 * 60, p), 3600)]));
const FILTERS = { AAAUSDT: { step: 0.001, tick: 0.01 }, BBBUSDT: { step: 0.01, tick: 0.001 }, CCCUSDT: { step: 0.1, tick: 0.0001 } };

test("the backtester reports dollars and R separately, and its books still balance with slippage", () => {
  const d = data();
  const from = d.AAAUSDT[400].time;
  for (const s of STRATEGIES.filter((x) => !x.newsAware)) {
    const base = backtest({ strategy: s, timeframe: "1h", candlesBySymbol: d, filters: FILTERS, settings: S, startBalance: 100, from });
    const slip = backtest({ strategy: s, timeframe: "1h", candlesBySymbol: d, filters: FILTERS, settings: S, startBalance: 100, from, slippage: 0.0005 });
    for (const r of [base, slip]) {
      const sum = r.tradeList.reduce((x, t) => x + t.net, 0);
      assert.ok(Math.abs(r.finalEquity - (100 + sum)) < 1e-6, `${s.key}: books`);
      assert.ok(Math.abs(r.netUsd - sum) < 1e-6);
      assert.ok(Math.abs(r.totalR - r.tradeList.reduce((x, t) => x + t.r, 0)) < 1e-9);
      if (r.trades) assert.ok(Math.abs(r.avgR! - r.totalR / r.trades) < 1e-12);
    }
    assert.equal(base.slippage, 0);
    assert.equal(slip.slippage, 0.0005);
    if (!base.trades) continue;
    // Slippage moves taker fills against the trade: entries are never better than the open they fill on.
    for (const t of slip.tradeList) {
      const bar = d[t.symbol].find((c) => c.time === t.entryTime)!;
      assert.ok(t.side === "long" ? t.entry >= bar.open : t.entry <= bar.open, `${s.key}: entry slipped the wrong way`);
    }
    const first = slip.tradeList[0];
    const bar = d[first.symbol].find((c) => c.time === first.entryTime)!;
    assert.ok(Math.abs(first.entry / bar.open - (first.side === "long" ? 1.0005 : 0.9995)) < 1e-9, "the entry fills 0.05% past the open");
    assert.ok(slip.totalR < base.totalR, `${s.key}: slippage must cost R (${slip.totalR} vs ${base.totalR})`);
  }
});

test("maker entries in the backtester: a limit at the signal close, no entry fee and no entry slippage", () => {
  const d = data();
  const from = d.AAAUSDT[400].time;
  let makerTrades = 0;
  for (const s of STRATEGIES.filter((x) => !x.newsAware)) {
    const taker = backtest({ strategy: s, timeframe: "1h", candlesBySymbol: d, filters: FILTERS, settings: S, startBalance: 100, from, slippage: 0.0005 });
    const maker = backtest({ strategy: s, timeframe: "1h", candlesBySymbol: d, filters: FILTERS, settings: S, startBalance: 100, from, slippage: 0.0005, makerEntry: true });
    const sum = maker.tradeList.reduce((x, t) => x + t.net, 0);
    assert.ok(Math.abs(maker.finalEquity - (100 + sum)) < 1e-6, `${s.key}: books`);
    makerTrades += maker.trades;
    assert.equal(taker.unfilledEntries, 0);
    for (const t of maker.tradeList) {
      const i = d[t.symbol].findIndex((c) => c.time === t.entryTime);
      const signal = d[t.symbol][i - 1];
      const bar = d[t.symbol][i];
      assert.equal(t.entry, signal.close, `${s.key}: the limit sits at the signal bar's close, with no slippage`);
      assert.ok(t.side === "long" ? bar.low < t.entry : bar.high > t.entry, `${s.key}: filled without price trading through the limit`);
      assert.equal(t.entryFee, 0);
    }
    for (const t of taker.tradeList) assert.ok(Math.abs(t.entryFee - t.qty * t.entry * TAKER_FEE) < 1e-9);
  }
  assert.ok(makerTrades > 20, `${makerTrades} maker trades`);
});

test("a maker entry that price never trades through is not a trade; with finer candles it must fill inside the timeout", () => {
  // One long signal on the bar that closes at 100 (index 2). Stop 95, no target.
  const stub: StrategyDef = {
    key: "stub", name: "stub", version: 1, summary: "", rules: "", params: {}, warmup: 1,
    entry: (c) => (c.length === 3 ? { side: "long", stop: 95, takeProfit: null, reason: "test", indicators: {} } : null),
    manage: () => ({}),
  };
  const bar = (i: number, o: number, h: number, l: number, cl: number): Candle => ({ time: T0 + i * 3600, open: o, high: h, low: l, close: cl, volume: 1 });
  const run = (next: Candle, makerEntry: Parameters<typeof backtest>[0]["makerEntry"]) =>
    backtest({
      strategy: stub, timeframe: "1h", filters: { XUSDT: { step: 0.001, tick: 0.01 } }, settings: S, startBalance: 100, from: T0, makerEntry,
      candlesBySymbol: { XUSDT: [bar(0, 100, 101, 99, 100), bar(1, 100, 101, 99, 100), bar(2, 100, 101, 99, 100), next, bar(4, 103, 104, 102, 103)] },
    });
  // Price runs away: the low only touches the limit, so the order is never filled.
  const away = run(bar(3, 100, 104, 100, 103), true);
  assert.equal(away.trades, 0);
  assert.equal(away.unfilledEntries, 1);
  // The same bars with a market entry do trade (at the next open).
  assert.equal(run(bar(3, 100, 104, 100, 103), false).trades, 1);
  // Price dips through the limit: filled at 100, the signal close.
  const dip = run(bar(3, 100.5, 104, 99.5, 103), true);
  assert.equal(dip.trades, 1);
  assert.equal(dip.unfilledEntries, 0);
  assert.equal(dip.tradeList[0].entry, 100);
  assert.equal(dip.tradeList[0].entryFee, 0);
  // Finer candles: the dip comes in the 3rd five-minute candle. A 10-minute timeout misses it, a 15-minute one catches it.
  const five = (k: number, l: number): Candle => ({ time: T0 + 3 * 3600 + k * 300, open: 100.5, high: 101, low: l, close: 100.5, volume: 1 });
  const fine = { XUSDT: [five(0, 100.2), five(1, 100.1), five(2, 99.5), five(3, 100.2)] };
  const late = run(bar(3, 100.5, 104, 99.5, 103), { candles: fine, timeoutSec: 600 });
  assert.equal(late.trades, 0);
  assert.equal(late.unfilledEntries, 1);
  assert.equal(run(bar(3, 100.5, 104, 99.5, 103), { candles: fine, timeoutSec: 900 }).trades, 1);
  // The live bot places the order a little after the close and cannot count the minute it was placed in:
  // with `delaySec`, fine candles that start before close + delay do not fill. Here the only dip is in the first candle.
  const early = { XUSDT: [five(0, 99.5), five(1, 100.2), five(2, 100.2)] };
  assert.equal(run(bar(3, 100.5, 104, 99.5, 103), { candles: early, timeoutSec: 900 }).trades, 1);
  const delayed = run(bar(3, 100.5, 104, 99.5, 103), { candles: early, timeoutSec: 900, delaySec: 60 });
  assert.equal(delayed.trades, 0);
  assert.equal(delayed.unfilledEntries, 1);
});

test("the backtester's discipline follows the timeframe: none of it on 1d", () => {
  // The same bars labelled 1h and 1d: only the discipline rules differ between the two runs.
  const d = data();
  const from = d.AAAUSDT[400].time;
  const s = STRATEGY_BY_KEY.ema_trend;
  const run = (timeframe: string, discipline: boolean) => backtest({ strategy: s, timeframe, candlesBySymbol: d, filters: FILTERS, settings: S, startBalance: 100, from, discipline });
  assert.ok(run("1h", false).trades > 20);
  assert.notEqual(run("1h", true).trades, run("1h", false).trades, "on 1h the cooldown skips entries");
  assert.equal(run("1d", true).trades, run("1d", false).trades);
  assert.equal(run("1d", true).finalEquity, run("1d", false).finalEquity);
});
