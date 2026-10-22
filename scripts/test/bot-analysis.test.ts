import { test } from "node:test";
import assert from "node:assert/strict";
import {
  entryFeatures,
  evaluateRule,
  lastClosedPeriod,
  mineLessons,
  rankSetups,
  reviewTrade,
  ruleBlocks,
  setupStats,
  simulateSignal,
  timing,
  type AnalysisTrade,
} from "../../supabase/functions/_shared/bot/analysis.ts";
import { TAKER_FEE } from "../../supabase/functions/_shared/bot/risk.ts";
import type { Candle, StrategyDef } from "../../supabase/functions/_shared/bot/types.ts";

const H = 3600_000;
const T0 = Date.UTC(2026, 0, 5); // a Monday

/** A closed long trade: entry 100, stop 99 (1R = 1), risk $1, so net PnL in $ equals R. */
function trade(i: number, r: number, o: Partial<AnalysisTrade> = {}): AnalysisTrade {
  const opened = T0 + i * 7 * H;
  return {
    id: `t${i}`,
    user_id: "u",
    account_id: "a",
    strategy: "ema_trend",
    timeframe: "1h",
    symbol: i % 2 ? "ETHUSDT" : "BTCUSDT",
    side: "long",
    qty: 1,
    entry_price: 100,
    initial_stop: 99,
    take_profit: 102,
    risk_usd: 1,
    opened_at: new Date(opened).toISOString(),
    closed_at: new Date(opened + 3 * H).toISOString(),
    exit_reason: r > 0 ? "take_profit" : "stop_loss",
    exit_price: 100 + r,
    exit_note: "Stop hit.",
    net_pnl: r,
    r_multiple: r,
    mfe_price: r > 0 ? 100 + r : 100.1,
    mae_price: r > 0 ? 99.8 : 99,
    entry_indicators: { close: 100, ema200: 98, atr14: 0.8, adx14: 30 },
    ...o,
  };
}

test("entry features are scale-free and signed by direction", () => {
  const at = Date.UTC(2026, 0, 10, 15); // Saturday, US session
  const long = entryFeatures({ side: "long", entry: 100, stop: 98, symbol: "BTCUSDT", at, indicators: { close: 100, atr14: 1, ema200: 95, plusDI: 30, minusDI: 20, adx14: 27 } });
  assert.equal(long.stopPct, 2);
  assert.equal(long.atrPct, 1);
  assert.equal(long.stopAtr, 2);
  assert.equal(long.diEdge, 10);
  assert.ok(Math.abs((long.trendDistPct as number) - 5.2632) < 1e-3);
  assert.equal(long.session, "us");
  assert.equal(long.weekend, "yes");
  const short = entryFeatures({ side: "short", entry: 100, stop: 102, symbol: "BTCUSDT", at, indicators: { close: 100, ema200: 95, plusDI: 30, minusDI: 20 } });
  assert.equal(short.diEdge, -10, "for a short, a +DI lead is against the trade");
  assert.ok((short.trendDistPct as number) < 0, "shorting above EMA 200 is against the trend");
  assert.equal(short.atrPct, undefined);
});

test("rules: lt / gte / eq, and a missing feature never blocks", () => {
  const f = { adx14: 18, side: "long" };
  assert.equal(ruleBlocks({ feature: "adx14", op: "lt", value: 20 }, f), true);
  assert.equal(ruleBlocks({ feature: "adx14", op: "gte", value: 20 }, f), false);
  assert.equal(ruleBlocks({ feature: "adx14", op: "gte", value: 18 }, f), true);
  assert.equal(ruleBlocks({ feature: "side", op: "eq", value: "long" }, f), true);
  assert.equal(ruleBlocks({ feature: "rsi", op: "lt", value: 99 }, f), false);
});

