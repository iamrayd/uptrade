// The aggressive accounts' playbook (playbook.ts) and their view of the market (aggro.ts).

import { test } from "node:test";
import assert from "node:assert/strict";
import { AGGRO, AGGRO_KEY, autopsy, calibrate, cellKeys, dayGuard, estimate, learn, newPlaybook, readPlaybook, riskFor, rollDay, type Facets, type Playbook } from "../../supabase/functions/_shared/bot/playbook.ts";
import { aggroCandidates, aggroPool, aggroReplay, facetFeatures, facetsOf, isAggro, learnedR } from "../../supabase/functions/_shared/bot/aggro.ts";
import { aggro, STRATEGIES, STRATEGY_BY_KEY } from "../../supabase/functions/_shared/bot/strategies.ts";
import { AGGRO_SEED } from "../../supabase/functions/_shared/bot/aggro-seed.ts";
import { SLIPPAGE } from "../../supabase/functions/_shared/bot/analysis.ts";
import { aggregate, syntheticMinutes } from "./helpers.ts";

const F: Facets = { src: "donchian", side: "long", sym: "BTCUSDT", htf: "with", cf: "hi", vol: "normal", adx: "trend", ema: "with", ses: "us" };
const close = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) <= eps;
/** A playbook whose calibration says "raw estimates are right as they are" (slope ≈ 1 over many signals). */
function trusting(pb: Playbook = newPlaybook()) {
  // 1000 signals with raw x in {−0.5, +0.5} and outcome y = x: mean 0, slope 1.
  pb.cal = { n: 1000, sx: 0, sy: 0, sxx: 250, sxy: 250 };
  return pb;
}

test("the aggressive strategy is a meta strategy on 15m and 1h only, outside the rule sets it draws from", () => {
  assert.equal(aggro.key, AGGRO_KEY);
  assert.equal(STRATEGY_BY_KEY[AGGRO_KEY], aggro);
  assert.deepEqual(aggro.timeframes, ["15m", "1h"]);
  assert.ok(isAggro("aggro") && !isAggro("donchian"));
  const pool = aggroPool();
  assert.ok(pool.length >= 5);
  assert.ok(pool.every((s) => !s.pool && !s.newsAware), "the pool holds plain rule sets: no meta strategy, no news twin");
  assert.deepEqual(pool.map((s) => s.key), aggro.pool);
  assert.equal(aggro.entry([]), null, "it never signals by itself");
  assert.equal(STRATEGIES.filter((s) => s.pool).length, 1);
  assert.ok(aggro.warmup >= Math.max(...pool.map((s) => s.warmup)));
});

test("a signal belongs to: all signals, its rule set, each context, and each context within the rule set", () => {
  const keys = cellKeys(F);
  assert.equal(keys.length, 2 + 8 + 8);
  assert.equal(new Set(keys).size, keys.length);
  assert.ok(keys.includes("*") && keys.includes("s=donchian") && keys.includes("htf=with") && keys.includes("s=donchian|htf=with") && keys.includes("s=donchian|sym=BTCUSDT"));
});

test("learning: outcomes are clipped, fade with age, and one sample teaches little", () => {
  const pb = newPlaybook();
  learn(pb, [{ facets: F, r: 50 }]);
  assert.deepEqual(pb.cells["s=donchian"], [1, AGGRO.rClip[1]], "an outlier is clipped before it is learned");
  assert.equal(pb.learned, 1);
  learn(pb, [{ facets: F, r: Number.NaN }]);
  assert.equal(pb.learned, 1, "an outcome that is not a number is ignored");
  learn(pb, [{ facets: F, r: -1 }]);
  const [n, s] = pb.cells["s=donchian"];
  assert.ok(close(n, 1 * AGGRO.decay + 1, 1e-4) && close(s, 5 * AGGRO.decay - 1, 1e-4), "the older sample was scaled by the decay");

  // One lucky +5R for a rule set, in a playbook that knows signals average about zero: 20 phantom samples hold it down.
  const known = newPlaybook();
  for (let i = 0; i < 300; i++) learn(known, [{ facets: { ...F, src: "supertrend" }, r: i % 2 ? 1 : -1 }]);
  learn(known, [{ facets: { ...F, src: "bb_rsi", ses: "asia", sym: "SOLUSDT" }, r: 5 }]);
  const lucky = estimate(known, { ...F, src: "bb_rsi", ses: "asia", sym: "SOLUSDT" });
  assert.ok(lucky.base > 0 && lucky.base < 0.3, `one sample moved the rule set's average to ${lucky.base}`);
  assert.ok(lucky.raw < 1, `and its estimate to ${lucky.raw}`);
});

