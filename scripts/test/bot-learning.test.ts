import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregateTo, confluence, htfBias, passesGate } from "../../supabase/functions/_shared/bot/confluence.ts";
import { cooldownUntil, DISCIPLINE, riskMultiplier } from "../../supabase/functions/_shared/bot/discipline.ts";
import { aggregateNews, decodeEntities, fetchNews, newsFor, newsGate, newsReadings, NEWS, parseRss, scoreHeadline, type NewsState } from "../../supabase/functions/_shared/bot/news.ts";
import {
  candidateRules,
  entryFeatures,
  evaluateRule,
  lessonImpact,
  mineLessons,
  mistakeTags,
  replayBars,
  reviewTrade,
  simulateSignal,
  SLIPPAGE,
  tagStats,
  type AnalysisTrade,
  type ShadowSignal,
} from "../../supabase/functions/_shared/bot/analysis.ts";
import { STRATEGIES, STRATEGY_BY_KEY } from "../../supabase/functions/_shared/bot/strategies.ts";
import { TAKER_FEE } from "../../supabase/functions/_shared/bot/risk.ts";
import type { Candle, StrategyDef } from "../../supabase/functions/_shared/bot/types.ts";

const H = 3600_000;
const T0S = 1_700_000_000 - (1_700_000_000 % 86400);
const bars = (n: number, f: (i: number) => number, stepSec = 3600): Candle[] =>
  Array.from({ length: n }, (_, i) => {
    const c = f(i);
    return { time: T0S + i * stepSec, open: f(Math.max(0, i - 1)), high: c * 1.002, low: c * 0.998, close: c, volume: 100 };
  });

// ───────── confluence gate ─────────

test("aggregateTo merges bars into complete higher-timeframe bars only", () => {
  // 10 hourly bars starting on a 4h boundary → two complete 4h bars; the last two hours form a partial bucket and are dropped.
  const c = bars(10, (i) => 100 + i);
  const out = aggregateTo(c, 3600, 14400);
  assert.equal(out.length, 2);
  assert.equal(out[0].time, T0S);
  assert.equal(out[0].open, c[0].open);
  assert.equal(out[0].close, c[3].close);
  assert.equal(out[0].high, Math.max(...c.slice(0, 4).map((x) => x.high)));
  assert.equal(out[1].close, c[7].close);
  // Starting mid-bucket drops the partial first bucket too.
  assert.equal(aggregateTo(c.slice(2), 3600, 14400).length, 1);
});

test("the higher-timeframe bias reads trends and has none for 1d", () => {
  const up = bars(600, (i) => 100 * 1.002 ** i);
  const down = bars(600, (i) => 100 * 0.998 ** i);
  assert.equal(htfBias(up, "1h"), 1);
  assert.equal(htfBias(down, "1h"), -1);
  assert.equal(htfBias(up, "1d"), null);
  assert.equal(htfBias(up.slice(0, 30), "1h"), null, "too little history");
});

test("confluence: signals with the market score high, against it score low, and the gate follows", () => {
  const up = bars(600, (i) => 100 * 1.002 ** i);
  const last = up[up.length - 1].close;
  const atr = last * 0.004;
  for (const strategy of ["macd_adx", "donchian", "ema_trend"]) {
    const long = confluence({ strategy, timeframe: "1h", side: "long", candles: up, entry: last, stop: last - 2 * atr * 3 });
    const short = confluence({ strategy, timeframe: "1h", side: "short", candles: up, entry: last, stop: last + 2 * atr * 3 });
    assert.ok(long.score >= short.score, `${strategy}: long ${long.score} vs short ${short.score}`);
    assert.equal(long.veto, null);
    assert.match(short.veto!, /against both EMA 200 and Supertrend/, `${strategy}: a short in a steady uptrend is refused outright`);
    assert.equal(passesGate(short), false);
    assert.equal(passesGate(short, 0), false, "a veto holds whatever the threshold");
    assert.match(short.summary, /Refused: price is against both EMA 200 and Supertrend/);
    assert.equal(long.readings.cfScore, long.score);
    assert.equal(long.readings.cfHtf, 1);
    assert.equal(short.readings.cfHtf, -1);
    assert.ok(long.summary.startsWith(`Confluence ${long.score}/100`));
  }
  // Without enough checks there is nothing to agree on, so nothing passes.
  assert.equal(passesGate({ ...confluence({ strategy: "macd_adx", timeframe: "1h", side: "long", candles: up, entry: last, stop: last - 5 }), total: 0 }), false);
});