test("reviews say why a trade failed", () => {
  assert.equal(reviewTrade(trade(0, 2)).category, "target_hit");
  assert.equal(reviewTrade(trade(0, -1, { mfe_price: 101.4 })).category, "gave_back");
  assert.equal(reviewTrade(trade(0, -1, { mfe_price: 100.1 })).category, "no_follow_through");
  assert.equal(reviewTrade(trade(0, -1, { mfe_price: 100.6 })).category, "chop");
  assert.equal(reviewTrade(trade(0, -1, { exit_reason: "liquidation" })).category, "liquidated");
  assert.equal(reviewTrade(trade(0, -1.6, { exit_note: "Price opened below the stop. Filled at the open (slippage)." })).category, "gap_slippage");
  assert.equal(reviewTrade(trade(0, -0.4, { exit_reason: "time_exit", mfe_price: 100.5 })).category, "stale");
  assert.equal(reviewTrade(trade(0, 1, { exit_reason: "trailing_stop", mfe_price: 103.5 })).category, "left_on_table");
  assert.equal(reviewTrade(trade(0, 0.05, { exit_reason: "signal" })).category, "scratch");

  // After the stop, price went to +2.5R: right idea, stop too tight.
  const after: Candle[] = [{ time: 0, open: 99, high: 101, low: 98.8, close: 100.5, volume: 1 }, { time: 1, open: 100.5, high: 102.5, low: 100, close: 102, volume: 1 }];
  const rv = reviewTrade(trade(0, -1), after);
  assert.equal(rv.category, "stopped_then_ran");
  assert.equal(rv.afterExitR, 2.5);
  assert.equal(rv.afterExitBars, 2);
  assert.ok(rv.why.length > 20 && rv.fix.length > 20);

  // Context flags come from the entry's own readings.
  const weak = reviewTrade(trade(0, -1, { entry_indicators: { close: 100, ema200: 102, atr14: 2, adx14: 14 } }));
  assert.ok(weak.flags.some((f) => f.includes("ADX was 14")));
  assert.ok(weak.flags.some((f) => f.includes("against the EMA 200")));
  assert.ok(weak.flags.some((f) => f.includes("0.50 ATR")));
});

test("setup stats: verdicts need enough trades, a confident edge after slippage and shallow drawdowns", () => {
  const good = Array.from({ length: 40 }, (_, i) => trade(i * 3, i % 2 ? 2 : -1)); // spread over 5 weeks
  const s = setupStats({ strategy: "ema_trend", timeframe: "1h", startBalance: 100, busted: false, trades: good });
  assert.equal(s.trades, 40);
  assert.equal(s.winRate, 50);
  assert.ok(Math.abs(s.avgR! - 0.5) < 1e-9);
  assert.ok(Math.abs(s.avgRSlip! - 0.4) < 1e-3, "0.05% per side on ~$200 of notional is ~0.1R here");
  assert.ok(s.lcbR! > 0 && s.lcbR! < s.avgR!);
  assert.equal(s.profitFactor, 2);
  assert.equal(s.verdict, "live_ready");
  assert.ok(s.score >= 70);

  const few = setupStats({ strategy: "x", timeframe: "1h", startBalance: 100, busted: false, trades: good.slice(0, 6) });
  assert.equal(few.verdict, "needs_data");

  const bad = setupStats({ strategy: "y", timeframe: "1h", startBalance: 100, busted: false, trades: Array.from({ length: 30 }, (_, i) => trade(i, i % 3 ? -1 : 1.5)) });
  assert.equal(bad.verdict, "avoid");
  assert.ok(bad.score < s.score);

  // A lucky short streak can top "highest return" but not "best" or "effective".
  const lucky = setupStats({ strategy: "z", timeframe: "5m", startBalance: 100, busted: false, trades: Array.from({ length: 4 }, (_, i) => trade(i, 6)) });
  const r = rankSetups([s, few, bad, lucky]);
  assert.equal(r.highestReturn[0].strategy, "z");
  assert.equal(r.best[0].strategy, "ema_trend");
  assert.equal(r.effective[0].strategy, "ema_trend");
  assert.ok(!r.effective.some((x) => x.strategy === "z"), "under 10 trades isn't ranked for effectiveness");
});

test("learning finds the filter behind the losers, and only if it holds on newer trades", () => {
  // Low-ADX entries always lose; the rest win 60% at 2R.
  const list = Array.from({ length: 60 }, (_, i) => {
    const weak = i % 3 === 0;
    const r = weak ? -1 : i % 5 < 3 ? 2 : -1;
    return trade(i, r, { entry_indicators: { close: 100, ema200: 98, atr14: 0.8, adx14: weak ? 12 + (i % 5) : 24 + (i % 9) } });
  });
  const mined = mineLessons(list, new Set());
  const scoped = mined.find((m) => m.timeframe === "1h")!;
  assert.ok(scoped, "should learn a lesson for ema_trend 1h");
  assert.equal(scoped.rule.feature, "adx14");
  assert.equal(scoped.rule.op, "lt");
  assert.ok(+scoped.rule.value > 16 && +scoped.rule.value <= 26, `threshold ${scoped.rule.value}`);
  assert.ok(scoped.evidence.passed && scoped.evidence.test.blocked >= 3);
  assert.match(scoped.title, /skip entries when ADX/);
  // Already-learned rules aren't learned again.
  assert.equal(mineLessons(list, new Set(mined.map((m) => `${m.strategy}|${m.timeframe ?? "*"}|${m.rule.feature}|${m.rule.op}`))).filter((m) => m.rule.feature === "adx14").length, 0);

  // The same pattern only in the older trades: the newer trades refute it, so nothing is learned from it.
  const fading = list.map((t, i) => (i >= 42 && (t.entry_indicators.adx14 as number) < 20 ? { ...t, r_multiple: 2, net_pnl: 2, exit_price: 102 } : t));
  assert.equal(evaluateRule(fading, scoped.rule).passed, false);
  // Too few trades: nothing is learned at all.
  assert.equal(mineLessons(list.slice(0, 20), new Set()).length, 0);
});