test("the raw estimate follows the record: the rule set first, then the context, each shrunk toward the level above", () => {
  const pb = newPlaybook();
  const good = F;
  const bad: Facets = { ...F, htf: "against" };
  for (let i = 0; i < 200; i++) {
    learn(pb, [{ facets: good, r: i % 2 ? 2 : -0.5 }]); // +0.75R on average with the trend
    learn(pb, [{ facets: bad, r: i % 4 ? -1 : 1 }]); // −0.5R against it
  }
  const g = estimate(pb, good);
  const b = estimate(pb, bad);
  assert.ok(g.raw > 0.2 && b.raw < 0, `with ${g.raw}, against ${b.raw}`);
  assert.ok(g.raw < 0.75 && b.raw > -0.5, "estimates stay inside the observed averages (shrinkage)");
  assert.equal(g.parts[0].key, "s=donchian|htf=with", "the context that sets the two apart is the largest effect");
  assert.ok(g.parts[0].dev > 0 && b.parts[0].dev < 0);
  // A rule set never seen starts from the average of all signals, shrunk.
  const unseen = estimate(pb, { ...F, src: "bb_rsi" });
  assert.equal(unseen.n, 0);
  assert.ok(Math.abs(unseen.base) < Math.abs(g.base) + 0.2);
});

test("calibration: the playbook learns whether its own estimates can be trusted, sign included", () => {
  // No checked signals: nothing is expected of any signal.
  assert.deepEqual(calibrate(newPlaybook(), 0.5), { exp: 0, slope: 0 });

  // Well-rated signals kept paying: the estimate stands.
  const follow = newPlaybook();
  for (let i = 0; i < 600; i++) {
    const raw = i % 2 ? 0.3 : -0.3;
    learn(follow, [{ facets: F, r: raw * 2 + (i % 3 ? 0.5 : -1), raw }]);
  }
  assert.ok(calibrate(follow, 0.3).slope > 1);
  assert.ok(calibrate(follow, 0.3).exp > calibrate(follow, -0.3).exp);

  // Well-rated signals did worse: the estimate is turned around.
  const fade = newPlaybook();
  for (let i = 0; i < 600; i++) {
    const raw = i % 2 ? 0.3 : -0.3;
    learn(fade, [{ facets: F, r: -raw * 2 + (i % 3 ? 0.5 : -1), raw }]);
  }
  assert.ok(calibrate(fade, 0.3).slope < -1);
  assert.ok(calibrate(fade, 0.3).exp < calibrate(fade, -0.3).exp, "a good record now counts against a signal");

  // No relation at all, and every signal loses: whatever the raw estimate says, nothing is worth a trade.
  const flat = newPlaybook();
  for (let i = 0; i < 600; i++) learn(flat, [{ facets: F, r: i % 3 ? -0.6 : 0.6, raw: i % 2 ? 0.4 : -0.4 }]);
  assert.ok(Math.abs(calibrate(flat, 0.4).slope) < 0.2);
  assert.ok(calibrate(flat, 0.4).exp < 0, "the average outcome of all checked signals is the anchor");

  // Few checked signals: the slope is shrunk toward 0.
  const few = newPlaybook();
  for (let i = 0; i < 6; i++) learn(few, [{ facets: F, r: i % 2 ? 3 : -1, raw: i % 2 ? 0.05 : -0.05 }]);
  assert.ok(Math.abs(calibrate(few, 0.05).slope) < 1, `slope ${calibrate(few, 0.05).slope} from 6 signals`);
  // An outcome without a recorded estimate teaches the cells but not the calibration.
  const before = { ...few.cal };
  learn(few, [{ facets: F, r: 1 }]);
  assert.deepEqual(few.cal, before);
});