test("only the checks the data backs up vote; the others are recorded at weight 0", () => {
  const up = bars(600, (i) => 100 * 1.002 ** i);
  const last = up[up.length - 1].close;
  const cf = confluence({ strategy: "ema_trend", timeframe: "1h", side: "long", candles: up, entry: last, stop: last * 0.97 });
  const weight = Object.fromEntries(cf.checks.map((c) => [c.key, c.weight]));
  assert.equal(weight.momentum, 3);
  assert.equal(weight.volume, 2);
  assert.equal(weight.htf, 0, "the next timeframe up showed no edge, so it does not vote");
  assert.equal(weight.strength, 0, "ADX strength showed slightly negative lift, so it does not vote");
  assert.ok(cf.checks.some((c) => c.key === "htf") && cf.checks.some((c) => c.key === "strength"), "but they are still recorded");
  assert.equal(cf.total, cf.checks.filter((c) => c.weight > 0).length);
  assert.ok(cf.readings.cfHtf != null, "the higher-timeframe reading is still stored for the learner");
  // The score is the weight share of passing voting checks.
  const voting = cf.checks.filter((c) => c.weight > 0);
  assert.equal(cf.score, Math.round((voting.reduce((s, c) => s + (c.pass ? c.weight : 0), 0) / voting.reduce((s, c) => s + c.weight, 0)) * 100));
});

test("confluence leaves out the checks a strategy's own trigger already guarantees", () => {
  const up = bars(600, (i) => 100 * 1.002 ** i);
  const last = up[up.length - 1].close;
  const keys = (strategy: string) => confluence({ strategy, timeframe: "1h", side: "long", candles: up, entry: last, stop: last * 0.97 }).checks.map((c) => c.key);
  assert.ok(!keys("ema_trend").includes("trend200") && keys("macd_adx").includes("trend200"));
  assert.ok(!keys("macd_adx").includes("strength") && keys("ema_trend").includes("strength"));
  assert.ok(!keys("supertrend").includes("supertrend") && keys("ema_trend").includes("supertrend"));
  assert.ok(!keys("donchian").includes("volume") && keys("ema_trend").includes("volume"));
  // The news twin is judged exactly like its original.
  assert.deepEqual(keys("macd_adx_news"), keys("macd_adx"));
  // A fade is judged on regime and turn, not on trend.
  assert.ok(keys("bb_rsi").includes("range") && keys("bb_rsi").includes("rsiTurn") && !keys("bb_rsi").includes("momentum"));
});

// ───────── discipline ─────────

const trade = (symbol: string, r: number, minsAgo: number, now = Date.UTC(2026, 5, 1)) => ({ symbol, r, closed_at: new Date(now - minsAgo * 60_000).toISOString() });

