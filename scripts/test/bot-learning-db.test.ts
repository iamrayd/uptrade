import { test } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";
import { runAnalysis } from "../../supabase/functions/_shared/bot/analyze.ts";
import { runTick } from "../../supabase/functions/_shared/bot/tick.ts";
import { STRATEGIES } from "../../supabase/functions/_shared/bot/strategies.ts";
import { TF_SECONDS, TIMEFRAMES } from "../../supabase/functions/_shared/bot/types.ts";
import { fakeMarket, freshDb, pgAnalysisDb, pgDb, syntheticMinutes, USER } from "./helpers.ts";

const DAY = 86400;
const H = 3600;
const START = 1_760_000_000 - (1_760_000_000 % DAY); // UTC midnight
const PRICE: Record<string, number> = { BTCUSDT: 60000, ETHUSDT: 3000 };
const metaOf = STRATEGIES.map(({ key, name, version, summary, rules, params }) => ({ key, name, version, summary, rules, params }));

async function setup() {
  const pg = await freshDb();
  await pg.query(`insert into auth.users (id) values ($1)`, [USER]);
  await pg.query(`insert into public.bot_settings (user_id) values ($1)`, [USER]);
  await pgDb(pg).sync(metaOf, TIMEFRAMES);
  return pg;
}
const account = async (pg: PGlite, strategy: string, tf: string) =>
  (await pg.query<{ id: string }>(`select id from public.bot_accounts where strategy = $1 and timeframe = $2`, [strategy, tf])).rows[0].id;

/** A closed long trade, 1% stop, $1 risk, so net PnL ($) = R. */
async function insertTrade(pg: PGlite, accId: string, strategy: string, i: number, r: number, indicators: Record<string, number>, symbol = i % 2 ? "ETHUSDT" : "BTCUSDT") {
  const entry = PRICE[symbol];
  const stop = entry * 0.99;
  const qty = 1 / (entry - stop);
  const opened = START + DAY + i * 7 * H;
  const closed = opened + 3 * H;
  const exit = entry + r * (entry - stop);
  await pg.query(
    `insert into public.bot_trades (user_id, account_id, strategy, timeframe, symbol, side, status, qty, entry_price, leverage, margin, liq_price,
       initial_stop, stop_price, take_profit, risk_usd, risk_pct, entry_fee, signal_bar_time, opened_at, entry_reason, entry_indicators,
       checked_until, mfe_price, mae_price, exit_price, exit_fee, closed_at, exit_reason, exit_note, realized_pnl, net_pnl, r_multiple)
     values ($1, $2, $3, '1h', $4, 'long', 'closed', $5, $6, 5, 10, 1, $7, $7, $8, 1, 0.01, 0, to_timestamp($9), to_timestamp($10),
       'test', $11::jsonb, to_timestamp($12), $13, $14, $15, 0, to_timestamp($12), $16, 'Stop hit.', $17, $17, $17)`,
    [USER, accId, strategy, symbol, qty, entry, stop, entry * 1.02, opened - H, opened, JSON.stringify({ close: entry, ema200: entry * 0.98, atr14: entry * 0.008, ...indicators }),
      closed, r > 0 ? exit : entry * 1.001, r > 0 ? entry * 0.998 : stop, exit, r > 0 ? "take_profit" : "stop_loss", r],
  );
}

/** A signal that was not traded, already replayed. */
async function insertShadow(pg: PGlite, accId: string, strategy: string, i: number, reason: string, outcomeR: number | null, features: Record<string, unknown>, lessonIds: string[] = []) {
  const bar = START + DAY + i * 12 * H;
  const entry = PRICE.BTCUSDT;
  await pg.query(
    `insert into public.bot_filtered_signals (user_id, account_id, lesson_ids, strategy, timeframe, symbol, side, entry_price, stop_price, take_profit,
       signal_bar_time, features, reason, outcome_r, outcome_note, resolved_at)
     values ($1, $2, $3::uuid[], $4, '1h', 'BTCUSDT', 'long', $5, $6, $7, to_timestamp($8), $9::jsonb, $10, $11, 'replayed', ${outcomeR == null ? "null" : "now()"})`,
    [USER, accId, `{${lessonIds.join(",")}}`, strategy, entry, entry * 0.99, entry * 1.02, bar, JSON.stringify(features), reason, outcomeR],
  );
}

