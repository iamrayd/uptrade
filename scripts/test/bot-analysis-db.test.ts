import { test } from "node:test";
import assert from "node:assert/strict";
import { runAnalysis, type Narrator, type ReportData } from "../../supabase/functions/_shared/bot/analyze.ts";
import { strategyMeta } from "../../supabase/functions/_shared/bot/io.ts";
import { STRATEGIES } from "../../supabase/functions/_shared/bot/strategies.ts";
import { TIMEFRAMES } from "../../supabase/functions/_shared/bot/types.ts";
import { fakeMarket, freshDb, pgAnalysisDb, pgDb, syntheticMinutes, USER, OTHER_USER } from "./helpers.ts";

const DAY = 86400;
const H = 3600;
const START = 1_760_000_000 - (1_760_000_000 % DAY); // UTC midnight
const PRICE: Record<string, number> = { BTCUSDT: 60000, ETHUSDT: 3000 };

test("analysis: reviews every closed trade, scores each rule set, writes reports, and changes nothing about trading", { timeout: 300_000 }, async () => {
  const pg = await freshDb();
  await pg.query(`insert into auth.users (id) values ($1), ($2)`, [USER, OTHER_USER]);
  await pg.query(`insert into public.bot_settings (user_id) values ($1)`, [USER]);
  const db = pgDb(pg);
  await db.sync(strategyMeta(STRATEGIES), TIMEFRAMES);
  const account = async (strategy: string, timeframe: string) =>
    (await pg.query<{ id: string }>(`select id from public.bot_accounts where strategy = $1 and timeframe = $2`, [strategy, timeframe])).rows[0].id;

  // Closed trades, one every 7 hours. Stop 1% away, $1 risk, so net PnL ($) = R.
  //   fvg 1h:          60 trades, 3 of every 5 win +2R  → +0.8R a trade
  //   order_block 1h:  30 trades, 1 of every 5 wins +2R → −0.4R a trade
  const insert = async (strategy: string, n: number, wins: (i: number) => boolean) => {
    const acc = await account(strategy, "1h");
    for (let i = 0; i < n; i++) {
      const symbol = i % 2 ? "ETHUSDT" : "BTCUSDT";
      const entry = PRICE[symbol];
      const stop = entry * 0.99;
      const qty = 1 / (entry - stop);
      const r = wins(i) ? 2 : -1;
      const opened = START + DAY + i * 7 * H;
      const closed = opened + 3 * H;
      const exit = entry + r * (entry - stop);
      await pg.query(
        `insert into public.bot_trades (user_id, account_id, strategy, timeframe, symbol, side, status, qty, entry_price, leverage, margin, liq_price,
           initial_stop, stop_price, take_profit, risk_usd, risk_pct, entry_fee, signal_bar_time, opened_at, entry_reason, entry_indicators,
           checked_until, mfe_price, mae_price, exit_price, exit_fee, closed_at, exit_reason, exit_note, realized_pnl, net_pnl, r_multiple)
         values ($1, $2, $3, '1h', $4, 'long', 'closed', $5, $6, 5, 10, 1, $7, $7, $8, 1, 0.01, 0, to_timestamp($9), to_timestamp($10),
           'test', $11::jsonb, to_timestamp($12), $13, $14, $15, 0, to_timestamp($12), $16, 'Stop hit.', $17, $17, $17)`,
        [USER, acc, strategy, symbol, qty, entry, stop, entry * 1.02, opened - H, opened, JSON.stringify({ close: entry, atr14: entry * 0.008 }),
         closed, r > 0 ? exit : entry * 1.001, r > 0 ? entry * 0.998 : stop, exit, r > 0 ? "take_profit" : "stop_loss", r],
      );
    }
  };
  await insert("fvg", 60, (i) => i % 5 < 3);
  await insert("order_block", 30, (i) => i % 5 === 0);

  const minutes = { BTCUSDT: syntheticMinutes(1, START, 22 * 1440, 60000), ETHUSDT: syntheticMinutes(2, START, 22 * 1440, 3000) };
  const nowMs = (START + 21 * DAY + 30 * 60) * 1000;
  const market = fakeMarket(minutes, () => nowMs, { BTCUSDT: 0.00001, ETHUSDT: 0.0001 });
  const adb = pgAnalysisDb(pg);
  const calls: string[] = [];
  const narrator: Narrator = async ({ kind, data }) => {
    calls.push(kind);
    assert.equal(data.setups.length, 15, "one setup per account");
    return { model: "test-model", narrative: { headline: `AI ${kind}`, summary: ["s"], ranking_notes: [], mistakes: [], improvements: [], caveats: [] } };
  };

  const balancesBefore = (await pg.query(`select id, balance, status from public.bot_accounts order by id`)).rows;
  const s1 = await runAnalysis({ market, db: adb, now: () => nowMs, narrator });
  assert.deepEqual(s1.errors, []);
  assert.equal(s1.reviewed, 90);
  assert.equal(s1.aiCalls, 1, "one AI write-up per run");
  assert.deepEqual(calls, ["daily"]);
  assert.deepEqual(s1.reports.sort(), ["daily", "hourly"], "weekly and monthly wait for the next run's AI budget");

  // Every trade has a review; the losers say why.
  const rv = (await pg.query<{ review: { category: string; why: string; fix: string } }>(`select review from public.bot_trades where r_multiple < 0`)).rows;
  assert.ok(rv.length > 0 && rv.every((x) => x.review && x.review.why.length > 10 && x.review.fix.length > 10));

  // The report ranks the rule sets: the table the owner decides from.
  const daily = (await pg.query<{ data: ReportData; narrative: { headline: string }; ai_model: string }>(`select data, narrative, ai_model from public.bot_reports where kind = 'daily'`)).rows[0];
  assert.equal(daily.ai_model, "test-model");
  assert.equal(daily.narrative.headline, "AI daily");
  assert.equal(daily.data.strategies.length, 5);
  assert.deepEqual(daily.data.strategies.slice(0, 2).map((x) => [x.strategy, x.trades, x.winRate, x.avgR]), [["fvg", 60, 60, 0.8], ["order_block", 30, 20, -0.4]]);
  assert.ok(daily.data.strategies.slice(2).every((x) => x.trades === 0));
  assert.equal(daily.data.rankings.best[0].strategy, "fvg");
  assert.ok(daily.data.mistakes.bySetup.length >= 1);
  assert.equal((daily.data as unknown as Record<string, unknown>).lessons, undefined);
  // The hourly report has no AI write-up: the built-in template names the rule sets.
  const hourly = (await pg.query<{ narrative: { summary: string[] }; ai_model: string | null }>(`select narrative, ai_model from public.bot_reports where kind = 'hourly'`)).rows[0];
  assert.equal(hourly.ai_model, null);
  assert.ok(hourly.narrative.summary.some((x) => x.includes("Fair Value Gap") && x.includes("Order Block")));

  // Verdicts are stored for the dashboard…
  assert.equal(s1.verdictsChanged, 15);
  const verdict = async (strategy: string) => (await pg.query<{ verdict: string }>(`select verdict from public.bot_accounts where strategy = $1 and timeframe = '1h'`, [strategy])).rows[0].verdict;
  assert.equal(await verdict("fvg"), "live_ready");
  assert.equal(await verdict("order_block"), "avoid");
  assert.equal(await verdict("ema_pullback"), "needs_data");
  // …and that is all the analyzer writes: no balance, status or setting changes, so a losing rule set keeps trading.
  assert.deepEqual((await pg.query(`select id, balance, status from public.bot_accounts order by id`)).rows, balancesBefore);
  const state = await db.getState();
  assert.equal(state.accounts.length, 15);
  assert.ok(state.accounts.every((a) => a.enabled && a.status === "active"));
  assert.deepEqual(Object.keys(state).sort(), ["accounts", "cursors", "open_trades"], "the engine reads nothing the analyzer could use to block a trade");

  // Next run: the weekly report gets its write-up; nothing is reviewed twice.
  const s2 = await runAnalysis({ market, db: adb, now: () => nowMs, narrator });
  assert.deepEqual(s2.reports, ["weekly"]);
  assert.equal(s2.reviewed, 0);
  assert.equal(s2.verdictsChanged, 0);

  // Row-level security: users read only their own reports; the analysis RPCs are service-role only.
  const asUser = async (uid: string, sql: string, params: unknown[] = []) =>
    pg.transaction(async (tx) => {
      await tx.exec(`set local role authenticated; select set_config('request.jwt.claim.sub', '${uid}', true);`);
      return (await tx.query(sql, params)).rows;
    });
  assert.ok((await asUser(USER, `select id from public.bot_reports`)).length >= 3);
  assert.equal((await asUser(OTHER_USER, `select id from public.bot_reports`)).length, 0);
  for (const fn of [`select public.bot_analysis_state()`, `select public.bot_save_report('{}'::jsonb)`, `select public.bot_save_verdicts('[]'::jsonb)`])
    await assert.rejects(asUser(USER, fn), /permission denied/, fn);
});
