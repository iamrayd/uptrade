import { test } from "node:test";
import assert from "node:assert/strict";
import { runAnalysis, type Narrator } from "../../supabase/functions/_shared/bot/analyze.ts";
import { STRATEGIES } from "../../supabase/functions/_shared/bot/strategies.ts";
import { TIMEFRAMES } from "../../supabase/functions/_shared/bot/types.ts";
import { fakeMarket, freshDb, pgAnalysisDb, pgDb, syntheticMinutes, USER, OTHER_USER } from "./helpers.ts";

const DAY = 86400;
const H = 3600;
const START = 1_760_000_000 - (1_760_000_000 % DAY); // UTC midnight
const PRICE: Record<string, number> = { BTCUSDT: 60000, ETHUSDT: 3000 };

test("analysis: reviews, learns a lesson from the losers, writes reports, and retires lessons that cost money", { timeout: 300_000 }, async () => {
  const pg = await freshDb();
  await pg.query(`insert into auth.users (id) values ($1), ($2)`, [USER, OTHER_USER]);
  await pg.query(`insert into public.bot_settings (user_id) values ($1)`, [USER]);
  const db = pgDb(pg);
  await db.sync(STRATEGIES.map(({ key, name, version, summary, rules, params }) => ({ key, name, version, summary, rules, params })), TIMEFRAMES);
  const acc = (await pg.query<{ id: string }>(`select id from public.bot_accounts where strategy = 'ema_trend' and timeframe = '1h'`)).rows[0];

  // 60 closed ema_trend 1h trades, one every 7 hours: entries with ADX under 20 always lose,
  // the rest win 60% of the time at +2R. Stop 1% away, $1 risk, so net PnL ($) = R.
  for (let i = 0; i < 60; i++) {
    const symbol = i % 2 ? "ETHUSDT" : "BTCUSDT";
    const entry = PRICE[symbol];
    const stop = entry * 0.99;
    const qty = 1 / (entry - stop);
    const weak = i % 3 === 0;
    const r = weak ? -1 : i % 5 < 3 ? 2 : -1;
    const opened = START + DAY + i * 7 * H;
    const closed = opened + 3 * H;
    const exit = entry + r * (entry - stop);
    await pg.query(
      `insert into public.bot_trades (user_id, account_id, strategy, timeframe, symbol, side, status, qty, entry_price, leverage, margin, liq_price,
         initial_stop, stop_price, take_profit, risk_usd, risk_pct, entry_fee, signal_bar_time, opened_at, entry_reason, entry_indicators,
         checked_until, mfe_price, mae_price, exit_price, exit_fee, closed_at, exit_reason, exit_note, realized_pnl, net_pnl, r_multiple)
       values ($1, $2, 'ema_trend', '1h', $3, 'long', 'closed', $4, $5, 5, 10, 1, $6, $6, $7, 1, 0.01, 0, to_timestamp($8), to_timestamp($9),
         'test', $10::jsonb, to_timestamp($11), $12, $13, $14, 0, to_timestamp($11), $15, 'Stop hit.', $16, $16, $16)`,
      [USER, acc.id, symbol, qty, entry, stop, entry * 1.02, opened - H, opened,
       JSON.stringify({ close: entry, ema200: entry * 0.98, atr14: entry * 0.008, adx14: weak ? 12 + (i % 5) : 24 + (i % 9), rsi: weak ? 30 + (i % 4) : 45 + (i % 11) }),
       closed, r > 0 ? exit : entry * 1.001, r > 0 ? entry * 0.998 : stop, exit, r > 0 ? "take_profit" : "stop_loss", r],
    );
  }

  const minutes = { BTCUSDT: syntheticMinutes(1, START, 22 * 1440, 60000), ETHUSDT: syntheticMinutes(2, START, 22 * 1440, 3000) };
  let nowMs = (START + 21 * DAY + 30 * 60) * 1000;
  const market = fakeMarket(minutes, () => nowMs, { BTCUSDT: 0.00001, ETHUSDT: 0.0001 });
  const adb = pgAnalysisDb(pg);
  const calls: string[] = [];
  const narrator: Narrator = async ({ kind, data }) => {
    calls.push(kind);
    assert.ok(data.setups.length === STRATEGIES.length * TIMEFRAMES.length);
    return {
      model: "test-model",
      narrative: {
        headline: `AI ${kind}`,
        summary: ["s"],
        ranking_notes: [],
        mistakes: [],
        improvements: [],
        caveats: [],
        // One idea the data backs up, one already learned, one it doesn't back up, one with an unknown feature.
        candidate_filters: [
          { strategy: "ema_trend", timeframe: "1h", feature: "rsi", op: "lt", value: "40", reason: "weak momentum" },
          { strategy: "ema_trend", timeframe: null, feature: "adx14", op: "lt", value: "20", reason: "weak trends" },
          { strategy: "ema_trend", timeframe: "1h", feature: "symbol", op: "eq", value: "ETHUSDT", reason: "eth" },
          { strategy: "ema_trend", timeframe: "1h", feature: "moon_phase", op: "eq", value: "full", reason: "?" },
        ],
      },
    };
  };

  const s1 = await runAnalysis({ market, db: adb, now: () => nowMs, narrator });
  assert.deepEqual(s1.errors, []);
  assert.equal(s1.reviewed, 60);
  assert.equal(s1.aiCalls, 1, "one AI write-up per run");
  assert.deepEqual(calls, ["daily"]);
  assert.deepEqual(s1.reports.sort(), ["daily", "hourly"], "weekly and monthly wait for the next run's AI budget");

  // Every trade has a review; the losers say why.
  const rv = (await pg.query<{ review: { category: string; why: string; fix: string } }>(`select review from public.bot_trades where r_multiple < 0`)).rows;
  assert.ok(rv.every((x) => x.review && x.review.why.length > 10 && x.review.fix.length > 10));

  // The low-ADX pattern was learned for the setup and for the strategy as a whole, and switched on.
  const lessons = (await pg.query<{ id: string; timeframe: string | null; feature: string; op: string; value: number; status: string; source: string }>(
    `select id, timeframe, feature, op, value, status, source from public.bot_lessons order by source`,
  )).rows;
  const mined = lessons.find((l) => l.source === "mined" && l.timeframe === "1h");
  assert.ok(mined, JSON.stringify(lessons));
  assert.equal(mined.feature, "adx14");
  assert.equal(mined.op, "lt");
  assert.equal(mined.status, "active");
  assert.ok(lessons.some((l) => l.source === "mined" && l.timeframe == null && l.feature === "adx14"));
  const ai = lessons.filter((l) => l.source === "ai");
  assert.deepEqual(ai.map((l) => [l.feature, l.op, l.status]), [["rsi", "lt", "active"]], "only the new, backed-up AI idea becomes a lesson");
  assert.ok(!lessons.some((l) => l.feature === "symbol" || l.feature === "moon_phase"), "unsupported ideas are dropped");

  const daily = (await pg.query<{ data: { period: { trades: number }; rankings: { best: { strategy: string }[] }; lessons: { new: unknown[] }; mistakes: { bySetup: unknown[] } }; narrative: { headline: string }; ai_model: string }>(
    `select data, narrative, ai_model from public.bot_reports where kind = 'daily'`,
  )).rows[0];
  assert.equal(daily.ai_model, "test-model");
  assert.equal(daily.narrative.headline, "AI daily");
  assert.equal(daily.data.rankings.best[0].strategy, "ema_trend");
  assert.ok(daily.data.lessons.new.length >= 2);
  assert.ok(daily.data.mistakes.bySetup.length >= 1);

  // The live engine sees active lessons.
  const st = await db.getState();
  assert.ok(st.lessons!.some((l) => l.id === mined.id));

  // Next run: the weekly report gets its write-up; nothing is reviewed or learned twice.
  const s2 = await runAnalysis({ market, db: adb, now: () => nowMs, narrator });
  assert.deepEqual(s2.reports, ["weekly"]);
  assert.equal(s2.reviewed, 0);
  assert.equal(s2.lessonsNew, 0);

  // Blocked signals get replayed. With 7 earlier blocked signals that would have made
  // +5R between them, one more pushes the lesson past the retirement bar.
  await pg.query(`update public.bot_lessons set blocked = 7, blocked_r = 5 where id = $1`, [mined.id]);
  const barSec = START + 15 * DAY + 5 * H;
  await db.logFiltered([{
    account_id: acc.id, reason: "lesson", lesson_ids: [mined.id], symbol: "BTCUSDT", side: "long", entry_price: minutes.BTCUSDT[(barSec + H - START) / 60].open,
    stop_price: minutes.BTCUSDT[(barSec + H - START) / 60].open * 0.99, take_profit: minutes.BTCUSDT[(barSec + H - START) / 60].open * 1.02,
    signal_bar_time: new Date(barSec * 1000).toISOString(), features: { adx14: 10 },
  }]);
  nowMs += 3600_000;
  const s3 = await runAnalysis({ market, db: adb, now: () => nowMs, narrator: null });
  assert.equal(s3.signalsResolved, 1);
  const sig = (await pg.query<{ outcome_r: string; outcome_note: string }>(`select outcome_r, outcome_note from public.bot_filtered_signals`)).rows[0];
  assert.ok(sig.outcome_r != null && sig.outcome_note.startsWith("Would have closed"));
  const after = (await pg.query<{ status: string; blocked: number; retired_reason: string }>(`select status, blocked, retired_reason from public.bot_lessons where id = $1`, [mined.id])).rows[0];
  assert.equal(after.blocked, 8);
  assert.equal(after.status, "retired");
  assert.match(after.retired_reason, /costing money/);

  // Row-level security: users read only their own lessons and reports, and change only their own lessons' status.
  const asUser = async (uid: string, sql: string, params: unknown[] = []) =>
    pg.transaction(async (tx) => {
      await tx.exec(`set local role authenticated; select set_config('request.jwt.claim.sub', '${uid}', true);`);
      return (await tx.query(sql, params)).rows;
    });
  assert.ok((await asUser(USER, `select id from public.bot_reports`)).length >= 3);
  assert.equal((await asUser(OTHER_USER, `select id from public.bot_reports`)).length, 0);
  assert.equal((await asUser(OTHER_USER, `select id from public.bot_lessons`)).length, 0);
  await assert.rejects(asUser(OTHER_USER, `select public.bot_set_lesson_status($1, 'active')`, [mined.id]), /not found/);
  await assert.rejects(asUser(USER, `select public.bot_set_lesson_status($1, 'retired')`, [mined.id]), /invalid status/);
  await asUser(USER, `select public.bot_set_lesson_status($1, 'rejected')`, [mined.id]);
  assert.equal((await pg.query<{ status: string }>(`select status from public.bot_lessons where id = $1`, [mined.id])).rows[0].status, "rejected");
  for (const fn of [`select public.bot_analysis_state()`, `select public.bot_save_report('{}'::jsonb)`, `select public.bot_log_filtered('[]'::jsonb)`])
    await assert.rejects(asUser(USER, fn), /permission denied/, fn);
});