test("bet size: nothing below the edge or without enough history, then expected R × Kelly fraction between the floor and the cap", () => {
  const pb = trusting();
  for (let i = 0; i < 300; i++) learn(pb, [{ facets: F, r: i % 2 ? 2.5 : -1 }]); // +0.75R
  const est = estimate(pb, F);
  assert.ok(close(est.exp, est.raw, 0.01 * Math.abs(est.raw)), `slope ${est.slope} around 0: the calibrated estimate ${est.exp} is the raw one ${est.raw}`);
  const big = riskFor(est);
  assert.equal(big.pct, AGGRO.maxRisk, `expected ${est.exp}R is capped at the maximum risk`);
  assert.match(big.why, /risks 10\.0% of equity/);
  assert.equal(riskFor({ ...est, exp: 0.1 }).pct, Math.max(AGGRO.minRisk, 0.1 * AGGRO.kelly));
  assert.ok(close(riskFor({ ...est, exp: AGGRO.minEdge }).pct, AGGRO.minRisk), "at the edge: the floor");
  assert.equal(riskFor({ ...est, exp: AGGRO.minEdge - 0.001 }).pct, 0);
  assert.equal(riskFor({ ...est, exp: -0.3 }).pct, 0);
  assert.equal(riskFor({ ...est, n: AGGRO.minSamples - 1 }).pct, 0, "a rule set without a record is not traded");
  assert.equal(riskFor({ ...est, checked: AGGRO.calMin - 1 }).pct, 0, "estimates that have not been checked are not bet on");
  for (const e of [0.05, 0.08, 0.2, 0.6, 3]) {
    const p = riskFor({ ...est, exp: e }).pct;
    assert.ok(p >= AGGRO.minRisk && p <= AGGRO.maxRisk);
  }
});

test("the day: the target and the loss limit stop new entries until the next UTC day or the next life", () => {
  const pb = newPlaybook();
  const t0 = Date.UTC(2026, 10, 5, 0, 0, 30);
  assert.equal(rollDay(pb, t0, 100, 1), true);
  assert.equal(rollDay(pb, t0 + 3600_000, 140, 1), false, "the day's start is fixed once");
  assert.equal(dayGuard(pb, 105).block, false);
  assert.equal(dayGuard(pb, 110).block, true);
  assert.match(dayGuard(pb, 110.5).why, /target is reached/);
  assert.equal(dayGuard(pb, 86).block, false);
  assert.equal(dayGuard(pb, 85).block, true);
  assert.match(dayGuard(pb, 80).why, /loss limit/);
  assert.ok(close(dayGuard(pb, 93).pnl, -0.07));
  assert.equal(rollDay(pb, t0 + 86400_000, 85, 1), true, "a new day");
  assert.equal(dayGuard(pb, 85).block, false);
  assert.equal(rollDay(pb, t0 + 86400_000 + 60_000, 100, 2), true, "a new life on the same day starts its own day");
  assert.deepEqual(pb.day, { date: "2026-11-06", start: 100, life: 2 });
});

test("post-mortem: the life's record, and the losers between its peak and its end are learned a second time", () => {
  const pb = newPlaybook();
  const killer: Facets = { ...F, src: "supertrend", htf: "against" };
  const day = (d: number) => new Date(Date.UTC(2026, 10, d)).toISOString();
  const trades = [
    { facets: F, r: 2, net: 40, closed_at: day(2) },
    { facets: F, r: 1, net: 30, closed_at: day(3) }, // peak: $170
    { facets: killer, r: -1, net: -60, closed_at: day(4) },
    { facets: F, r: 0.5, net: 10, closed_at: day(5) }, // a winner after the peak is not fatal
    { facets: killer, r: -1.2, net: -70, closed_at: day(6) },
    { facets: null, r: null, net: -45, closed_at: day(7) }, // a trade without a context is counted, not learned
  ];
  learn(pb, trades.filter((t) => t.facets).map((t) => ({ facets: t.facets!, r: t.r! })));
  const learned = pb.learned;
  const before = [...pb.cells["s=supertrend|htf=against"]];
  const untouched = [...pb.cells["s=donchian"]];

  const rec = autopsy(pb, { life: 3, startedAt: day(1), endedAt: day(7), startBalance: 100, endEquity: 5, cause: "busted", trades: [...trades].reverse() });
  assert.equal(rec.life, 3);
  assert.equal(rec.trades, 6);
  assert.equal(rec.wins, 3);
  assert.equal(rec.peak, 170);
  assert.equal(rec.end, 5);
  assert.equal(rec.cause, "busted");
  assert.ok(rec.fatal.some((f) => f.key === "s=supertrend" && f.n === 2 && close(f.r, -2.2)), JSON.stringify(rec.fatal));
  assert.match(rec.summary, /Life 3 lasted 6\.0 days and took 6 trades; it busted at \$5\.00\. It peaked at \$170\.00, then lost \$165\.00 over 4 trades\./);
  assert.match(rec.summary, /count double in the next life/);

  const after = pb.cells["s=supertrend|htf=against"];
  assert.ok(after[0] > before[0] + 1.9 && after[1] < before[1] - 2, "the two fatal losers weigh twice now");
  assert.deepEqual(pb.cells["s=donchian"], untouched, "winners and trades before the peak are not learned again");
  assert.equal(pb.learned, learned, "no new outcome was counted");
  assert.equal(pb.autopsied, 3);
  assert.deepEqual(pb.lives.map((l) => l.life), [3]);
  // Written once per life: a second post-mortem of the same life replaces the record.
  autopsy(pb, { life: 3, startedAt: day(1), endedAt: day(7), startBalance: 100, endEquity: 5, cause: "busted", trades: [] });
  assert.equal(pb.lives.length, 1);

  // A life redeployed at its peak has no fatal trades.
  const calm = autopsy(newPlaybook(), { life: 1, startedAt: null, endedAt: day(3), startBalance: 100, endEquity: 130, cause: "redeployed", trades: trades.slice(0, 1) });
  assert.deepEqual(calm.fatal, []);
  assert.match(calm.summary, /was redeployed at \$130\.00/);
});