test("risk is cut while an account is deeply down or on a losing streak, and restored when it recovers", () => {
  const ok = Array.from({ length: 10 }, (_, i) => trade("BTCUSDT", i % 2 ? 1 : -0.2, 600 - i * 10));
  assert.equal(riskMultiplier({ equity: 100, startBalance: 100, recent: ok }).mult, 1);
  assert.equal(riskMultiplier({ equity: 100, startBalance: 100, recent: ok }).note, null);
  assert.equal(riskMultiplier({ equity: 85, startBalance: 100, recent: ok }).mult, 1);
  assert.equal(riskMultiplier({ equity: 65, startBalance: 100, recent: ok }).mult, 0.5);
  const deep = riskMultiplier({ equity: 30, startBalance: 100, recent: ok });
  assert.equal(deep.mult, 0.25);
  assert.match(deep.note!, /70% below its starting balance/);
  const streak = [trade("BTCUSDT", 1, 100), trade("ETHUSDT", -1, 60), trade("BTCUSDT", -1, 40), trade("SOLUSDT", -1, 20)];
  assert.equal(riskMultiplier({ equity: 100, startBalance: 100, recent: streak }).mult, 0.5);
  const bad = Array.from({ length: 8 }, (_, i) => trade("BTCUSDT", i % 4 === 0 ? 0.5 : -0.8, 600 - i * 10));
  assert.equal(riskMultiplier({ equity: 95, startBalance: 100, recent: bad }).mult, 0.5, "a poor recent average cuts risk");
  assert.equal(riskMultiplier({ equity: 60, startBalance: 100, recent: [] }).mult, 0.5);
  // Never more than the configured risk, whatever happens.
  assert.ok(riskMultiplier({ equity: 500, startBalance: 100, recent: ok }).mult <= 1);
});

test("a loss makes the bot wait on that symbol; a losing streak makes it wait everywhere", () => {
  const tf = 15 * 60_000;
  const now = Date.UTC(2026, 5, 1);
  const lost = [trade("BTCUSDT", -1, 20, now)];
  const c = cooldownUntil(lost, "BTCUSDT", tf)!;
  assert.equal(c.until, now - 20 * 60_000 + DISCIPLINE.cooldownBars * tf);
  assert.ok(c.until > now, "still cooling down 20 minutes after a loss on a 15m bot");
  assert.equal(cooldownUntil(lost, "ETHUSDT", tf), null, "other coins are unaffected");
  assert.equal(cooldownUntil([trade("BTCUSDT", 1.5, 5, now)], "BTCUSDT", tf), null, "a win needs no cooldown");
  assert.equal(cooldownUntil([trade("BTCUSDT", -1, 300, now)], "BTCUSDT", tf)!.until < now, true, "old losses have expired");
  const streak = [trade("BTCUSDT", -1, 90, now), trade("ETHUSDT", -1, 60, now), trade("SOLUSDT", -1, 30, now)];
  const s = cooldownUntil(streak, "BTCUSDT", tf)!;
  assert.equal(s.until, now - 30 * 60_000 + DISCIPLINE.streakCooldownBars * tf);
  assert.match(s.why, /3 losses in a row/);
  assert.ok(cooldownUntil(streak, "XRPUSDT", tf)!.until > now, "a streak cools every symbol");
});

// ───────── news ─────────

const RSS_COINDESK = `<?xml version="1.0"?><rss version="2.0"><channel><title>CoinDesk</title>
<item><title><![CDATA[Bitcoin ETF approval sparks record inflows]]></title><link>https://x/1</link><pubDate>Wed, 28 Oct 2026 21:13:44 +0000</pubDate>
<description><![CDATA[Funds poured into <b>bitcoin</b> products.]]></description></item>
<item><title><![CDATA[Hackers drain $120 million from Solana lending protocol]]></title><pubDate>Wed, 28 Oct 2026 22:00:00 +0000</pubDate></item>
<item><title>No date here</title></item></channel></rss>`;
const RSS_CT = `<rss version="2.0"><channel><item><title>Bitcoin faces fresh pressure after Fed&#8217;s hawkish rate hold: Analysts</title>
<pubDate>Thu, 29 Oct 2026 01:12:01 +0000</pubDate><description>&lt;p&gt;Markets weighed the decision.&lt;/p&gt;</description></item></channel></rss>`;
const NOW = Date.UTC(2026, 9, 29, 2, 0);

test("RSS items are parsed (CDATA, entities, missing dates)", () => {
  const a = parseRss(RSS_COINDESK, "CoinDesk");
  assert.equal(a.length, 2, "an item without a date is dropped");
  assert.equal(a[0].title, "Bitcoin ETF approval sparks record inflows");
  assert.equal(a[0].description, "Funds poured into bitcoin products.");
  assert.equal(a[0].at, Date.UTC(2026, 9, 28, 21, 13, 44));
  const b = parseRss(RSS_CT, "Cointelegraph");
  assert.equal(b[0].title, "Bitcoin faces fresh pressure after Fed’s hawkish rate hold: Analysts");
  assert.equal(b[0].description, "Markets weighed the decision.");
  assert.equal(decodeEntities("A &amp; B &#039;c&#039; &quot;d&quot;"), "A & B 'c' \"d\"");
});

