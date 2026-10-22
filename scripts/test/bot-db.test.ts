import { test } from "node:test";
import assert from "node:assert/strict";
import { runTick } from "../../supabase/functions/_shared/bot/tick.ts";
import { closeMath, TAKER_FEE } from "../../supabase/functions/_shared/bot/risk.ts";
import { STRATEGIES } from "../../supabase/functions/_shared/bot/strategies.ts";
import { TIMEFRAMES } from "../../supabase/functions/_shared/bot/types.ts";
import { fakeMarket, freshDb, pgDb, syntheticMinutes, USER, OTHER_USER } from "./helpers.ts";

const DAY = 86400;
const START = 1_760_000_000 - (1_760_000_000 % DAY); // UTC midnight
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b));

test("bot engine: ticks over 4 simulated days keep the books exact", { timeout: 600_000 }, async () => {
  const pg = await freshDb();
  await pg.query(`insert into auth.users (id) values ($1), ($2)`, [USER, OTHER_USER]);
  await pg.query(`insert into public.bot_settings (user_id) values ($1)`, [USER]); // $100, 2%, 20x defaults

  const minutes = {
    BTCUSDT: syntheticMinutes(1, START, 22 * 1440, 60000),
    ETHUSDT: syntheticMinutes(2, START, 22 * 1440, 3000),
    SOLUSDT: syntheticMinutes(3, START, 22 * 1440, 150),
  };
  let nowMs = 0;
  const market = fakeMarket(minutes, () => nowMs, { BTCUSDT: 0.00001, ETHUSDT: 0.0001, SOLUSDT: 0.001 });
  const db = pgDb(pg);

  // An active lesson that blocks every Supertrend 15m entry (any stop distance ≥ 0).
  await db.sync(STRATEGIES.map(({ key, name, version, summary, rules, params }) => ({ key, name, version, summary, rules, params })), TIMEFRAMES);
  await pg.query(
    `insert into public.bot_lessons (user_id, strategy, timeframe, feature, op, value, status, title, explanation)
     values ($1, 'supertrend', '15m', 'stopPct', 'gte', '0', 'active', 'block all', 'test')`,
    [USER],
  );

  // Run every 5 minutes (+60s) for days 18–22, with one 20-hour outage on day 19.
  const simStart = START + 18 * DAY;
  const outage = [simStart + DAY + 3600, simStart + DAY + 21 * 3600];
  let ticks = 0;
  for (let t = simStart + 60; t < START + 22 * DAY - 300; t += 300) {
    if (t > outage[0] && t < outage[1]) continue;
    nowMs = t * 1000;
    const s = await runTick({ market, db, now: () => nowMs });
    assert.equal(s.skipped, undefined, `tick skipped: ${s.skipped}`);
    assert.deepEqual(s.errors, [], `tick errors at ${new Date(nowMs).toISOString()}`);
    ticks++;
  }
  assert.ok(ticks > 800);

  // 30 accounts (5 strategies × 6 timeframes), all for USER only.
  const accounts = (await pg.query<{ id: string; user_id: string; strategy: string; timeframe: string; balance: string; start_balance: string; status: string }>(
    `select * from public.bot_accounts`,
  )).rows;
  assert.equal(accounts.length, STRATEGIES.length * TIMEFRAMES.length);
  assert.ok(accounts.every((a) => a.user_id === USER));

  const trades = (await pg.query<Record<string, unknown>>(`select * from public.bot_trades order by opened_at`)).rows;
  const closed = trades.filter((t) => t.status === "closed");
  console.log(`  ${ticks} ticks, ${trades.length} trades (${closed.length} closed), market calls ${market.calls}`);
  assert.ok(closed.length >= 20, "expected plenty of closed trades");
  const reasons = new Set(closed.map((t) => t.exit_reason));
  for (const r of ["stop_loss", "take_profit", "signal"]) assert.ok(reasons.has(r), `no ${r} exits happened`);

  // Books: balance = start + Σ closed net − Σ open (margin + entry fee).
  for (const a of accounts) {
    const mine = trades.filter((t) => t.account_id === a.id);
    const closedNet = mine.filter((t) => t.status === "closed").reduce((s, t) => s + +(t.net_pnl as string), 0);
    const openCost = mine.filter((t) => t.status === "open").reduce((s, t) => s + +(t.margin as string) + +(t.entry_fee as string), 0);
    assert.ok(near(+a.balance, +a.start_balance + closedNet - openCost), `${a.strategy} ${a.timeframe}: books don't balance`);
    assert.ok(+a.balance >= 0);
  }

  for (const t of trades) {
    const side = t.side as "long" | "short";
    const entry = +(t.entry_price as string);
    const stop0 = +(t.initial_stop as string);
    // Stop on the right side at entry; liquidation beyond the stop.
    assert.ok(side === "long" ? stop0 < entry : stop0 > entry);
    for (const p of [stop0, t.take_profit == null ? null : +(t.take_profit as string)])
      if (p != null) assert.ok(Math.abs(p * 100 - Math.round(p * 100)) < 1e-6, `${p} is off the 0.01 tick`);
    const liq = +(t.liq_price as string);
    if (liq > 0) assert.ok(side === "long" ? liq < stop0 : liq > stop0, "liquidation must be beyond the stop");
    assert.ok(+(t.leverage as number) <= 20);
    assert.ok(+(t.risk_pct as string) <= 0.02 + 1e-9);
    // Entries only after the signal bar closed.
    assert.ok(new Date(t.opened_at as string).getTime() > new Date(t.signal_bar_time as string).getTime());
    assert.ok((t.entry_reason as string).length > 30);
    assert.ok(Object.keys(t.entry_indicators as object).length >= 3);
    // Trailing stops only ever tighten.
    let prev = stop0;
    for (const ev of t.stop_history as { from: number; to: number }[]) {
      assert.ok(side === "long" ? ev.to > prev : ev.to < prev, `stop didn't strictly tighten: ${prev} → ${ev.to}`);
      assert.ok(Math.abs(ev.to * 100 - Math.round(ev.to * 100)) < 1e-6, `trailed stop ${ev.to} is off the 0.01 tick`);
      prev = ev.to;
    }
    if (t.status !== "closed") continue;
    // The database's close math equals the shared TypeScript math.
    const reason = t.exit_reason as string;
    const feeRate = reason === "take_profit" ? 0 : reason === "liquidation" ? 0 : TAKER_FEE;
    const m = closeMath({ side, entry, exit: +(t.exit_price as string), qty: +(t.qty as string), margin: +(t.margin as string), feeRate, liquidation: reason === "liquidation" });
    assert.ok(near(m.pnl, +(t.realized_pnl as string)), "pnl mismatch");
    assert.ok(near(m.fee, +(t.exit_fee as string)), "fee mismatch");
    assert.ok(near(+(t.net_pnl as string), m.pnl - +(t.entry_fee as string) - m.fee));
    assert.ok(near(+(t.r_multiple as string), +(t.net_pnl as string) / +(t.risk_usd as string), 1e-3));
    // Fills are consistent with the trade's own levels.
    const exit = +(t.exit_price as string);
    if (reason === "take_profit") assert.ok(near(exit, +(t.take_profit as string)));
    // Stop ORDER fills (not "trail already breached → closed at market") fill at the stop or worse.
    if ((reason === "stop_loss" || reason === "trailing_stop") && !(t.exit_note as string).includes("Closed at market")) {
      const stop = +(t.stop_price as string);
      assert.ok(side === "long" ? exit <= stop + 1e-9 : exit >= stop - 1e-9, `stop filled better than the stop: ${JSON.stringify({ reason, side, exit, stop, note: t.exit_note })}`);
    }
    assert.ok(new Date(t.closed_at as string) >= new Date(t.opened_at as string));
  }

  // The lesson kept Supertrend 15m out of every trade, and each blocked signal was kept for review.
  assert.equal(trades.filter((t) => t.strategy === "supertrend" && t.timeframe === "15m").length, 0);
  const blocked = (await pg.query<{ strategy: string; timeframe: string; features: Record<string, unknown>; lesson_ids: string[] }>(`select * from public.bot_filtered_signals`)).rows;
  assert.ok(blocked.length > 0, "the lesson should have blocked some signals");
  assert.ok(blocked.every((b) => b.strategy === "supertrend" && b.timeframe === "15m" && b.lesson_ids.length === 1 && typeof b.features.stopPct === "number"));
  assert.ok(trades.some((t) => t.strategy === "supertrend" && t.timeframe !== "15m"), "other timeframes are unaffected");

  // The outage was logged as missed bars, not traded late.
  const missed = (await pg.query(`select count(*)::int n from public.bot_events where kind = 'missed_bar'`)).rows[0] as { n: number };
  assert.ok(missed.n > 0);
  const opensDuringOutage = trades.filter((t) => {
    const o = new Date(t.opened_at as string).getTime() / 1000;
    return o > outage[0] && o < outage[1];
  });
  assert.equal(opensDuringOutage.length, 0);

  // Every open/close produced a journal event.
  const ev = (await pg.query<{ kind: string; n: number }>(`select kind, count(*)::int n from public.bot_events group by kind`)).rows;
  const count = (k: string) => ev.find((e) => e.kind === k)?.n ?? 0;
  assert.equal(count("opened"), trades.length);
  assert.equal(count("closed"), closed.length);
  assert.equal(count("error"), 0);

  // Re-running at the same instant does nothing (cursors make bars idempotent).
  const before = (await pg.query(`select count(*)::int n from public.bot_trades`)).rows[0] as { n: number };
  await runTick({ market, db, now: () => nowMs });
  const after = (await pg.query(`select count(*)::int n from public.bot_trades`)).rows[0] as { n: number };
  assert.equal(after.n, before.n);
});