test("analysis keeps learning: waiting lessons go live, lessons that stopped working retire, skipped signals are replayed in batches and teach", { timeout: 300_000 }, async () => {
  const pg = await setup();
  const adb = pgAnalysisDb(pg);
  const ema = await account(pg, "ema_trend", "1h");
  const don = await account(pg, "donchian", "1h");

  // 60 ema_trend trades: ADX under 20 always loses, the rest win 60% at +2R.
  for (let i = 0; i < 60; i++) {
    const weak = i % 3 === 0;
    await insertTrade(pg, ema, "ema_trend", i, weak ? -1 : i % 5 < 3 ? 2 : -1, { adx14: weak ? 12 + (i % 5) : 24 + (i % 9), rsi: weak ? 30 + (i % 4) : 45 + (i % 11), cfScore: 75 });
  }
  const lesson = async (feature: string, op: string, value: unknown, paused: boolean, strategy = "ema_trend") =>
    (await pg.query<{ id: string }>(
      `insert into public.bot_lessons (user_id, strategy, timeframe, feature, op, value, status, title, explanation, paused)
       values ($1, $2, '1h', $3, $4, $5::jsonb, 'proposed', $3, 'test', $6) returning id`,
      [USER, strategy, feature, op, JSON.stringify(value), paused],
    )).rows[0].id;
  const waiting = await lesson("adx14", "lt", 20, false); // holds on the data, was only waiting for room
  const pausedByOwner = await lesson("rsi", "lt", 40, true); // holds too, but the owner paused it
  const refuted = await lesson("symbol", "eq", "ETHUSDT", false); // does not hold

  const minutes = { BTCUSDT: syntheticMinutes(1, START, 22 * 1440, 60000), ETHUSDT: syntheticMinutes(2, START, 22 * 1440, 3000) };
  const nowMs = (START + 21 * DAY + 30 * 60) * 1000;
  const market = fakeMarket(minutes, () => nowMs, { BTCUSDT: 0.00001, ETHUSDT: 0.0001 });
  const status = async (id: string) => (await pg.query<{ status: string; paused: boolean; activated_at: string | null }>(`select status, paused, activated_at from public.bot_lessons where id = $1`, [id])).rows[0];

  const s1 = await runAnalysis({ market, db: adb, now: () => nowMs, narrator: null });
  assert.deepEqual(s1.errors, []);
  assert.equal(s1.lessonsPromoted, 1);
  assert.equal((await status(waiting)).status, "active");
  assert.ok((await status(waiting)).activated_at, "activation time is recorded");
  assert.equal((await status(pausedByOwner)).status, "proposed", "a lesson the owner paused is not switched back on");
  assert.equal((await status(refuted)).status, "proposed", "a lesson that no longer holds on the data stays waiting");

  // The report says whether entries improved, which mistakes cost the most, and what the gate skipped.
  const daily = (await pg.query<{ data: { learning: { impact: unknown[]; tags: { tag: string; costR: number }[]; replayed: unknown[]; gate: { skippedN: number; tradedN: number } } } }>(`select data from public.bot_reports where kind = 'daily'`)).rows[0];
  assert.ok(daily.data.learning, "reports carry a learning section");
  assert.ok(daily.data.learning.tags.length > 0 && daily.data.learning.tags[0].costR > 0);
  assert.equal(daily.data.learning.gate.tradedN, 60);

  // A lesson's lifetime record is fine (−0.6R per blocked signal) but its latest 12 blocked signals would have made money: retire it.
  await pg.query(`update public.bot_lessons set blocked = 20, blocked_r = -12 where id = $1`, [waiting]);
  for (let i = 0; i < 12; i++) await insertShadow(pg, ema, "ema_trend", 100 + i, "lesson", 0.4, { adx14: 15 }, [waiting]);
  const s2 = await runAnalysis({ market, db: adb, now: () => nowMs, narrator: null });
  assert.equal(s2.lessonsRetired, 1);
  const gone = (await pg.query<{ status: string; retired_reason: string }>(`select status, retired_reason from public.bot_lessons where id = $1`, [waiting])).rows[0];
  assert.equal(gone.status, "retired");
  assert.match(gone.retired_reason, /latest 12 signals/);
  assert.match(gone.retired_reason, /costing money/);

  // 30 signals the gate skipped on one coin and timeframe are replayed with a handful of candle requests, not 30.
  const barAt = (k: number) => START + 2 * DAY + k * 5 * H;
  const minuteIdx = (sec: number) => (sec + H - START) / 60;
  for (let k = 0; k < 30; k++) {
    const px = minutes.BTCUSDT[minuteIdx(barAt(k))].open;
    await pg.query(
      `insert into public.bot_filtered_signals (user_id, account_id, lesson_ids, strategy, timeframe, symbol, side, entry_price, stop_price, take_profit, signal_bar_time, features, reason)
       values ($1, $2, '{}', 'ema_trend', '1h', 'BTCUSDT', 'long', $3, $4, $5, to_timestamp($6), '{"adx14": 30}'::jsonb, 'confluence')`,
      [USER, ema, px, px * 0.99, px * 1.02, barAt(k)],
    );
  }
  const callsBefore = market.calls;
  const s3 = await runAnalysis({ market, db: adb, now: () => nowMs, narrator: null });
  assert.deepEqual(s3.errors, []);
  assert.ok(s3.signalsResolved >= 25, `replayed ${s3.signalsResolved}`);
  assert.ok(market.calls - callsBefore <= 8, `${market.calls - callsBefore} candle requests for 30 signals`);
  const replayed = (await pg.query<{ n: number; with_r: number }>(`select count(*)::int n, count(outcome_r)::int with_r from public.bot_filtered_signals where reason = 'confluence' and resolved_at is not null`)).rows[0];
  assert.equal(replayed.n, s3.signalsResolved);
  assert.equal(replayed.with_r, replayed.n);
  // Skipped signals that are not a lesson's are never credited to a lesson.
  assert.equal((await pg.query<{ blocked: number }>(`select blocked from public.bot_lessons where id = $1`, [waiting])).rows[0].blocked, 20);

  // A bot with only 12 trades of its own learns from 36 signals the gate skipped: they are data too.
  for (let i = 0; i < 12; i++) await insertTrade(pg, don, "donchian", i * 4, i % 3 ? 1.5 : -1, { adx14: 30, cfScore: 70 + (i % 4) * 5 });
  for (let i = 0; i < 36; i++) {
    const low = i % 2 === 0;
    await insertShadow(pg, don, "donchian", i * 0.9, "confluence", low ? -1 : i % 4 === 1 ? 1.8 : -0.4, { side: "long", symbol: "BTCUSDT", stopAtr: 1.25, adx14: 30, confluence: low ? 35 + (i % 5) * 4 : 72 + (i % 4) * 5 });
  }
  const s4 = await runAnalysis({ market, db: adb, now: () => nowMs, narrator: null });
  assert.ok(s4.lessonsNew >= 1);
  const learned = (await pg.query<{ feature: string; status: string; source: string }>(`select feature, status, source from public.bot_lessons where strategy = 'donchian'`)).rows;
  assert.ok(learned.some((l) => ["confluence", "mk_low_confluence"].includes(l.feature) && l.status === "active" && l.source === "mined"), JSON.stringify(learned));
});