test("a stored playbook is read back whole; anything else is treated as none", () => {
  const pb = trusting();
  learn(pb, [{ facets: F, r: 1, raw: 0.2 }]);
  rollDay(pb, Date.UTC(2026, 10, 5), 100, 1);
  assert.deepEqual(readPlaybook(JSON.parse(JSON.stringify(pb))), pb);
  for (const bad of [null, undefined, 3, "x", {}, { v: 2, cells: {} }, { v: 1 }]) assert.equal(readPlaybook(bad), null);
  const old = readPlaybook({ v: 1, cells: { "*": [1, 1] } })!;
  assert.deepEqual(old.cal, { n: 0, sx: 0, sy: 0, sxx: 0, sxy: 0 }, "a playbook stored before calibration existed starts with none");
  assert.deepEqual([old.learned, old.autopsied, old.lives, old.day], [0, 0, [], null]);
});

test("the seed a new account starts from holds a playbook for each aggressive timeframe", () => {
  for (const tf of aggro.timeframes!) {
    const seed = AGGRO_SEED[tf];
    assert.ok(seed, `no seed for ${tf}`);
    const pb = newPlaybook(seed);
    assert.ok(pb.cal.n >= AGGRO.calMin, `${tf}: the seed's estimates are already checked (${pb.cal.n})`);
    for (const s of aggroPool()) assert.ok((pb.cells[`s=${s.key}`]?.[0] ?? 0) >= AGGRO.minSamples, `${tf}: ${s.key} has a record`);
    for (const [k, [n, sum]] of Object.entries(pb.cells)) assert.ok(n > 0 && Number.isFinite(sum), `${tf} ${k}`);
    assert.notEqual(pb.cells, seed.cells, "the seed itself is never written to");
  }
});

test("a trade's learned R carries slippage on both fills, like a replayed signal", () => {
  const t = { r_multiple: 1.5, qty: 2, entry_price: 100, exit_price: 103, risk_usd: 4 };
  assert.ok(close(learnedR(t)!, 1.5 - (SLIPPAGE * 2 * 203) / 4));
  assert.equal(learnedR({ ...t, r_multiple: null }), null);
  assert.equal(learnedR({ ...t, risk_usd: 0 }), 1.5);
});

// A market with trends and chop, on 15m bars: enough for every rule set to fire.
const T0 = 1_760_000_000 - (1_760_000_000 % 86400);
const SYMS = { BTCUSDT: 60000, ETHUSDT: 3000, SOLUSDT: 150 };
const BARS = Object.fromEntries(Object.entries(SYMS).map(([s, p], k) => [s, aggregate(syntheticMinutes(40 + k, T0, 60 * 24 * 40, p), 900)]));
const FILTERS = { BTCUSDT: { step: 0.00001, tick: 0.01 }, ETHUSDT: { step: 0.0001, tick: 0.01 }, SOLUSDT: { step: 0.001, tick: 0.01 } };

