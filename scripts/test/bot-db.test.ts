import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runTick } from "../../supabase/functions/_shared/bot/tick.ts";
import { closeMath, MIN_STOP_PCT, planEntry, TAKER_FEE } from "../../supabase/functions/_shared/bot/risk.ts";
import { strategyMeta } from "../../supabase/functions/_shared/bot/io.ts";
import { STRATEGIES, STRATEGY_BY_KEY } from "../../supabase/functions/_shared/bot/strategies.ts";
import { TF_SECONDS, TIMEFRAMES, type Timeframe } from "../../supabase/functions/_shared/bot/types.ts";
import { aggregate, fakeMarket, freshDb, pgDb, syntheticMinutes, USER, OTHER_USER } from "./helpers.ts";

const DAY = 86400;
const START = 1_760_000_000 - (1_760_000_000 % DAY); // UTC midnight
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b));
const sec = (iso: unknown) => new Date(iso as string).getTime() / 1000;

test("bot engine: over 8 simulated days every signal is traded as its rule set says, and the books stay exact", { timeout: 900_000 }, async () => {
  const pg = await freshDb();
  await pg.query(`insert into auth.users (id) values ($1), ($2)`, [USER, OTHER_USER]);
  await pg.query(`insert into public.bot_settings (user_id) values ($1)`, [USER]); // $100, 2%, 20x defaults

  // 64 days of minutes: enough 4h bars for every rule set's warm-up before the simulated days.
  const DAYS = 64;
  const minutes = {
    BTCUSDT: syntheticMinutes(1, START, DAYS * 1440, 60000),
    ETHUSDT: syntheticMinutes(2, START, DAYS * 1440, 3000),
    SOLUSDT: syntheticMinutes(3, START, DAYS * 1440, 150),
  };
  let nowMs = 0;
  const market = fakeMarket(minutes, () => nowMs, { BTCUSDT: 0.00001, ETHUSDT: 0.0001, SOLUSDT: 0.001 });
  const db = pgDb(pg);

  // Run every 5 minutes (+60s) for the last 8 days, with one 20-hour outage on the second day.
  const simStart = START + (DAYS - 8) * DAY;
  const simEnd = START + DAYS * DAY - 3 * 3600; // the runs after the loop need candles too
  const outage = [simStart + DAY + 3600, simStart + DAY + 21 * 3600];
  const tickTimes: number[] = [];
  let signals = 0;
  let opened = 0;
  let skippedSignals = 0;
  for (let t = simStart + 60; t < simEnd; t += 300) {
    if (t > outage[0] && t < outage[1]) continue;
    nowMs = t * 1000;
    const s = await runTick({ market, db, now: () => nowMs });
    assert.equal(s.skipped, undefined, `tick skipped: ${s.skipped}`);
    assert.deepEqual(s.errors, [], `tick errors at ${new Date(nowMs).toISOString()}`);
    signals += s.signals;
    opened += s.opened;
    skippedSignals += s.signalsSkipped;
    tickTimes.push(t);
  }
  assert.ok(tickTimes.length > 1800);

  // 15 accounts: five rule sets × 15m, 1h, 4h, all for USER only, none held back.
  const accounts = (await pg.query<{ id: string; user_id: string; strategy: string; timeframe: string; balance: string; start_balance: string; status: string }>(
    `select * from public.bot_accounts`,
  )).rows;
  assert.equal(accounts.length, 15);
  assert.deepEqual([...new Set(accounts.map((a) => a.strategy))].sort(), STRATEGIES.map((s) => s.key).sort());
  assert.deepEqual([...new Set(accounts.map((a) => a.timeframe))].sort(), [...TIMEFRAMES].sort());
  assert.ok(accounts.every((a) => a.user_id === USER && +a.start_balance === 100));

  const trades = (await pg.query<Record<string, unknown>>(`select * from public.bot_trades order by opened_at`)).rows;
  const closed = trades.filter((t) => t.status === "closed");
  const skips = (await pg.query<{ account_id: string; symbol: string; data: { reason: string; signal_bar_time: string } }>(`select account_id, symbol, data from public.bot_events where kind = 'skipped'`)).rows;
  console.log(`  ${tickTimes.length} ticks, ${signals} signals → ${trades.length} trades (${closed.length} closed), ${skips.length} not opened, market calls ${market.calls}`);

  // ── Every signal is accounted for: it was opened, or it could not be (and says why). ──
  assert.equal(opened, trades.length);
  assert.equal(signals, opened + skippedSignals, "a signal is either opened or logged as not opened");
  assert.equal(skips.length, skippedSignals);
  assert.ok(skips.every((e) => ["busted", "stale", "sizing"].includes(e.data.reason)), "no gate, lesson, cooldown or probation exists any more");
  assert.ok(trades.length >= 40, `expected plenty of trades, got ${trades.length}`);
  // Every rule set traded, and so did every timeframe.
  for (const s of STRATEGIES) assert.ok(trades.some((t) => t.strategy === s.key), `${s.key} took no trade`);
  for (const tf of TIMEFRAMES) assert.ok(trades.some((t) => t.timeframe === tf), `no trade on ${tf}`);

  // ── Each trade is exactly what its rule set signalled on that bar. ──
  const barsOf = new Map<string, ReturnType<typeof aggregate>>();
  const bars = (symbol: string, tf: string) => {
    const k = `${symbol}:${tf}`;
    if (!barsOf.has(k)) barsOf.set(k, aggregate(minutes[symbol as keyof typeof minutes], TF_SECONDS[tf as Timeframe]));
    return barsOf.get(k)!;
  };
  const signalAt = (strategy: string, symbol: string, tf: string, barTime: number) => {
    const all = bars(symbol, tf);
    const i = all.findIndex((c) => c.time === barTime);
    assert.ok(i >= 0);
    const sig = STRATEGY_BY_KEY[strategy].entry(all.slice(Math.max(0, i + 1 - 600), i + 1));
    return sig && !("skip" in sig) ? sig : null;
  };
  let widened = 0;
  for (const t of trades) {
    const sig = signalAt(t.strategy as string, t.symbol as string, t.timeframe as string, sec(t.signal_bar_time));
    assert.ok(sig, `${t.strategy} ${t.timeframe} ${t.symbol}: a trade without a signal on its bar`);
    assert.equal(t.side, sig.side);
    assert.equal(t.entry_reason, sig.reason);
    const plan = planEntry({ side: sig.side, entry: +(t.entry_price as string), stop: sig.stop, takeProfit: sig.takeProfit, tick: 0.01 });
    assert.ok(!("skip" in plan));
    if ("skip" in plan) continue;
    assert.ok(near(+(t.initial_stop as string), plan.stop, 1e-9), `${t.strategy}: stop ${t.initial_stop} vs the rule's ${plan.stop}`);
    assert.equal(t.take_profit == null ? null : +(t.take_profit as string), plan.takeProfit, `${t.strategy}: target`);
    if (plan.note) {
      widened++;
      assert.ok((t.sizing_notes as string[]).some((n) => n.includes("widened")), "a widened stop is explained in the journal");
    }
    // Entered right after the signal bar closed, not later.
    const tfSec = TF_SECONDS[t.timeframe as Timeframe];
    assert.equal(sec(t.opened_at), sec(t.signal_bar_time) + tfSec + 60);
  }
  assert.ok(widened > 0, "some 15m stops are under the 0.4% minimum: they must be widened and traded, not dropped");
  assert.ok(trades.every((t) => Math.abs(+(t.entry_price as string) - +(t.initial_stop as string)) / +(t.entry_price as string) >= MIN_STOP_PCT));

  // ── The converse: every signal a flat account saw on a bar it acted on became a trade (or a logged skip). ──
  const ticked = new Set(tickTimes);
  let checked = 0;
  for (const a of accounts) {
    const tfSec = TF_SECONDS[a.timeframe as Timeframe];
    const strat = STRATEGY_BY_KEY[a.strategy];
    for (const symbol of Object.keys(minutes)) {
      const mine = trades.filter((t) => t.account_id === a.id && t.symbol === symbol);
      const all = bars(symbol, a.timeframe);
      for (let i = strat.warmup - 1; i < all.length; i++) {
        const evalAt = all[i].time + tfSec + 60; // the run that acts on this bar
        if (evalAt < simStart || !ticked.has(evalAt)) continue;
        const sig = strat.entry(all.slice(Math.max(0, i + 1 - 600), i + 1));
        if (!sig || "skip" in sig) continue;
        const holding = mine.some((t) => sec(t.opened_at) < evalAt && (t.closed_at == null || sec(t.closed_at) > evalAt));
        if (holding) continue; // one position per coin: the open trade is managed instead
        checked++;
        const took = mine.some((t) => sec(t.signal_bar_time) === all[i].time);
        const logged = skips.some((e) => e.account_id === a.id && e.symbol === symbol && sec(e.data.signal_bar_time) === all[i].time);
        assert.ok(took || logged, `${a.strategy} ${a.timeframe} ${symbol}: the signal on ${new Date(all[i].time * 1000).toISOString()} was neither traded nor logged`);
      }
    }
  }
  assert.equal(checked, signals, "the engine saw exactly the signals the rule sets give on those bars");

  const reasons = new Set(closed.map((t) => t.exit_reason));
  for (const r of ["stop_loss", "take_profit"]) assert.ok(reasons.has(r), `no ${r} exits happened`);

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
    // Stop and target on the right side at entry; liquidation beyond the stop.
    assert.ok(side === "long" ? stop0 < entry : stop0 > entry);
    if (t.take_profit != null) assert.ok(side === "long" ? +(t.take_profit as string) > entry : +(t.take_profit as string) < entry, "target on the wrong side");
    for (const p of [stop0, t.take_profit == null ? null : +(t.take_profit as string)])
      if (p != null) assert.ok(Math.abs(p * 100 - Math.round(p * 100)) < 1e-6, `${p} is off the 0.01 tick`);
    const liq = +(t.liq_price as string);
    if (liq > 0) assert.ok(side === "long" ? liq < stop0 : liq > stop0, "liquidation must be beyond the stop");
    assert.ok(+(t.leverage as number) <= 20);
    assert.ok(+(t.risk_pct as string) <= 0.02 + 1e-9, `${t.strategy}: risk ${t.risk_pct}`);
    assert.ok(+(t.entry_fee as string) > 0, "market entries pay the taker fee");
    assert.ok((t.entry_reason as string).length > 30);
    assert.ok(Object.keys(t.entry_indicators as object).length >= 3);
    // Trailing stops only ever tighten.
    let prev = stop0;
    for (const ev of t.stop_history as { from: number; to: number }[]) {
      assert.ok(side === "long" ? ev.to > prev : ev.to < prev, `stop didn't strictly tighten: ${prev} → ${ev.to}`);
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
    if ((reason === "stop_loss" || reason === "trailing_stop") && !(t.exit_note as string).includes("Closed at market")) {
      const stop = +(t.stop_price as string);
      assert.ok(side === "long" ? exit <= stop + 1e-9 : exit >= stop - 1e-9, `stop filled better than the stop: ${JSON.stringify({ reason, side, exit, stop, note: t.exit_note })}`);
    }
    assert.ok(new Date(t.closed_at as string) >= new Date(t.opened_at as string));
  }

  // The outage was logged as missed bars, not traded late.
  const missed = (await pg.query(`select count(*)::int n from public.bot_events where kind = 'missed_bar'`)).rows[0] as { n: number };
  assert.ok(missed.n > 0);
  assert.equal(trades.filter((t) => sec(t.opened_at) > outage[0] && sec(t.opened_at) < outage[1]).length, 0);

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

  // Bots switched off: open trades are still managed, nothing new is opened.
  await pg.query(`update public.bot_settings set enabled = false`);
  nowMs += 3600_000;
  const off = await runTick({ market, db, now: () => nowMs });
  assert.equal(off.opened, 0);
  assert.equal(off.signals, 0);
  await pg.query(`update public.bot_settings set enabled = true`);

  // ── The reset script: everything goes, and the next run starts 15 fresh $100 accounts. ──
  // Leftovers of the older versions, as a deployed database has them.
  await pg.exec(`
    insert into public.bot_strategies (key, name, version, summary, rules) values ('ema_trend', 'Old', 1, 's', 'r');
    insert into public.bot_accounts (user_id, strategy, timeframe, balance, start_balance) values ('${USER}', 'ema_trend', '5m', 37, 100);
    alter table public.bot_accounts add column probation boolean not null default false, add column playbook jsonb;
    create table public.bot_lessons (id int primary key, strategy text references public.bot_strategies on delete cascade);
    create table public.bot_filtered_signals (id int primary key);
  `);
  await pg.exec(readFileSync(new URL("../../supabase/bot_reset.sql", import.meta.url), "utf8"));
  for (const table of ["bot_accounts", "bot_trades", "bot_events", "bot_cursors", "bot_reports", "bot_strategies"])
    assert.equal(((await pg.query(`select count(*)::int n from public.${table}`)).rows[0] as { n: number }).n, 0, `${table} is not empty after the reset`);
  const left = (await pg.query<{ table_name: string }>(`select table_name from information_schema.tables where table_schema = 'public' and table_name in ('bot_lessons', 'bot_filtered_signals', 'bot_pending_entries', 'bot_news')`)).rows;
  assert.deepEqual(left, [], "the old learning tables are dropped");
  const cols = (await pg.query<{ column_name: string }>(`select column_name from information_schema.columns where table_schema = 'public' and table_name = 'bot_accounts'`)).rows.map((r) => r.column_name);
  assert.ok(!cols.includes("probation") && !cols.includes("playbook") && cols.includes("verdict"));
  assert.equal(((await pg.query(`select count(*)::int n from public.bot_settings`)).rows[0] as { n: number }).n, 1, "the owner's settings are kept");

  nowMs += 300_000;
  const fresh = await runTick({ market, db, now: () => nowMs });
  assert.deepEqual(fresh.errors, []);
  const again = (await pg.query<{ strategy: string; timeframe: string; balance: string; status: string }>(`select strategy, timeframe, balance, status from public.bot_accounts`)).rows;
  assert.equal(again.length, 15);
  assert.ok(again.every((a) => +a.balance <= 100 && a.status === "active" && STRATEGY_BY_KEY[a.strategy]));
  assert.equal(((await pg.query(`select count(*)::int n from public.bot_strategies`)).rows[0] as { n: number }).n, 5);
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

  await db.sync(strategyMeta(STRATEGIES), TIMEFRAMES);
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