test("headlines are scored for direction, event risk and which coin they are about", () => {
  const s = (title: string, description?: string) => scoreHeadline({ title, description, source: "t", at: NOW });
  const hawkish = s("Bitcoin faces fresh pressure after Fed’s hawkish rate hold: Analysts");
  assert.ok(hawkish.sentiment < -0.3 && hawkish.scopes.includes("BTC") && hawkish.scopes.includes("MARKET"));
  assert.ok(hawkish.risk > 0 && hawkish.risk < 0.55, "a hawkish Fed is a risk, but not a stop-trading event");
  const hack = s("Hackers drain $120 million from Solana lending protocol");
  assert.deepEqual(hack.scopes, ["SOL"]);
  assert.equal(hack.risk, 1);
  assert.ok(hack.sentiment < 0);
  const etf = s("Bitcoin ETF approval sparks record inflows");
  assert.ok(etf.sentiment > 0.4 && etf.risk === 0);
  const noise = s("Dogecoin founder shares weekend plans");
  assert.deepEqual(noise.scopes, []);
  assert.equal(noise.sentiment, 0);
  const sec = s("SEC sues major exchange over unregistered tokens");
  assert.equal(sec.risk, 1);
  assert.ok(sec.scopes.includes("MARKET"));
  assert.ok(s("Ethereum price rallies as ether inflows surge").scopes.includes("ETH"));
  assert.ok(!s("Sol Blanco wins award").scopes.includes("SOL"), "'Sol' the name is not Solana");
});

test("news fades with age, is de-duplicated, and old headlines are ignored", () => {
  const hs = [
    { title: "Exchange hacked, funds stolen", source: "a", at: NOW - 1 * H },
    { title: "Exchange hacked: funds stolen!", source: "b", at: NOW - 1 * H }, // same story from a second feed
    { title: "Bitcoin rallies on ETF inflows", source: "a", at: NOW - 40 * H },
  ];
  const fresh = aggregateNews(hs, NOW);
  assert.equal(fresh.MARKET.n, 1, "the two hack headlines are one story, and the 40-hour-old one is out of the window");
  const btc = aggregateNews([{ title: "Bitcoin exchange hacked, funds stolen", source: "a", at: NOW - 1 * H }, { title: "Bitcoin exchange hacked, funds stolen", source: "b", at: NOW - 1 * H }], NOW);
  assert.equal(btc.BTC.n, 1, "the same headline from two feeds counts once");
  assert.ok(btc.BTC.risk > NEWS.riskBlock, `fresh hack risk ${btc.BTC.risk}`);
  const later = aggregateNews([{ title: "Bitcoin exchange hacked, funds stolen", source: "a", at: NOW - 3 * H }], NOW);
  assert.ok(later.BTC.risk < NEWS.riskBlock, `after 3 hours the risk has faded (${later.BTC.risk})`);
  assert.equal(aggregateNews([{ title: "Bitcoin crashes", source: "a", at: NOW - 30 * H }], NOW).BTC.n, 0, "older than 24h is ignored");
  assert.ok(btc.BTC.top[0].title.includes("hacked"));
});

const stateWith = (btc: { score: number; risk: number }, fetchedAt = NOW, market = { score: 0, risk: 0 }): NewsState => ({
  fetchedAt,
  fng: { value: 30, label: "Fear" },
  sources: ["t"],
  errors: [],
  scopes: {
    BTC: { ...btc, n: 1, top: [{ title: "Big headline", source: "t", at: NOW, sentiment: btc.score, risk: btc.risk }] },
    ETH: { score: 0, risk: 0, n: 0, top: [] },
    SOL: { score: 0, risk: 0, n: 0, top: [] },
    MARKET: { ...market, n: 0, top: [] },
  },
});

