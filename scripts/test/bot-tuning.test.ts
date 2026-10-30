// Unit tests for the per-setup tuning added by the strategy-improvement plan (PLAN.md):
// probation promotion/demotion, the per-setup confluence-threshold sweep, the learned
// breakeven stop (including its simulateSignal variant), and conviction-weighted sizing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { breakevenTune, convictionTune, inCooldown, probationTune, profitFactor, sweepConfluence, TUNE, type SweepEntry } from "../../supabase/functions/_shared/bot/tuning.ts";
import { convictionMult, CONVICTION } from "../../supabase/functions/_shared/bot/discipline.ts";
import { breakevenStop, reachedR, TAKER_FEE } from "../../supabase/functions/_shared/bot/risk.ts";
import { entryFeatures, mistakeTags, simulateSignal } from "../../supabase/functions/_shared/bot/analysis.ts";
import { confluence } from "../../supabase/functions/_shared/bot/confluence.ts";
import { STRATEGY_BY_KEY } from "../../supabase/functions/_shared/bot/strategies.ts";
import type { Candle } from "../../supabase/functions/_shared/bot/types.ts";
import { syntheticMinutes, aggregate } from "./helpers.ts";

const NOW = Date.UTC(2026, 9, 30);
const daysAgo = (d: number) => new Date(NOW - d * 86400_000).toISOString();

// ───────────────────────── Probation ─────────────────────────

test("probation clears only when 30+ replays show PF > 1.1, and 'avoid' re-enters it", () => {
  const winners = Array.from({ length: 30 }, (_, i) => (i % 2 ? 1 : -0.5)); // PF 2
  const losers = Array.from({ length: 30 }, (_, i) => (i % 2 ? 0.5 : -1)); // PF 0.5
  assert.ok(profitFactor(winners)! > TUNE.promotePf);
  // Promoted on a proven edge.
  assert.equal(probationTune({ probation: true, changedAt: daysAgo(10), replayRs: winners, verdict: "needs_data", now: NOW }), false);
  // Not promoted without an edge or without enough replays.
  assert.equal(probationTune({ probation: true, changedAt: daysAgo(10), replayRs: losers, verdict: "needs_data", now: NOW }), null);
  assert.equal(probationTune({ probation: true, changedAt: daysAgo(10), replayRs: winners.slice(0, 10), verdict: "needs_data", now: NOW }), null);
  // A live setup whose verdict turns "avoid" goes back on probation.
  assert.equal(probationTune({ probation: false, changedAt: daysAgo(10), replayRs: [], verdict: "avoid", now: NOW }), true);
  assert.equal(probationTune({ probation: false, changedAt: daysAgo(10), replayRs: [], verdict: "promising", now: NOW }), null);
  // Hysteresis: no flip within 7 days of the last one.
  assert.ok(inCooldown(daysAgo(2), NOW));
  assert.equal(probationTune({ probation: true, changedAt: daysAgo(2), replayRs: winners, verdict: "needs_data", now: NOW }), null);
});

// ───────────────────────── Confluence-threshold sweep ─────────────────────────

function sweepEntries(n: number, rAt: (confluence: number, half: 0 | 1) => number): SweepEntry[] {
  const out: SweepEntry[] = [];
  for (let i = 0; i < n; i++) {
    const confluence = 65 + (i % 8) * 5; // 65..100, uniform
    out.push({ confluence, r: rAt(confluence, i < n / 2 ? 0 : 1), t: NOW - (n - i) * 3600_000 });
  }
  return out;
}

