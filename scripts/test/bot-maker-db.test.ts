// Maker entries on the real engine (PGlite): a resting limit order fills when a 1-minute candle
// trades through it, pays no entry fee, and lapses into a shadow signal when it is not reached.

import { test } from "node:test";
import assert from "node:assert/strict";
import { runTick } from "../../supabase/functions/_shared/bot/tick.ts";
import { STRATEGIES } from "../../supabase/functions/_shared/bot/strategies.ts";
import { TIMEFRAMES } from "../../supabase/functions/_shared/bot/types.ts";
import type { OpenTradeInput } from "../../supabase/functions/_shared/bot/io.ts";
import { fakeMarket, freshDb, pgDb, syntheticMinutes, USER } from "./helpers.ts";

const DAY = 86400;
const START = 1_760_000_000 - (1_760_000_000 % DAY);
const metaOf = STRATEGIES.map(({ key, name, version, summary, rules, params }) => ({ key, name, version, summary, rules, params }));
const iso = (sec: number) => new Date(sec * 1000).toISOString();

test("maker entries: a resting limit fills on the first 1m candle that trades through it, with no entry fee; an unreached one lapses into a shadow signal", { timeout: 300_000 }, async () => {
  const pg = await freshDb();
  await pg.query(`insert into auth.users (id) values ($1)`, [USER]);
  await pg.query(`insert into public.bot_settings (user_id, enabled) values ($1, true)`, [USER]);
  const db = pgDb(pg);
  await db.sync(metaOf, TIMEFRAMES);
  // No signal can score 101, so the strategies place nothing: only the orders placed below are in play.
  const tick = () => runTick({ market, db, now: () => nowMs, minConfluence: 101 });
  const acc = async (strategy: string, tf: string) => (await pg.query<{ id: string }>(`select id from public.bot_accounts where strategy = $1 and timeframe = $2`, [strategy, tf])).rows[0].id;
  const fillAcc = await acc("donchian", "4h");
  const lapseAcc = await acc("donchian", "1d");
  const bustAcc = await acc("supertrend", "1d");
  const offAcc = await acc("bb_rsi", "1d");

  const minutes = { BTCUSDT: syntheticMinutes(1, START, 3 * 1440, 60000), ETHUSDT: syntheticMinutes(2, START, 3 * 1440, 3000), SOLUSDT: syntheticMinutes(3, START, 3 * 1440, 150) };
  let nowMs = 0;
  const market = fakeMarket(minutes, () => nowMs, { BTCUSDT: 0.00001, ETHUSDT: 0.0001, SOLUSDT: 0.001 });

  // Orders are placed at T (a minute boundary + 5 s). The first candle that can fill them is the next full minute.
  const T = START + DAY + 600;
  const next = minutes.BTCUSDT.filter((c) => c.time >= T + 60 && c.time < T + 60 + 10 * 60);
  const dipAt = next.findIndex((c, i) => i >= 2 && c.low < Math.min(...next.slice(0, i).map((x) => x.low)));
  assert.ok(dipAt >= 2, "the fixture needs a new low a few minutes in");
  const fillCandle = next[dipAt];
  const limit = +((Math.min(...next.slice(0, dipAt).map((x) => x.low)) + fillCandle.low) / 2).toFixed(2); // below every earlier low, above this one
  assert.ok(fillCandle.low < limit && next.slice(0, dipAt).every((c) => c.low >= limit));

  const order = (account_id: string, symbol: string, entry: number): OpenTradeInput => ({
    account_id, symbol, side: "long", qty: 0.0005, entry_price: entry, leverage: 5, stop_price: +(entry * 0.97).toFixed(2), take_profit: null,
    risk_usd: 1, risk_pct: 0.01, signal_bar_time: iso(T - 14400), opened_at: iso(T + 5),
    entry_reason: "test entry reason that is long enough", entry_indicators: { a: 1 }, sizing_notes: ["n"], entry_fee_rate: 0,
  });
  await db.placeEntry({ account_id: fillAcc, placed_at: iso(T + 5), expires_at: iso(T + 5 + 3600), features: { stopPct: 3 }, payload: order(fillAcc, "BTCUSDT", limit) });
  // Far below the market: never reached.
  await db.placeEntry({ account_id: lapseAcc, placed_at: iso(T + 5), expires_at: iso(T + 5 + 900), features: { stopPct: 3, confluence: 80 }, payload: order(lapseAcc, "ETHUSDT", 1500) });
  // Far above the market, so the first candle trades through it; but the account goes bust before that.
  await db.placeEntry({ account_id: bustAcc, placed_at: iso(T + 5), expires_at: iso(T + 5 + 3600), features: { stopPct: 3 }, payload: order(bustAcc, "SOLUSDT", 100000) });
  await pg.query(`update public.bot_accounts set status = 'busted' where id = $1`, [bustAcc]);
  await assert.rejects(db.placeEntry({ account_id: fillAcc, placed_at: iso(T + 5), expires_at: iso(T + 65), features: {}, payload: order(fillAcc, "BTCUSDT", limit) }), /duplicate|unique/, "one resting order per account and coin");

  const pending = async () => (await pg.query<{ account_id: string }>(`select account_id from public.bot_pending_entries`)).rows.map((r) => r.account_id);
  const trades = async () => (await pg.query<Record<string, unknown>>(`select * from public.bot_trades`)).rows;
  assert.deepEqual((await pending()).sort(), [fillAcc, lapseAcc, bustAcc].sort());
  const shadows = async () => (await pg.query<Record<string, unknown>>(`select * from public.bot_filtered_signals where reason <> 'confluence'`)).rows;

  // Tick every minute until just before the fill candle has closed: nothing happens.
  for (let t = T + 65; t < fillCandle.time + 60; t += 60) {
    nowMs = t * 1000;
    const s = await tick();
    assert.deepEqual(s.errors, []);
    assert.equal(s.opened, 0, `filled too early at ${iso(t)}`);
  }
  assert.equal((await trades()).length, 0);
  // The busted account's order was reached but cannot open: it is cancelled and kept as a 'busted' shadow signal.
  assert.deepEqual((await pending()).sort(), [fillAcc, lapseAcc].sort());
  const bustedShadow = await shadows();
  assert.equal(bustedShadow.length, 1);
  assert.equal(bustedShadow[0].reason, "busted");
  assert.equal(bustedShadow[0].account_id, bustAcc);

  // The fill candle closes: the order becomes a trade at the limit price, with no entry fee.
  nowMs = (fillCandle.time + 65) * 1000;
  const s1 = await tick();
  assert.deepEqual(s1.errors, []);
  assert.equal(s1.opened, 1);
  const [t1] = await trades();
  assert.equal(t1.account_id, fillAcc);
  assert.equal(+(t1.entry_price as string), limit);
  assert.equal(+(t1.entry_fee as string), 0);
  assert.equal(t1.status, "open");
  const openedAt = +new Date(t1.opened_at as string) / 1000;
  assert.ok(openedAt >= fillCandle.time && openedAt < fillCandle.time + 60, "opened inside the candle that traded through the limit");
  assert.deepEqual(await pending(), [lapseAcc], "a filled order is no longer resting");
  const bal = (await pg.query<{ balance: string }>(`select balance from public.bot_accounts where id = $1`, [fillAcc])).rows[0];
  assert.ok(Math.abs(+bal.balance - (100 - (0.0005 * limit) / 5)) < 1e-6, "only the margin left the balance");
  assert.match((t1.sizing_notes as string[]).join(" "), /limit order/i);
  // An order fills once: a second fill for an order that is no longer resting is refused.
  await pg.query(`update public.bot_trades set status = 'closed' where id = $1`, [t1.id]);
  await assert.rejects(db.openTrade({ ...order(fillAcc, "BTCUSDT", limit), pending_id: "00000000-0000-4000-8000-00000000abcd" }), /no longer resting/);
  await pg.query(`update public.bot_trades set status = 'open' where id = $1`, [t1.id]);

  // Past the other order's expiry: it is cancelled and kept as an 'unfilled' shadow signal.
  let lapsed = 0;
  for (let t = fillCandle.time + 125; t <= T + 5 + 900 + 120; t += 60) {
    nowMs = t * 1000;
    const s = await tick();
    assert.deepEqual(s.errors, []);
    assert.equal(s.opened, 0);
    lapsed += s.filteredByReason.unfilled ?? 0;
  }
  assert.equal(lapsed, 1);
  assert.deepEqual(await pending(), []);
  assert.equal((await trades()).length, 1);
  const shadow = (await shadows()).filter((s) => s.reason !== "busted");
  assert.equal(shadow.length, 1);
  assert.equal(shadow[0].reason, "unfilled");
  assert.equal(shadow[0].account_id, lapseAcc);
  assert.equal(shadow[0].symbol, "ETHUSDT");
  assert.equal(+(shadow[0].entry_price as string), 1500);
  assert.equal((shadow[0].features as Record<string, number>).confluence, 80);

  // An order resting when the owner switches the bots off is cancelled, not filled (this one would fill at once).
  await db.placeEntry({ account_id: offAcc, placed_at: iso(nowMs / 1000), expires_at: iso(nowMs / 1000 + 3600), features: {}, payload: order(offAcc, "SOLUSDT", 100000) });
  await pg.query(`update public.bot_settings set enabled = false`);
  nowMs += 180_000;
  const sOff = await tick();
  assert.deepEqual(sOff.errors, []);
  assert.equal(sOff.opened, 0);
  assert.deepEqual(await pending(), []);
  assert.equal((await trades()).length, 1);
  const ev = (await pg.query<{ kind: string; message: string }>(`select kind, message from public.bot_events order by id`)).rows;
  assert.equal(ev.filter((e) => e.kind === "placed").length, 4);
  assert.ok(ev.some((e) => e.kind === "skipped" && /switched off/.test(e.message)));
  assert.equal(ev.filter((e) => e.kind === "opened").length, 1);
  assert.ok(ev.some((e) => e.kind === "skipped" && /not filled/.test(e.message)));
});