test("candidates: every rule set's signal on the bar, with a complete context that survives being stored", () => {
  const c = BARS.BTCUSDT;
  const seen = new Set<string>();
  let n = 0;
  for (let i = 600; i < c.length; i++) {
    const hist = c.slice(i + 1 - 600, i + 1);
    const price = hist[hist.length - 1].close;
    for (const cand of aggroCandidates({ candles: hist, timeframe: "15m", symbol: "BTCUSDT", at: (hist[hist.length - 1].time + 900) * 1000, tick: 0.01, entry: price })) {
      n++;
      seen.add(cand.strategy.key);
      assert.ok(cand.side === "long" ? cand.stop < price : cand.stop > price);
      if (cand.takeProfit != null) assert.ok(cand.side === "long" ? cand.takeProfit > price : cand.takeProfit < price);
      assert.equal(cand.facets.src, cand.strategy.key);
      assert.equal(cand.facets.sym, "BTCUSDT");
      assert.ok(["with", "against", "mixed", "na"].includes(cand.facets.htf) && ["lo", "mid", "hi"].includes(cand.facets.cf));
      assert.ok(["calm", "normal", "wild"].includes(cand.facets.vol) && ["range", "mid", "trend"].includes(cand.facets.adx) && ["with", "against"].includes(cand.facets.ema));
      assert.ok(["asia", "europe", "us", "late"].includes(cand.facets.ses));
      // What is stored with a shadow signal (JSON) gives the same context back.
      assert.deepEqual(facetsOf(JSON.parse(JSON.stringify(cand.features))), cand.facets);
      assert.equal(cand.features.confluence, cand.cf.score);
    }
  }
  assert.ok(n > 50, `${n} candidates`);
  assert.ok(seen.size >= 5, `rule sets that fired: ${[...seen]}`);
  assert.equal(facetsOf({ side: "long", symbol: "BTCUSDT" }), null, "an ordinary bot's signal has no playbook context");
  assert.deepEqual(facetsOf(facetFeatures({ stopPct: 1 }, F)), F);
});


/** A playbook that believes every rule set pays 1R and trusts that belief: it bets the maximum on everything. */
function eager(keys: string[], weight = 400) {
  const pb = trusting();
  for (const k of keys) pb.cells[`s=${k}`] = [weight, weight];
  pb.cells["*"] = [weight * keys.length, weight * keys.length];
  return pb;
}

test("replay: the books balance, one position per coin, risk inside its bounds, and the same data gives the same result", () => {
  const from = BARS.BTCUSDT[600].time;
  const run = () => aggroReplay({ timeframe: "15m", candlesBySymbol: BARS, filters: FILTERS, from, startBalance: 100, maxLeverage: 20, slippage: 0.0005, playbook: eager(aggroPool().map((s) => s.key)) });
  const res = run();
  assert.ok(res.trades.length > 30, `${res.trades.length} trades`);
  for (let life = 1; life <= res.livesUsed; life++) {
    const net = res.trades.filter((t) => t.life === life).reduce((s, t) => s + t.net, 0);
    const rec = res.lives.find((l) => l.life === life);
    if (rec) assert.ok(close(rec.end, 100 + net, 0.006), `life ${life}: ended at ${rec.end}, trades sum to ${100 + net}`);
    else assert.ok(close(res.finalEquity, 100 + net, 1e-6 * Math.max(1, res.finalEquity)), `the running life holds ${res.finalEquity}, its trades sum to ${100 + net}`);
  }
  for (const t of res.trades) {
    assert.ok(t.riskPct > 0 && t.riskPct <= AGGRO.maxRisk + 1e-9, `risk ${t.riskPct}`);
    assert.ok(t.exitTime >= t.entryTime && t.entryTime >= from);
    assert.ok(aggro.pool!.includes(t.src));
  }
  for (const sym of Object.keys(SYMS)) {
    const list = res.trades.filter((t) => t.symbol === sym).sort((x, y) => x.entryTime - y.entryTime);
    for (let i = 1; i < list.length; i++) assert.ok(list[i].entryTime >= list[i - 1].exitTime, `${sym}: overlapping trades`);
  }
  assert.ok(res.playbook.learned > res.trades.length, "untraded signals were learned too");
  assert.ok(res.signals.length > res.trades.length);
  assert.ok(res.days.length >= 30 && res.days.every((d) => Number.isFinite(d.ret)));
  const again = run();
  assert.equal(again.finalEquity, res.finalEquity);
  assert.equal(again.trades.length, res.trades.length);

  // An empty playbook has checked nothing, so it bets on nothing until it has; it learns from every signal meanwhile.
  const cold = aggroReplay({ timeframe: "15m", candlesBySymbol: BARS, filters: FILTERS, from, startBalance: 100, maxLeverage: 20, slippage: 0.0005 });
  const firstTrade = cold.trades[0]?.entryTime ?? Infinity;
  assert.ok(cold.signals.filter((s) => s.time < firstTrade).length >= AGGRO.calMin || cold.trades.length === 0);
  assert.ok(cold.playbook.learned > 100);
});