test("the threshold sweep adopts a higher bar only when both halves improve, within the skip-room rule", () => {
  // High-confluence entries do better in both halves: 80 should be adopted.
  const good = sweepEntries(80, (c) => (c >= 80 ? 0.2 : -0.2));
  assert.equal(sweepConfluence({ entries: good, current: null, changedAt: null, now: NOW }), 80);
  // Improvement in one half only: no change.
  const flip = sweepEntries(80, (c, half) => (half === 0 ? (c >= 80 ? 0.2 : -0.2) : c >= 80 ? -0.2 : 0.2));
  assert.equal(sweepConfluence({ entries: flip, current: null, changedAt: null, now: NOW }), null);
  // Too few entries: no change.
  assert.equal(sweepConfluence({ entries: good.slice(0, 20), current: null, changedAt: null, now: NOW }), null);
  // Already at 80: nothing higher to adopt (cap).
  assert.equal(sweepConfluence({ entries: good, current: 80, changedAt: daysAgo(10), now: NOW }), null);
  // Hysteresis.
  assert.equal(sweepConfluence({ entries: good, current: null, changedAt: daysAgo(1), now: NOW }), null);
  // The skip-room rule: when almost every entry sits below the candidate, it may not be adopted.
  const skewed: SweepEntry[] = [
    ...Array.from({ length: 70 }, (_, i) => ({ confluence: 65, r: -0.2, t: NOW - (200 - i) * 3600_000 })),
    ...Array.from({ length: 30 }, (_, i) => ({ confluence: 85, r: 0.3, t: NOW - (100 - i) * 3600_000 })),
  ];
  assert.ok((100 - 30) / 100 > TUNE.maxSkipShare);
  assert.equal(sweepConfluence({ entries: skewed, current: null, changedAt: null, now: NOW }), null);
});

// ───────────────────────── Breakeven stop ─────────────────────────

test("breakevenStop covers both fees and reachedR measures the initial stop distance", () => {
  assert.equal(breakevenStop("long", 100), 100 * (1 + 2 * TAKER_FEE));
  assert.equal(breakevenStop("short", 100), 100 * (1 - 2 * TAKER_FEE));
  assert.equal(reachedR("long", 100, 99, 101), true); // +1R exactly
  assert.equal(reachedR("long", 100, 99, 100.9), false);
  assert.equal(reachedR("short", 100, 101, 99), true);
  assert.equal(reachedR("long", 100, 99, null), false);
  assert.equal(reachedR("long", 100, 100, 105), false); // zero risk distance
});

test("the breakeven rule switches on when it reliably saves R and retires when it stops helping", () => {
  const saves = Array.from({ length: 40 }, (_, i) => ({ base: -1, be: i % 2 ? -0.8 : -0.7 })); // every pair saves ≥ 0.2R
  assert.equal(breakevenTune({ breakeven: false, changedAt: null, pairs: saves, now: NOW }), true);
  // Not enough pairs, or too little saved: no change.
  assert.equal(breakevenTune({ breakeven: false, changedAt: null, pairs: saves.slice(0, 10), now: NOW }), null);
  const noisy = Array.from({ length: 40 }, (_, i) => ({ base: 0, be: i % 2 ? 0.5 : -0.5 }));
  assert.equal(breakevenTune({ breakeven: false, changedAt: null, pairs: noisy, now: NOW }), null);
  // Active but its latest window costs money: retired.
  const hurts = Array.from({ length: 40 }, () => ({ base: 0.5, be: 0.2 }));
  assert.equal(breakevenTune({ breakeven: true, changedAt: daysAgo(10), pairs: hurts, now: NOW }), false);
  // Hysteresis.
  assert.equal(breakevenTune({ breakeven: false, changedAt: daysAgo(1), pairs: saves, now: NOW }), null);
});

test("simulateSignal's breakeven variant turns a winner-turned-loser into roughly a scratch", () => {
  // Price marches to +2R, then collapses through the original stop.
  const entry = 100;
  const stop = 98;
  const candles: Candle[] = [];
  const path = [100, 101, 102, 103, 104, 103, 102, 101, 100.2, 99, 98, 97, 96, 95];
  for (const [i, p] of path.entries())
    candles.push({ time: 1000 + i * 3600, open: p, high: p + 0.4, low: p - 0.4, close: p, volume: 100 });
  // A strategy whose manage() does nothing, so only the breakeven rule moves the stop.
  const idle = { ...STRATEGY_BY_KEY.ema_trend, manage: () => ({}) };
  const base = simulateSignal(idle, candles, 0, { side: "long", entry, stop, takeProfit: null }, 200);
  const be = simulateSignal(idle, candles, 0, { side: "long", entry, stop, takeProfit: null }, 200, true);
  assert.ok(base.done && be.done);
  assert.ok(base.r < -0.9, `baseline should ride to the stop (got ${base.r})`);
  assert.ok(be.r > -0.2, `breakeven variant should exit near scratch (got ${be.r})`);
  assert.ok(be.r > base.r);
});