test("engine: a busted bot keeps learning, news twins wait out events, losses cool a bot down", { timeout: 600_000 }, async () => {
  const pg = await setup();
  const db = pgDb(pg);
  const minutes = {
    BTCUSDT: syntheticMinutes(1, START, 22 * 1440, 60000),
    ETHUSDT: syntheticMinutes(2, START, 22 * 1440, 3000),
    SOLUSDT: syntheticMinutes(3, START, 22 * 1440, 150),
  };
  let nowMs = 0;
  const market = fakeMarket(minutes, () => nowMs, { BTCUSDT: 0.00001, ETHUSDT: 0.0001, SOLUSDT: 0.001 });

  // supertrend 15m is busted; the news data says a major event hit BTC and is fresh the whole time.
  const busted = await account(pg, "supertrend", "15m");
  await pg.query(`update public.bot_accounts set status = 'busted', balance = 5 where id = $1`, [busted]);
  const saveNews = (fetchedAt: number) =>
    pg.query(`select public.bot_save_news($1::jsonb)`, [
      JSON.stringify({
        data: {
          fetchedAt,
          fng: { value: 20, label: "Extreme Fear" },
          sources: ["test"],
          errors: [],
          scopes: {
            BTC: { score: -0.2, risk: 0.9, n: 1, top: [{ title: "Exchange hacked", source: "test", at: fetchedAt, sentiment: -0.6, risk: 1 }] },
            ETH: { score: 0, risk: 0, n: 0, top: [] },
            SOL: { score: 0, risk: 0, n: 0, top: [] },
            MARKET: { score: 0, risk: 0, n: 0, top: [] },
          },
        },
      }),
    ]);

  const simStart = START + 18 * DAY;
  let ticks = 0;
  for (let t = simStart + 60; t < START + 21 * DAY; t += 300) {
    nowMs = t * 1000;
    await saveNews(nowMs);
    const s = await runTick({ market, db, now: () => nowMs, minConfluence: 50 });
    assert.deepEqual(s.errors, [], `tick errors at ${new Date(nowMs).toISOString()}`);
    ticks++;
  }
  assert.ok(ticks > 700);

  const trades = (await pg.query<Record<string, unknown>>(`select * from public.bot_trades order by opened_at`)).rows;
  assert.ok(trades.length >= 10, `only ${trades.length} trades`);
  assert.ok(trades.every((t) => typeof (t.entry_indicators as Record<string, number>).newsRisk === "number"), "every trade stores the news reading it was taken with");

  // Busted: no trades, but its signals are kept for replay.
  assert.equal(trades.filter((t) => t.account_id === busted).length, 0);
  const shadows = (await pg.query<{ account_id: string; reason: string; strategy: string; symbol: string }>(`select account_id, reason, strategy, symbol from public.bot_filtered_signals`)).rows;
  assert.ok(shadows.filter((s) => s.account_id === busted && s.reason === "busted").length > 0, "the busted bot's signals are kept");

  // News twins: no BTC entries while the event is fresh; the plain twins trade BTC; ETH/SOL are not held back.
  const twin = (t: Record<string, unknown>) => String(t.strategy).endsWith("_news");
  assert.equal(trades.filter((t) => twin(t) && t.symbol === "BTCUSDT").length, 0);
  assert.ok(trades.filter((t) => !twin(t) && t.symbol === "BTCUSDT").length > 0, "plain bots still trade BTC");
  assert.ok(trades.filter((t) => twin(t) && t.symbol !== "BTCUSDT").length > 0, "news twins still trade the coins without news");
  const heldBack = shadows.filter((s) => s.reason === "news");
  assert.ok(heldBack.length > 0 && heldBack.every((s) => s.strategy.endsWith("_news") && s.symbol === "BTCUSDT"));
  assert.ok(trades.filter(twin).every((t) => String(t.entry_reason).includes("News is no obstacle")), "a twin's journal says what the news was");
  assert.ok(trades.filter((t) => !twin(t)).every((t) => !String(t.entry_reason).includes("News is no obstacle")));

  // Cooldown: after a loss on a coin, the next entry on it waits at least 3 bars.
  const bySeries = new Map<string, typeof trades>();
  for (const t of trades) bySeries.set(`${t.account_id}:${t.symbol}`, [...(bySeries.get(`${t.account_id}:${t.symbol}`) ?? []), t]);
  let checked = 0;
  for (const list of bySeries.values()) {
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1];
      if (prev.status !== "closed" || (prev.r_multiple as number) > -0.1) continue;
      const wait = +new Date(list[i].opened_at as string) - +new Date(prev.closed_at as string);
      assert.ok(wait >= 3 * TF_SECONDS[prev.timeframe as keyof typeof TF_SECONDS] * 1000 - 1000, `re-entered ${wait / 60000} min after a loss on a ${prev.timeframe} bot`);
      checked++;
    }
  }
  assert.ok(checked > 0, "the run had losses followed by new entries to check");
  assert.ok(shadows.some((s) => s.reason === "cooldown"), "cooldown skips are kept too");
});