test("simulateSignal replays a blocked signal with the strategy's own exits", () => {
  const noManage: StrategyDef = { key: "t", name: "t", version: 1, summary: "", rules: "", params: {}, warmup: 0, entry: () => null, manage: () => ({}) };
  const c = (i: number, o: number, h: number, l: number, cl: number): Candle => ({ time: i * 3600, open: o, high: h, low: l, close: cl, volume: 1 });
  const up = [c(0, 100, 100, 100, 100), c(1, 100, 101, 99.5, 100.8), c(2, 100.8, 102.2, 100.5, 102)];
  const won = simulateSignal(noManage, up, 0, { side: "long", entry: 100, stop: 99, takeProfit: 102 });
  assert.equal(won.reason, "take_profit");
  assert.equal(won.bars, 2);
  const risk = 1 + 100 * TAKER_FEE + 99 * TAKER_FEE;
  assert.ok(Math.abs(won.r - (2 - 100 * TAKER_FEE) / risk) < 1e-3);

  const lost = simulateSignal(noManage, [c(0, 100, 100, 100, 100), c(1, 100, 100.2, 98.5, 98.7)], 0, { side: "long", entry: 100, stop: 99, takeProfit: 102 });
  assert.equal(lost.reason, "stop_loss");
  assert.ok(lost.r < -0.99 && lost.r > -1.01);

  const pending = simulateSignal(noManage, [c(0, 100, 100, 100, 100), c(1, 100, 100.5, 99.5, 100.2)], 0, { side: "long", entry: 100, stop: 99, takeProfit: 102 });
  assert.equal(pending.done, false, "still open: wait for more bars");

  const exitAfter1: StrategyDef = { ...noManage, manage: (_c, t) => (t.barsHeld >= 1 ? { exit: { reason: "signal", note: "" } } : {}) };
  const sig = simulateSignal(exitAfter1, [...up.slice(0, 2), c(2, 100.6, 100.9, 100.4, 100.7)], 0, { side: "long", entry: 100, stop: 99, takeProfit: 105 });
  assert.equal(sig.reason, "signal");
  assert.equal(sig.bars, 2, "a signal exit fills at the next bar's open");
});

test("report periods: the last closed hour, day, week (Monday) and month in UTC", () => {
  const now = Date.UTC(2026, 9, 22, 13, 7); // Thursday 13:07
  const iso = (k: Parameters<typeof lastClosedPeriod>[0]) => lastClosedPeriod(k, now).map((x) => new Date(x).toISOString().slice(0, 16));
  assert.deepEqual(iso("hourly"), ["2026-10-22T12:00", "2026-10-22T13:00"]);
  assert.deepEqual(iso("daily"), ["2026-10-21T00:00", "2026-10-22T00:00"]);
  assert.deepEqual(iso("weekly"), ["2026-10-12T00:00", "2026-10-19T00:00"]);
  assert.deepEqual(iso("monthly"), ["2026-09-01T00:00", "2026-10-01T00:00"]);
});

test("timing groups results by entry hour, weekday and session", () => {
  const t = timing([trade(0, 2), trade(1, -1), trade(2, -1)]); // opened 00:00, 07:00, 14:00 Monday
  assert.deepEqual(t.byHour.map((x) => x.key), ["00", "07", "14"]);
  assert.deepEqual(t.bySession.map((x) => [x.key, x.sumR]), [["asia", 2], ["europe", -1], ["us", -1]]);
  assert.equal(t.byWeekday[0].key, "Mon");
  assert.equal(t.byWeekday[0].trades, 3);
});