test("bot engine: lock, permissions and row-level security", async () => {
  const pg = await freshDb();
  await pg.query(`insert into auth.users (id) values ($1), ($2)`, [USER, OTHER_USER]);
  await pg.query(`insert into public.bot_settings (user_id) values ($1)`, [USER]);
  const db = pgDb(pg);

  assert.equal(await db.lock(60), true);
  assert.equal(await db.lock(60), false, "a second run must not get the lock");
  await db.unlock(null, {});
  assert.equal(await db.lock(60), true);
  await db.unlock(null, {});

  await db.sync(STRATEGIES.map(({ key, name, version, summary, rules, params }) => ({ key, name, version, summary, rules, params })), TIMEFRAMES);
  const acc = (await pg.query<{ id: string }>(`select id from public.bot_accounts limit 1`)).rows[0];

  // Engine RPCs are service-role only.
  for (const sql of [
    `select public.bot_lock(5)`,
    `select public.bot_get_state()`,
    `select public.bot_open_trade('{}'::jsonb)`,
    `select public.bot_sync('[]'::jsonb, '{}')`,
  ]) {
    await assert.rejects(
      pg.transaction(async (tx) => {
        await tx.exec(`set local role authenticated; select set_config('request.jwt.claim.sub', '${USER}', true);`);
        await tx.query(sql);
      }),
      /permission denied/,
      sql,
    );
  }

  // Open a trade for USER, then check RLS from both users' point of view.
  const res = await db.openTrade({
    account_id: acc.id, symbol: "BTCUSDT", side: "long", qty: 0.001, entry_price: 60000, leverage: 5,
    stop_price: 59000, take_profit: 62000, risk_usd: 1, risk_pct: 0.01, signal_bar_time: new Date(Date.now() - 60000).toISOString(),
    opened_at: new Date().toISOString(), entry_reason: "test entry reason that is long enough", entry_indicators: { a: 1 }, sizing_notes: ["n"],
  });
  assert.ok(near(res.balance, 100 - 60 / 5 - 60 * TAKER_FEE));
  await assert.rejects(db.openTrade({ account_id: acc.id, symbol: "BTCUSDT", side: "long", qty: 0.001, entry_price: 60000, leverage: 5, stop_price: 59000, take_profit: null, risk_usd: 1, risk_pct: 0.01, signal_bar_time: new Date().toISOString(), opened_at: new Date().toISOString(), entry_reason: "dup", entry_indicators: {}, sizing_notes: [] }), /duplicate|unique/);
  await assert.rejects(db.openTrade({ account_id: acc.id, symbol: "ETHUSDT", side: "long", qty: 1, entry_price: 3000, leverage: 5, stop_price: 3100, take_profit: null, risk_usd: 1, risk_pct: 0.01, signal_bar_time: new Date().toISOString(), opened_at: new Date().toISOString(), entry_reason: "bad stop", entry_indicators: {}, sizing_notes: [] }), /wrong side/);
  await assert.rejects(db.openTrade({ account_id: acc.id, symbol: "ETHUSDT", side: "long", qty: 1, entry_price: 3000, leverage: 5, stop_price: 2900, take_profit: null, risk_usd: 1, risk_pct: 0.01, signal_bar_time: new Date().toISOString(), opened_at: new Date().toISOString(), entry_reason: "too big", entry_indicators: {}, sizing_notes: [] }), /insufficient balance/);

  const asUser = async (uid: string, sql: string) =>
    pg.transaction(async (tx) => {
      await tx.exec(`set local role authenticated; select set_config('request.jwt.claim.sub', '${uid}', true);`);
      return (await tx.query(sql)).rows;
    });
  assert.equal((await asUser(USER, `select id from public.bot_trades`)).length, 1);
  assert.equal((await asUser(OTHER_USER, `select id from public.bot_trades`)).length, 0);
  assert.equal((await asUser(OTHER_USER, `select id from public.bot_accounts`)).length, 0);
  // Users can't write trades or balances directly.
  // RLS has no UPDATE policy for bot_accounts, so this matches 0 rows.
  await asUser(USER, `update public.bot_accounts set balance = 1000000`);
  const b = (await pg.query<{ balance: string }>(`select balance from public.bot_accounts where id = $1`, [acc.id])).rows[0];
  assert.ok(+b.balance < 1000, "user must not be able to change a bot balance");

  // The owner can toggle their own bots.
  await asUser(USER, `update public.bot_settings set enabled = false`);
  assert.equal((await pg.query<{ enabled: boolean }>(`select enabled from public.bot_settings where user_id = $1`, [USER])).rows[0].enabled, false);

  // Liquidation closes at the liq price and forfeits the whole margin.
  const t = res.trade;
  const closedRes = await db.closeTrade({ id: t.id, price: 1, reason: "liquidation", feeRate: 0, at: new Date().toISOString(), note: "test" });
  assert.ok(closedRes);
  assert.ok(near(+closedRes!.trade.net_pnl, -(60 / 5) - 60 * TAKER_FEE));
  assert.ok(near(closedRes!.balance, 100 - 60 / 5 - 60 * TAKER_FEE));
  // Closing again is a no-op.
  assert.equal(await db.closeTrade({ id: t.id, price: 1, reason: "signal", feeRate: 0, at: new Date().toISOString(), note: "again" }), null);
});