test("replay: a life that busts is post-mortemed, the next starts at the starting balance, and the playbook no longer bets on what killed it", () => {
  // A market that creeps up for 400 bars, halves in one bar, and creeps up again; and one rule set that
  // buys every bar with a stop 0.5% below and never takes profit. The crash gaps through stop and
  // liquidation price alike, so all three positions lose their whole margin: the account is busted.
  const CRASH = 400;
  const crashing = (p0: number) => {
    const out = [];
    let p = p0;
    for (let i = 0; i < 1200; i++) {
      const open = i === CRASH ? p * 0.5 : p;
      p = open * 1.0005;
      out.push({ time: T0 + i * 900, open, high: p * 1.0001, low: open * 0.9999, close: p, volume: 100 });
    }
    return out;
  };
  const data = { BTCUSDT: crashing(60000), ETHUSDT: crashing(3000), SOLUSDT: crashing(150) };
  const dipBuyer = {
    ...STRATEGY_BY_KEY.donchian,
    key: "dip_buyer",
    warmup: 250,
    entry: (c: { close: number }[]) => ({ side: "long" as const, stop: c[c.length - 1].close * 0.995, takeProfit: null, reason: "buys every bar and holds: a test rule set that only a crash can stop", indicators: {} }),
    manage: () => ({}),
  };
  const was = AGGRO.calibration;
  AGGRO.calibration = false; // the raw record alone, so the test is about lives and not about calibration
  try {
    const from = T0 + 300 * 900;
    const res = aggroReplay({ timeframe: "15m", candlesBySymbol: data, filters: FILTERS, from, startBalance: 100, maxLeverage: 20, slippage: 0.0005, playbook: eager(["dip_buyer"]), pool: [dipBuyer] });
    assert.equal(res.livesUsed, 2, `lives ${res.livesUsed}, equity ${res.finalEquity}`);
    assert.equal(res.lives.length, 1);
    assert.equal(res.playbook.autopsied, 1);
    const rec = res.lives[0];
    const mine = res.trades.filter((t) => t.life === 1);
    assert.equal(mine.length, 3, "one position per coin, held into the crash");
    assert.ok(mine.every((t) => t.reason === "liquidation" && t.net < 0 && t.exitTime === T0 + CRASH * 900));
    assert.equal(rec.life, 1);
    assert.equal(rec.cause, "busted");
    assert.equal(rec.trades, 3);
    assert.equal(rec.wins, 0);
    assert.equal(rec.peak, 100, "it never got above its starting balance");
    assert.ok(rec.end < 10 && close(rec.end, 100 + mine.reduce((s, t) => s + t.net, 0), 0.006), `life 1 ended at $${rec.end}`);
    assert.match(rec.summary, /Life 1 lasted .* took 3 trades; it busted at \$/);
    assert.match(rec.summary, /It never got above its starting balance\./);
    assert.deepEqual(rec.fatal.map((f) => f.key)[0], "s=dip_buyer", "the post-mortem names what killed the life");
    assert.equal(rec.fatal[0].n, 3);
    assert.equal(rec.started_at, new Date(from * 1000).toISOString());
    assert.equal(rec.ended_at, new Date((T0 + (CRASH + 1) * 900) * 1000).toISOString());

    // Life 2 has the full starting balance and the playbook of life 1. Every signal before the crash
    // has by then been replayed into the crash, so the rule set's record is far below the edge: the
    // second life does not repeat the bet. It comes back only once newer signals have paid for 200 bars.
    const life2 = res.trades.filter((t) => t.life === 2);
    const quiet = res.signals.filter((x) => x.time > T0 + CRASH * 900 && x.time <= T0 + (CRASH + 150) * 900);
    assert.ok(quiet.length >= 300 && quiet.every((x) => !x.traded && x.exp < AGGRO.minEdge), "after the crash the rule set is rated below the edge and not traded");
    assert.ok(life2.every((t) => t.entryTime > T0 + (CRASH + 200) * 900), "no entry until the signals after the crash have been replayed");
    assert.ok(life2.length > 0 && life2.every((t) => t.exp >= AGGRO.minEdge && t.net > 0), "it trades again once the newer record pays");
    assert.ok(close(res.finalEquity, 100 + life2.reduce((sum, t) => sum + t.net, 0), 1e-6), "life 2 started from the starting balance");
    assert.ok(res.playbook.learned > 500, "the signals it could not take were learned as well");
    assert.ok(res.days.some((d) => d.life === 2), "the new life keeps its own days");
  } finally {
    AGGRO.calibration = was;
  }
});