test("maker entries: a strategy signal rests as a limit at the signal close or better, and every trade the engine opens came from one", { timeout: 600_000 }, async () => {
  const pg = await freshDb();
  await pg.query(`insert into auth.users (id) values ($1)`, [USER]);
  await pg.query(`insert into public.bot_settings (user_id) values ($1)`, [USER]);
  const db = pgDb(pg);
  const minutes = { BTCUSDT: syntheticMinutes(1, START, 20 * 1440, 60000), ETHUSDT: syntheticMinutes(2, START, 20 * 1440, 3000), SOLUSDT: syntheticMinutes(3, START, 20 * 1440, 150) };
  let nowMs = 0;
  const market = fakeMarket(minutes, () => nowMs, { BTCUSDT: 0.00001, ETHUSDT: 0.0001, SOLUSDT: 0.001 });
  let placed = 0;
  let opened = 0;
  for (let t = START + 18 * DAY + 60; t < START + 20 * DAY - 300; t += 300) {
    nowMs = t * 1000;
    const s = await runTick({ market, db, now: () => nowMs, minConfluence: 0, makerEntries: true });
    assert.deepEqual(s.errors, [], `tick errors at ${iso(t)}`);
    placed += s.entriesPlaced;
    opened += s.opened;
  }
  const trades = (await pg.query<Record<string, unknown>>(`select * from public.bot_trades order by opened_at`)).rows;
  assert.ok(trades.length >= 10, `only ${trades.length} trades`);
  assert.equal(opened, trades.length);
  const unfilled = (await pg.query<{ n: number }>(`select count(*)::int n from public.bot_filtered_signals where reason = 'unfilled'`)).rows[0].n;
  const resting = (await pg.query<{ n: number }>(`select count(*)::int n from public.bot_pending_entries`)).rows[0].n;
  assert.equal(placed, trades.length + unfilled + resting, "every order placed was filled, lapsed or is still resting");
  for (const t of trades) {
    assert.equal(+(t.entry_fee as string), 0, "maker entries pay no entry fee");
    const side = t.side as string;
    const entry = +(t.entry_price as string);
    // The limit is the signal bar's close, or the price at placement when that is better.
    const tfSec = { "1h": 3600, "4h": 14400, "1d": 86400 }[t.timeframe as string]!;
    const closeMinute = +new Date(t.signal_bar_time as string) / 1000 + tfSec - 60;
    const signalClose = minutes[t.symbol as keyof typeof minutes].find((c) => c.time === closeMinute)!.close;
    assert.ok(side === "long" ? entry <= signalClose + 1e-9 : entry >= signalClose - 1e-9, `${side} filled at ${entry}, worse than the signal close ${signalClose}`);
    // It filled inside a minute candle that traded through the limit.
    const openedAt = Math.floor(+new Date(t.opened_at as string) / 60000) * 60;
    const c = minutes[t.symbol as keyof typeof minutes].find((x) => x.time === openedAt)!;
    assert.ok(side === "long" ? c.low < entry : c.high > entry, "the fill candle traded through the limit");
    assert.ok((t.risk_pct as number) <= 0.02 * 1.25 + 1e-9);
  }
  // One position per account and coin still holds with orders resting.
  const dup = (await pg.query<{ n: number }>(`select count(*)::int n from (select account_id, symbol from public.bot_trades where status = 'open' group by 1, 2 having count(*) > 1) x`)).rows[0].n;
  assert.equal(dup, 0);
});