test("the news gate waits out events and refuses to trade against one-sided news", () => {
  const read = (s: NewsState, symbol = "BTCUSDT") => newsFor(s, symbol, NOW + 60_000);
  const event = newsGate(read(stateWith({ score: -0.1, risk: 0.7 })), "long");
  assert.equal(event.block, true);
  assert.match(event.reason, /High-impact news is fresh/);
  assert.equal(newsGate(read(stateWith({ score: 0.1, risk: 0.7 })), "short").block, true, "events stop entries in both directions");
  const bearish = read(stateWith({ score: -0.5, risk: 0.1 }));
  assert.equal(newsGate(bearish, "long").block, true);
  assert.equal(newsGate(bearish, "short").block, false, "bearish news is no obstacle to a short");
  assert.equal(newsGate(read(stateWith({ score: 0.5, risk: 0.1 })), "short").block, true);
  assert.equal(newsGate(read(stateWith({ score: 0.1, risk: 0.1 })), "long").block, false);
  // The market's mood counts half.
  assert.equal(read(stateWith({ score: -0.2, risk: 0 }, NOW, { score: -0.4, risk: 0 }))!.score, -0.4);
  assert.equal(read(stateWith({ score: 0, risk: 0 }, NOW, { score: 0, risk: 0.9 }))!.risk, 0.72);
  // A stale or missing reading never blocks, and says so.
  assert.equal(newsFor(stateWith({ score: -1, risk: 1 }), "BTCUSDT", NOW + NEWS.staleMs + 1), null);
  assert.equal(newsFor(null, "BTCUSDT", NOW), null);
  const none = newsGate(null, "long");
  assert.equal(none.block, false);
  assert.match(none.reason, /indicators alone/);
  assert.deepEqual(newsReadings(null), {});
  assert.deepEqual(newsReadings(read(stateWith({ score: -0.2, risk: 0.3 }))), { newsScore: -0.2, newsRisk: 0.3, fng: 30 });
});

const FETCH_NOW = Date.UTC(2026, 9, 28, 23, 0); // an hour after the Solana hack headline

test("fetching news survives a feed being down and reports it", async () => {
  const feeds: Record<string, string | number> = {
    "https://www.coindesk.com/arc/outboundfeeds/rss/": RSS_COINDESK,
    "https://cointelegraph.com/rss": RSS_CT,
    "https://decrypt.co/feed": 503,
    "https://api.alternative.me/fng/?limit=1": JSON.stringify({ data: [{ value: "23", value_classification: "Extreme Fear" }] }),
  };
  const state = await fetchNews(async (url) => {
    const v = feeds[url];
    if (v === undefined) throw new Error("unexpected url");
    return typeof v === "number" ? { ok: false, status: v, text: async () => "" } : { ok: true, status: 200, text: async () => v };
  }, FETCH_NOW);
  assert.deepEqual(state.sources.sort(), ["CoinDesk", "Cointelegraph", "Fear & Greed"]);
  assert.equal(state.errors.length, 1);
  assert.match(state.errors[0], /Decrypt: HTTP 503/);
  assert.deepEqual(state.fng, { value: 23, label: "Extreme Fear" });
  assert.ok(state.scopes.SOL.risk > NEWS.riskBlock, "the Solana hack headline is fresh");
  assert.ok(state.scopes.BTC.n >= 1);
  const down = await fetchNews(async () => { throw new Error("offline"); }, FETCH_NOW);
  assert.deepEqual(down.sources, []);
  assert.equal(down.errors.length, 4);
});

test("the news twins reuse their original's rules and are flagged", () => {
  for (const key of ["macd_adx", "donchian", "supertrend"]) {
    const base = STRATEGY_BY_KEY[key];
    const twin = STRATEGY_BY_KEY[`${key}_news`];
    assert.ok(twin, `${key}_news exists`);
    assert.equal(twin.baseKey, key);
    assert.equal(twin.newsAware, true);
    assert.equal(twin.entry, base.entry, "same trigger");
    assert.equal(twin.manage, base.manage, "same exits");
    assert.deepEqual(twin.params, base.params);
    assert.match(twin.rules, /News filter/);
    assert.equal(base.newsAware, undefined);
  }
  assert.equal(new Set(STRATEGIES.map((s) => s.key)).size, STRATEGIES.length, "keys are unique");
});