// ───────────────────────── Conviction sizing ─────────────────────────

test("convictionMult raises size only for high confluence on a rated setup and cuts weak entries", () => {
  assert.equal(convictionMult({ cfScore: 85, verdict: "promising" }).mult, CONVICTION.hiMult);
  assert.equal(convictionMult({ cfScore: 85, verdict: "live_ready" }).mult, CONVICTION.hiMult);
  assert.equal(convictionMult({ cfScore: 85, verdict: "needs_data" }).mult, 1); // no verdict backing: no boost
  assert.equal(convictionMult({ cfScore: 65, verdict: "promising" }).mult, CONVICTION.loMult);
  assert.equal(convictionMult({ cfScore: 75, verdict: "unproven" }).mult, CONVICTION.loMult);
  assert.equal(convictionMult({ cfScore: 75, verdict: "avoid" }).mult, CONVICTION.loMult);
  assert.equal(convictionMult({ cfScore: 75, verdict: null }).mult, 1);
  assert.equal(convictionMult({ cfScore: null, verdict: "promising" }).mult, 1);
});

test("conviction sizing reverts to flat when 30+ weighted trades did worse than flat", () => {
  // High-conviction (1.25×) trades lost, low-conviction (0.75×) won: weighting hurt.
  const bad = Array.from({ length: 30 }, (_, i) => (i % 2 ? { r: -1, mult: 1.25 } : { r: 1, mult: 0.75 }));
  assert.equal(convictionTune({ conviction: true, trades: bad }), false);
  // Weighting helped: no change.
  const goodTrades = Array.from({ length: 30 }, (_, i) => (i % 2 ? { r: 1, mult: 1.25 } : { r: -1, mult: 0.75 }));
  assert.equal(convictionTune({ conviction: true, trades: goodTrades }), null);
  // Too few trades, or already flat: no change.
  assert.equal(convictionTune({ conviction: true, trades: bad.slice(0, 10) }), null);
  assert.equal(convictionTune({ conviction: false, trades: bad }), null);
});

// ───────────────────────── Learner blind spots ─────────────────────────

test("confluence persists each check's result, and entryFeatures turns them into yes/no lesson features", () => {
  const minutes = syntheticMinutes(7, 1_760_000_000 - (1_760_000_000 % 86400), 5 * 1440, 60000);
  const candles = aggregate(minutes, 3600);
  const i = candles.length - 1;
  const entry = candles[i].close;
  const cf = confluence({ strategy: "ema_trend", timeframe: "1h", side: "long", candles, entry, stop: entry * 0.99 });
  // Every computed check (weight-0 ones included) lands in readings as cf_<key> = 1/0.
  for (const k of cf.checks) assert.equal(cf.readings[`cf_${k.key}`], k.pass ? 1 : 0);
  assert.ok(cf.checks.some((k) => k.weight === 0), "weight-0 checks are recorded");
  const f = entryFeatures({ side: "long", entry, stop: entry * 0.99, symbol: "BTCUSDT", at: NOW, indicators: { ...cf.readings, cfMin: 75 }, strategy: "ema_trend" });
  for (const k of cf.checks) assert.equal(f[`cf_${k.key}`], cf.readings[`cf_${k.key}`] === 1 ? "yes" : "no");
  // The per-setup threshold travels with the entry and drives the low_confluence mistake tag.
  assert.equal(f.cfMin, 75);
  const tags = mistakeTags("ema_trend", { confluence: 70, cfMin: 75 });
  assert.ok(tags.some((t) => t.tag === "low_confluence"), "70 under a per-setup bar of 75 is tagged");
  assert.ok(!mistakeTags("ema_trend", { confluence: 70, cfMin: 70 }).some((t) => t.tag === "low_confluence"));
});
