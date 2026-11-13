import { test } from "node:test";
import assert from "node:assert/strict";
import { lastClosedPeriod, rankSetups, reviewTrade, setupStats, timing, type AnalysisTrade } from "../../supabase/functions/_shared/bot/analysis.ts";
import { strategyRows } from "../../supabase/functions/_shared/bot/analyze.ts";
import { STRATEGIES } from "../../supabase/functions/_shared/bot/strategies.ts";
import type { Candle } from "../../supabase/functions/_shared/bot/types.ts";

const H = 3600_000;
const T0 = Date.UTC(2026, 0, 5); // a Monday

/** A closed long trade: entry 100, stop 99 (1R = 1), risk $1, so net PnL in $ equals R. */
function trade(i: number, r: number, o: Partial<AnalysisTrade> = {}): AnalysisTrade {
  const opened = T0 + i * 7 * H;
  return {
    id: `t${i}`,
    user_id: "u",
    account_id: "a",
    strategy: "fvg",
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

});

test("setup stats: verdicts need enough trades, a confident edge after slippage and shallow drawdowns", () => {
  const good = Array.from({ length: 40 }, (_, i) => trade(i * 3, i % 2 ? 2 : -1)); // spread over 5 weeks
  const s = setupStats({ strategy: "fvg", timeframe: "1h", startBalance: 100, busted: false, trades: good });
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
  assert.equal(r.best[0].strategy, "fvg");
  assert.equal(r.effective[0].strategy, "fvg");
  assert.ok(!r.effective.some((x) => x.strategy === "z"), "under 10 trades isn't ranked for effectiveness");
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

test("strategy rows: every live rule set over all its timeframes, best average R first", () => {
  const trades = [
    ...Array.from({ length: 6 }, (_, i) => trade(i, i % 2 ? 2 : -1, { strategy: "fvg", timeframe: i % 3 ? "1h" : "15m" })),
    ...Array.from({ length: 4 }, (_, i) => trade(10 + i, i === 0 ? 2 : -1, { strategy: "order_block", timeframe: "4h" })),
  ];
  const rows = strategyRows(trades);
  assert.equal(rows.length, STRATEGIES.length, "rule sets without trades are listed too");
  assert.deepEqual(rows.slice(0, 2).map((r) => [r.strategy, r.trades, r.wins, r.winRate, r.avgR, r.profitFactor]), [
    ["fvg", 6, 3, 50, 0.5, 2],
    ["order_block", 4, 1, 25, -0.25, 0.67],
  ]);
  assert.ok(rows.slice(2).every((r) => r.trades === 0 && r.avgR === null && r.winRate === null));
});