// ───────── mistakes and learning ─────────

const T0 = Date.UTC(2026, 0, 5);

function aTrade(i: number, r: number, o: Partial<AnalysisTrade> = {}): AnalysisTrade {
  const opened = T0 + i * 7 * H;
  return {
    id: `t${i}`, user_id: "u", account_id: "a", strategy: "macd_adx", timeframe: "1h", symbol: i % 2 ? "ETHUSDT" : "BTCUSDT", side: "long", qty: 1,
    entry_price: 100, initial_stop: 99, take_profit: 102, risk_usd: 1,
    opened_at: new Date(opened).toISOString(), closed_at: new Date(opened + 3 * H).toISOString(),
    exit_reason: r > 0 ? "take_profit" : "stop_loss", exit_price: 100 + r, exit_note: "Stop hit.", net_pnl: r, r_multiple: r,
    mfe_price: r > 0 ? 100 + r : 100.1, mae_price: r > 0 ? 99.8 : 99,
    entry_indicators: { close: 100, ema200: 98, atr14: 0.8, adx14: 30 },
    ...o,
  };
}

test("entries carry named mistake tags, and a fade is not blamed for trading against the trend", () => {
  const at = Date.UTC(2026, 0, 10, 15);
  const weak = entryFeatures({ side: "long", entry: 100, stop: 99.2, symbol: "BTCUSDT", at, strategy: "macd_adx", indicators: { close: 100, atr14: 1, ema200: 101, adx14: 14, plusDI: 15, minusDI: 20, volumeX: 0.6, rsi: 74 } });
  assert.equal(weak.mk_noise_stop, "yes");
  assert.equal(weak.mk_weak_trend, "yes");
  assert.equal(weak.mk_counter_trend, "yes");
  assert.equal(weak.mk_stretched_entry, "yes");
  assert.equal(weak.mk_thin_volume, "yes");
  assert.equal(weak.mk_dmi_against, "yes");
  assert.equal(weak.mk_fading_trend, undefined, "only applies to the fade strategy");
  assert.ok(mistakeTags("macd_adx", weak).length >= 6);
  const fade = entryFeatures({ side: "long", entry: 100, stop: 98, symbol: "BTCUSDT", at, strategy: "bb_rsi", indicators: { close: 100, atr14: 1, ema200: 103, adx14: 30, plusDI: 15, minusDI: 25, rsi: 33 } });
  assert.equal(fade.mk_counter_trend, "no", "3% under EMA 200 is normal for a fade");
  assert.equal(fade.mk_fading_trend, "yes");
  assert.equal(fade.mk_dmi_against, undefined);
  assert.equal(fade.mk_weak_trend, undefined);
  const lowCf = entryFeatures({ side: "long", entry: 100, stop: 98, symbol: "BTCUSDT", at, strategy: "macd_adx_news", indicators: { close: 100, atr14: 1, cfScore: 40, cfHtf: -1, newsScore: -0.5, newsRisk: 0.5, fng: 20 } });
  assert.equal(lowCf.confluence, 40);
  assert.equal(lowCf.htfAlign, -1);
  assert.equal(lowCf.newsScore, -0.5, "a long's news score keeps its sign");
  assert.equal(lowCf.mk_low_confluence, "yes");
  assert.equal(lowCf.mk_htf_conflict, "yes");
  assert.equal(lowCf.mk_bad_news, "yes");
  assert.equal(lowCf.mk_event_risk, "yes");
  const short = entryFeatures({ side: "short", entry: 100, stop: 102, symbol: "BTCUSDT", at, indicators: { newsScore: -0.5 } });
  assert.equal(short.newsScore, 0.5, "bearish news supports a short");
  // Reviews list the tags next to the sentences.
  const rv = reviewTrade(aTrade(0, -1, { entry_indicators: { close: 100, ema200: 102, atr14: 2, adx14: 14 } }));
  assert.ok(rv.tags!.includes("weak_trend") && rv.tags!.includes("counter_trend") && rv.tags!.includes("noise_stop"));
  assert.equal(rv.tags!.length, rv.flags.length);
});

test("a recurring named mistake is learned with fewer trades than a blind threshold search needs", () => {
  // 26 entries: too few for a threshold search (30), enough for the 13 pre-named mistakes (20).
  // Entries with a stop inside the noise (every third one) always lose; the rest win 60% at 2R.
  const list = Array.from({ length: 26 }, (_, i) => {
    const noisy = i % 3 === 0;
    return aTrade(i, noisy ? -1 : i % 5 < 3 ? 2 : -1, { entry_indicators: { close: 100, ema200: 98, atr14: noisy ? 1.6 : 0.8, adx14: 30, volumeX: 1.4 } });
  });
  const mined = mineLessons(list, new Set());
  const scoped = mined.find((m) => m.timeframe === "1h")!;
  assert.ok(scoped, "a lesson for macd_adx 1h");
  assert.equal(scoped.rule.feature, "mk_noise_stop");
  assert.equal(scoped.rule.op, "eq");
  assert.equal(scoped.rule.value, "yes");
  assert.match(scoped.title, /skip entries when the entry shows the mistake "stop inside the noise"/);
  // Only the entries showing the mistake are ever candidates for blocking, never the ones without it.
  assert.ok(!candidateRules(list).some((r) => r.feature.startsWith("mk_") && r.value === "no"));
  // With 15 entries nothing is learned, whatever the pattern.
  assert.equal(mineLessons(list.slice(0, 15), new Set()).length, 0);
});

test("signals the bots skipped are learning data, so a bot that trades little still learns", () => {
  // 12 real trades, all passing the gate. 30 skipped signals: the low-confluence ones lost, the others did fine.
  const real = Array.from({ length: 12 }, (_, i) => aTrade(i * 6, i % 3 ? 1.5 : -1, { entry_indicators: { close: 100, ema200: 98, atr14: 0.8, adx14: 30, cfScore: 70 + (i % 4) * 5 } }));
  const shadow: ShadowSignal[] = Array.from({ length: 36 }, (_, i) => {
    const low = i % 2 === 0;
    return {
      strategy: "macd_adx",
      timeframe: "1h",
      reason: low ? "confluence" : "lesson",
      outcome_r: low ? -1 : i % 4 === 1 ? 1.8 : -0.4,
      signal_bar_time: new Date(T0 + i * 12 * H + H).toISOString(),
      features: { side: "long", symbol: "BTCUSDT", stopAtr: 1.5, adx14: 30, confluence: low ? 35 + (i % 5) * 4 : 72 + (i % 4) * 5 },
    };
  });
  assert.equal(mineLessons(real, new Set()).length, 0, "12 trades alone teach nothing");
  const mined = mineLessons(real, new Set(), [], shadow).find((m) => m.timeframe === "1h");
  assert.ok(mined, "trades plus skipped signals do");
  assert.ok(["confluence", "mk_low_confluence"].includes(mined.rule.feature), mined.rule.feature);
  assert.ok(mined.evidence.passed);
  // The same shadow data is used when a rule is re-checked (promotion of a waiting lesson).
  assert.equal(evaluateRule(real, mined.rule, shadow).passed, true);
  assert.equal(evaluateRule(real, mined.rule).passed, false);
});

test("lessons together may not filter a bot out of trading", () => {
  // Half the entries are ETH (already blocked by a lesson in force); 10 of the 40 BTC entries are weak-trend losers.
  const list = Array.from({ length: 80 }, (_, i) => {
    const eth = i % 2 === 1;
    const weak = !eth && (i / 2) % 4 === 0;
    const r = weak ? -1 : i % 5 < 3 ? 2 : -1;
    return aTrade(i, r, { symbol: eth ? "ETHUSDT" : "BTCUSDT", entry_indicators: { close: 100, ema200: 98, atr14: 0.8, adx14: weak ? 12 + (i % 5) : 24 + (i % 9), volumeX: 1.4 } });
  });
  const onlyAdx = (xs: ReturnType<typeof mineLessons>) => xs.filter((m) => m.timeframe === "1h" && (m.rule.feature === "adx14" || m.rule.feature === "mk_weak_trend"));
  assert.equal(onlyAdx(mineLessons(list, new Set())).length, 1, "learnable on its own");
  const eth = { strategy: "macd_adx", timeframe: "1h" as string | null, feature: "symbol", op: "eq" as const, value: "ETHUSDT" };
  assert.equal(onlyAdx(mineLessons(list, new Set(), [eth])).length, 0, "50% already blocked + 12% more is over the 60% limit");
});

test("lessons are judged by the entries before and after they switched on", () => {
  const since = new Date(T0 + 30 * 7 * H).toISOString();
  const list = Array.from({ length: 50 }, (_, i) => aTrade(i, i < 30 ? -0.5 : 1));
  const rows = lessonImpact(list, [{ strategy: "macd_adx", timeframe: null, status: "active", activated_at: since }, { strategy: "donchian", timeframe: "1h", status: "active", activated_at: since }], [{ strategy: "macd_adx", timeframe: "1h" }, { strategy: "macd_adx", timeframe: "4h" }]);
  assert.equal(rows.length, 2, "only setups with an active lesson");
  const r = rows.find((x) => x.timeframe === "1h")!;
  assert.equal(r.before.n, 30);
  assert.equal(r.after.n, 20);
  assert.ok(r.before.avgR! < 0 && r.after.avgR! > 0);
  assert.equal(r.lessons, 1);
  assert.equal(lessonImpact(list, [{ strategy: "macd_adx", timeframe: null, status: "retired", activated_at: since }], [{ strategy: "macd_adx", timeframe: "1h" }]).length, 0);
});

test("mistake statistics rank the mistakes by what they cost", () => {
  const list = Array.from({ length: 40 }, (_, i) => {
    const noisy = i % 2 === 0;
    return aTrade(i, noisy ? -1 : 1, { entry_indicators: { close: 100, ema200: 98, atr14: noisy ? 1.6 : 0.8, adx14: 30, volumeX: 1.4 } });
  });
  const stats = tagStats(list);
  const noise = stats.find((x) => x.tag === "noise_stop")!;
  assert.equal(noise.withN, 20);
  assert.equal(noise.withoutN, 20);
  assert.ok(noise.withAvgR! < noise.withoutAvgR!);
  assert.ok(noise.costR > 30, `costR ${noise.costR}`);
  assert.equal(stats[0].tag, "noise_stop", "the costliest comes first");
  assert.ok(!stats.some((x) => x.withN === 0));
});

test("a replayed signal reports R after slippage, and is followed for about a week", () => {
  const noManage: StrategyDef = { key: "t", name: "t", version: 1, summary: "", rules: "", params: {}, warmup: 0, entry: () => null, manage: () => ({}) };
  const c = (i: number, o: number, h: number, l: number, cl: number): Candle => ({ time: i * 3600, open: o, high: h, low: l, close: cl, volume: 1 });
  const sim = simulateSignal(noManage, [c(0, 100, 100, 100, 100), c(1, 100, 101, 99.5, 100.8), c(2, 100.8, 102.2, 100.5, 102)], 0, { side: "long", entry: 100, stop: 99, takeProfit: 102 });
  const risk = 1 + 100 * TAKER_FEE + 99 * TAKER_FEE;
  assert.ok(Math.abs(sim.r - sim.rSlip - (SLIPPAGE * 202) / risk) < 2e-3, `fees-only ${sim.r} vs slipped ${sim.rSlip}`);
  assert.ok(sim.rSlip < sim.r);
  assert.equal(replayBars(300), 200);
  assert.equal(replayBars(3600), 168);
  assert.equal(replayBars(14400), 42);
  assert.equal(replayBars(86400), 24);
});
