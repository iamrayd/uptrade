// The aggressive accounts on the real engine (PGlite): the playbook picks and sizes the trades, every
// other signal is kept and replayed, outcomes are learned exactly once, and a redeploy ends a life
// and starts the next with the playbook kept.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";
import { runTick } from "../../supabase/functions/_shared/bot/tick.ts";
import { runAnalysis } from "../../supabase/functions/_shared/bot/analyze.ts";
import { strategyMeta } from "../../supabase/functions/_shared/bot/io.ts";
import { aggro, STRATEGIES } from "../../supabase/functions/_shared/bot/strategies.ts";
import { AGGRO, newPlaybook, readPlaybook, type Playbook } from "../../supabase/functions/_shared/bot/playbook.ts";
import { TIMEFRAMES } from "../../supabase/functions/_shared/bot/types.ts";
import { fakeMarket, freshDb, pgAnalysisDb, pgDb, syntheticMinutes, USER, OTHER_USER } from "./helpers.ts";

const DAY = 86400;
const START = 1_760_000_000 - (1_760_000_000 % DAY);
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b));

/** A playbook that rates every rule set at +1R and trusts its estimates: it trades the best signal of every bar. */
function eagerPlaybook(): Playbook {
  const pb = newPlaybook();
  pb.cal = { n: 1000, sx: 0, sy: 0, sxx: 250, sxy: 250 };
  for (const k of aggro.pool!) pb.cells[`s=${k}`] = [400, 400];
  pb.cells["*"] = [400 * aggro.pool!.length, 400 * aggro.pool!.length];
  return pb;
}

const asUser = (pg: PGlite, uid: string, sql: string, params: unknown[] = []) =>
  pg.transaction(async (tx) => {
    await tx.exec(`set local role authenticated; select set_config('request.jwt.claim.sub', '${uid}', true);`);
    return (await tx.query(sql, params)).rows;
  });

test("aggressive accounts: created on their own timeframes, trade by the playbook, learn every outcome once, and survive a redeploy", { timeout: 600_000 }, async () => {
  const pg = await freshDb();
  await pg.query(`insert into auth.users (id) values ($1), ($2)`, [USER, OTHER_USER]);
  await pg.query(`insert into public.bot_settings (user_id) values ($1)`, [USER]);
  const db = pgDb(pg);
  const minutes = {
    BTCUSDT: syntheticMinutes(1, START, 22 * 1440, 60000),
    ETHUSDT: syntheticMinutes(2, START, 22 * 1440, 3000),
    SOLUSDT: syntheticMinutes(3, START, 22 * 1440, 150),
  };
  let nowMs = (START + 18 * DAY + 60) * 1000;
  const market = fakeMarket(minutes, () => nowMs, { BTCUSDT: 0.00001, ETHUSDT: 0.0001, SOLUSDT: 0.001 });
  // No signal can score 101, so the ordinary bots place nothing: only the aggressive accounts trade.
  let filtered = 0;
  const tick = async () => {
    const s = await runTick({ market, db, now: () => nowMs, minConfluence: 101 });
    filtered += s.filteredByReason.playbook ?? 0;
    assert.equal(s.skipped, undefined);
    assert.deepEqual(s.errors, [], `tick errors at ${new Date(nowMs).toISOString()}`);
    return s;
  };
  type Acc = { id: string; timeframe: string; balance: string; start_balance: string; status: string; probation: boolean; life: number; playbook: unknown; redeploy_requested_at: string | null };
  const accounts = async () => (await pg.query<Acc>(`select * from public.bot_accounts where strategy = 'aggro' order by timeframe`)).rows;
  const playbook = async (id: string) => readPlaybook((await pg.query<{ playbook: unknown }>(`select playbook from public.bot_accounts where id = $1`, [id])).rows[0].playbook)!;

  // ── Accounts ──
  await db.sync(strategyMeta(STRATEGIES), TIMEFRAMES);
  const accs = await accounts();
  assert.deepEqual(accs.map((a) => a.timeframe), ["15m", "1h"], "an aggressive account on 15m and on 1h, and nowhere else");
  assert.ok(accs.every((a) => !a.probation && a.life === 1 && +a.balance === 100 && a.playbook == null), "not on probation, first life, no playbook yet");
  // Re-running the one-time probation seeding of bot.sql must not catch them.
  await pg.exec(`update public.bot_accounts set probation = true, probation_changed_at = now() where timeframe in ('5m','15m','30m') and probation = false and probation_changed_at is null and strategy <> 'aggro'`);
  assert.ok((await accounts()).every((a) => !a.probation));
  const [a15, a1h] = accs.map((a) => a.id);

  // The first run gives each account the playbook it starts from (the seed) and starts its day.
  await tick();
  for (const a of await accounts()) {
    const pb = readPlaybook(a.playbook);
    assert.ok(pb, `${a.timeframe}: playbook stored`);
    assert.ok(pb.cal.n >= AGGRO.calMin && Object.keys(pb.cells).length > 50, "it starts from the seed, not from nothing");
    assert.deepEqual([pb.day?.life, pb.day?.start, pb.learned, pb.autopsied], [1, 100, 0, 0]);
  }

  // ── Trading: with a playbook that rates everything +1R, the best signal of each bar is taken ──
  await pg.query(`update public.bot_accounts set playbook = $1::jsonb where strategy = 'aggro'`, [JSON.stringify(eagerPlaybook())]);
  const run = async (fromSec: number, toSec: number) => {
    for (let t = fromSec; t < toSec; t += 300) {
      nowMs = t * 1000;
      await tick();
    }
  };
  await run(START + 18 * DAY + 360, START + 19 * DAY + 12 * 3600);

  type Trade = { id: string; account_id: string; strategy: string; symbol: string; status: string; margin: string; entry_fee: string; net_pnl: string | null; risk_pct: string; life: number; aggro: { src: string; facets: Record<string, string>; exp: number; raw: number; risk: number } | null; learned_at: string | null; entry_reason: string; sizing_notes: string[]; exit_note: string | null; closed_at: string | null };
  const trades = async () => (await pg.query<Trade>(`select * from public.bot_trades order by opened_at`)).rows;
  let all = await trades();
  assert.ok(all.length >= 6, `${all.length} trades`);
  assert.ok(all.every((t) => t.strategy === "aggro"), "the ordinary bots traded nothing in this test");
  for (const t of all) {
    assert.ok(t.aggro && aggro.pool!.includes(t.aggro.src), `trade ${t.id} names the rule set that produced it`);
    assert.equal(t.aggro.facets.src, t.aggro.src);
    assert.equal(t.aggro.facets.sym, t.symbol);
    assert.ok(t.aggro.exp >= AGGRO.minEdge && t.aggro.risk >= AGGRO.minRisk && t.aggro.risk <= AGGRO.maxRisk);
    assert.ok(+t.risk_pct > 0 && +t.risk_pct <= AGGRO.maxRisk + 1e-6, `risk ${t.risk_pct}`);
    assert.equal(t.life, 1);
    assert.match(t.entry_reason, /^\[.+\] .+Playbook: the playbook expects [+−]\d/);
    assert.ok(t.sizing_notes.some((n) => /^Playbook: /.test(n)) && t.sizing_notes.some((n) => /Life 1\./.test(n)));
  }
  assert.ok(new Set(all.map((t) => t.aggro!.src)).size >= 2, "more than one rule set was traded");
  // One position per account and coin.
  for (const id of [a15, a1h]) for (const sym of Object.keys(minutes)) assert.ok(all.filter((t) => t.account_id === id && t.symbol === sym && t.status === "open").length <= 1);

  // Signals that were not taken are kept with their context and the raw estimate.
  type Sig = { id: string; account_id: string; reason: string; features: Record<string, string | number>; outcome_r: string | null; learned_at: string | null; strategy: string };
  const signals = async () => (await pg.query<Sig>(`select * from public.bot_filtered_signals where strategy = 'aggro' order by created_at`)).rows;
  let sigs = await signals();
  assert.ok(sigs.length > 5 && filtered === sigs.filter((s) => s.reason === "playbook").length, `${sigs.length} shadow signals`);
  for (const s of sigs) {
    assert.ok(["playbook", "min_stop"].includes(s.reason), s.reason);
    assert.ok(aggro.pool!.includes(String(s.features.src)), "the rule set is stored with the signal");
    assert.equal(typeof s.features.pb_raw, "number");
    for (const k of ["pb_htf", "pb_cf", "pb_vol", "pb_adx", "pb_ema", "session", "side", "symbol"]) assert.equal(typeof s.features[k], "string", k);
  }
  const whys = (await pg.query<{ message: string }>(`select message from public.bot_events where kind = 'skipped' and account_id = any($1)`, [[a15, a1h]])).rows.map((r) => r.message);
  assert.ok(whys.some((m) => /already holds a/.test(m)) || whys.some((m) => /better-rated signal/.test(m)), "the log says why a signal was passed on");

  // The books: balance = start + closed net − (margin + entry fee) of what is open.
  const checkBooks = async () => {
    for (const a of await accounts()) {
      const mine = (await trades()).filter((t) => t.account_id === a.id && t.life === a.life);
      const expected = +a.start_balance + mine.filter((t) => t.status === "closed").reduce((s, t) => s + +t.net_pnl!, 0) - mine.filter((t) => t.status === "open").reduce((s, t) => s + +t.margin + +t.entry_fee, 0);
      assert.ok(near(+a.balance, expected, 1e-6), `${a.timeframe} life ${a.life}: balance ${a.balance}, expected ${expected}`);
    }
  };
  await checkBooks();

  // ── Learning: closed trades and replayed signals go into the playbook, exactly once ──
  const closedBefore = all.filter((t) => t.status === "closed");
  assert.ok(closedBefore.length >= 2, `${closedBefore.length} closed trades`);
  assert.ok(closedBefore.filter((t) => t.learned_at).length >= closedBefore.length - 3, "closed trades are learned by the next run");
  const an = await runAnalysis({ market, db: pgAnalysisDb(pg), now: () => nowMs, narrator: null });
  assert.deepEqual(an.errors, []);
  assert.ok(an.signalsResolved > 0, "the analyzer replays the aggressive accounts' signals with the rule set that produced them");
  sigs = await signals();
  const resolved = sigs.filter((s) => s.outcome_r != null);
  assert.ok(resolved.length > 0 && resolved.every((s) => s.learned_at == null));
  const tuned = (await pg.query<{ probation: boolean; min_confluence: number | null; breakeven: boolean }>(`select probation, min_confluence, breakeven from public.bot_accounts where strategy = 'aggro'`)).rows;
  assert.ok(tuned.every((x) => !x.probation && x.min_confluence == null && !x.breakeven), "the per-setup tuner leaves the aggressive accounts alone");
  assert.equal((await pg.query(`select 1 from public.bot_lessons where strategy = 'aggro'`)).rows.length, 0, "no entry filters are mined for them");

  const learnedBefore = { a15: (await playbook(a15)).learned, a1h: (await playbook(a1h)).learned };
  const calBefore = JSON.stringify([(await playbook(a15)).cal, (await playbook(a1h)).cal]);
  nowMs += 300_000;
  await tick();
  sigs = await signals();
  assert.ok(sigs.filter((s) => s.outcome_r != null).every((s) => s.learned_at != null), "every replayed signal is marked learned");
  all = await trades();
  assert.ok(all.filter((t) => t.status === "closed" && +new Date(t.closed_at!) < nowMs - 300_000).every((t) => t.learned_at != null), "and every closed trade");
  const learnedNow = (await playbook(a15)).learned + (await playbook(a1h)).learned;
  assert.ok(learnedNow >= learnedBefore.a15 + learnedBefore.a1h + resolved.length, `learned ${learnedNow}`);
  assert.notEqual(JSON.stringify([(await playbook(a15)).cal, (await playbook(a1h)).cal]), calBefore, "the replayed outcomes were checked against the estimates the signals had");
  // A second run has nothing new to learn.
  const snapshot = JSON.stringify([(await playbook(a15)).cells, (await playbook(a1h)).cells]);
  nowMs += 60_000;
  await tick();
  const newlyClosed = (await trades()).filter((t) => t.status === "closed" && +new Date(t.closed_at!) >= nowMs - 360_000).length;
  if (!newlyClosed) assert.equal(JSON.stringify([(await playbook(a15)).cells, (await playbook(a1h)).cells]), snapshot, "nothing is learned twice");
  // Saving a playbook with an outcome that is already in it is refused, and nothing is written.
  const one = (await trades()).find((t) => t.learned_at && t.account_id === a15) ?? (await trades()).find((t) => t.learned_at)!;
  const stored = JSON.stringify((await playbook(one.account_id)).cells);
  await assert.rejects(db.savePlaybook({ account_id: one.account_id, playbook: { ...newPlaybook(), learned: 999 }, trade_ids: [one.id], signal_ids: [] }), /already learned/);
  assert.equal(JSON.stringify((await playbook(one.account_id)).cells), stored);
  await assert.rejects(db.savePlaybook({ account_id: a15, playbook: "nope", trade_ids: [], signal_ids: [] }), /invalid playbook/);
  // A run that read an older playbook cannot overwrite a newer one.
  const cur = await playbook(a15);
  assert.ok(cur.rev > 0, "every save counts");
  await assert.rejects(db.savePlaybook({ account_id: a15, playbook: { ...cur, learned: 0 }, trade_ids: [], signal_ids: [], prev_rev: cur.rev - 1 }), /another run saved a newer playbook/);
  assert.equal((await playbook(a15)).learned, cur.learned);

  // ── Redeploy: only the owner, only an aggressive account, only through the request ──
  const ordinary = (await pg.query<{ id: string }>(`select id from public.bot_accounts where strategy = 'donchian' and timeframe = '4h'`)).rows[0].id;
  await assert.rejects(asUser(pg, OTHER_USER, `select public.bot_request_redeploy($1)`, [a15]), /aggressive bot account not found/);
  await assert.rejects(asUser(pg, USER, `select public.bot_request_redeploy($1)`, [ordinary]), /aggressive bot account not found/);
  await assert.rejects(asUser(pg, USER, `select public.bot_redeploy($1, now())`, [a15]), /permission denied/);
  await assert.rejects(asUser(pg, USER, `select public.bot_save_playbook('{}'::jsonb)`), /permission denied/);
  await assert.rejects(asUser(pg, USER, `update public.bot_accounts set balance = 1000000 where id = '${a15}' returning id`).then((r) => assert.equal(r.length, 1)), "an owner cannot write the balance directly");
  await assert.rejects(db.redeploy(ordinary, new Date(nowMs).toISOString()), /only an aggressive account/);

  // Keep running until the 15m account holds a trade, then redeploy it mid-trade.
  for (let i = 0; i < 400 && !(await trades()).some((t) => t.account_id === a15 && t.status === "open"); i++) {
    nowMs += 300_000;
    await tick();
  }
  const held = (await trades()).filter((t) => t.account_id === a15 && t.status === "open");
  assert.ok(held.length > 0, "the 15m account holds a trade");
  await assert.rejects(db.redeploy(a15, new Date(nowMs).toISOString()), /still has open trades/);
  const before = await playbook(a15);
  const life1Trades = (await trades()).filter((t) => t.account_id === a15).length;
  await asUser(pg, USER, `select public.bot_request_redeploy($1)`, [a15]);
  await asUser(pg, USER, `select public.bot_request_redeploy($1)`, [a15]); // asking twice is harmless
  assert.ok((await accounts()).find((a) => a.id === a15)!.redeploy_requested_at);
  nowMs += 60_000;
  await tick();

  const acc = (await accounts()).find((a) => a.id === a15)!;
  assert.deepEqual([acc.life, acc.status, acc.redeploy_requested_at], [2, "active", null]);
  const after = await playbook(a15);
  all = await trades();
  const newTrades = all.filter((t) => t.account_id === a15 && t.life === 2);
  assert.ok(near(+acc.balance + newTrades.filter((t) => t.status === "open").reduce((s, t) => s + +t.margin + +t.entry_fee, 0) - newTrades.filter((t) => t.status === "closed").reduce((s, t) => s + +t.net_pnl!, 0), 100), "the new life starts with the starting balance");
  for (const t of held) {
    const now = all.find((x) => x.id === t.id)!;
    assert.equal(now.status, "closed");
    assert.match(now.exit_note!, /redeployed the account/);
    assert.equal(now.life, 1);
  }
  assert.equal(all.filter((t) => t.account_id === a15 && t.life === 1 && t.status === "open").length, 0);
  // The playbook is kept and has the life's post-mortem.
  assert.equal(after.autopsied, 1);
  assert.deepEqual(after.lives.map((l) => [l.life, l.cause, l.trades]), [[1, "redeployed", life1Trades]]);
  assert.match(after.lives[0].summary, /^Life 1 .*was redeployed at \$/);
  assert.ok(after.learned >= before.learned && Object.keys(after.cells).length >= Object.keys(before.cells).length, "what it learned is still there");
  assert.equal(after.day?.life, 2, "a new life starts its own day");
  const kinds = (await pg.query<{ kind: string; message: string }>(`select kind, message from public.bot_events where account_id = $1 and kind in ('redeploy', 'life_ended', 'redeployed') order by id`, [a15])).rows;
  assert.deepEqual(kinds.map((k) => k.kind), ["redeploy", "redeploy", "life_ended", "redeployed"]);
  assert.match(kinds[3].message, /^Life 2 started with \$100\. The playbook is kept\.$/);

  // ── Bust: no entries, signals still kept; the post-mortem is written once; a redeploy revives it ──
  const open1h = all.filter((t) => t.account_id === a1h && t.status === "open");
  for (const t of open1h) await db.closeTrade({ id: t.id, price: 1, reason: "stop_loss", feeRate: 0, at: new Date(nowMs).toISOString(), note: "test: wiped out" });
  await pg.query(`update public.bot_accounts set balance = 4, status = 'busted' where id = $1`, [a1h]);
  const tradesAtBust = (await trades()).filter((t) => t.account_id === a1h).length;
  await run(nowMs / 1000 + 300, nowMs / 1000 + 300 + 8 * 3600);
  assert.equal((await trades()).filter((t) => t.account_id === a1h).length, tradesAtBust, "a busted account opens nothing");
  const bustedSigs = (await signals()).filter((s) => s.account_id === a1h && s.reason === "busted");
  assert.ok(bustedSigs.length > 0, "its signals are still kept, so it keeps learning while it is down");
  const dead = await playbook(a1h);
  assert.equal(dead.autopsied, 1);
  assert.equal(dead.lives.length, 1);
  assert.equal(dead.lives[0].cause, "busted");
  assert.equal(dead.lives[0].end, 4);
  assert.equal(dead.lives[0].trades, tradesAtBust);
  assert.equal((await pg.query(`select 1 from public.bot_events where account_id = $1 and kind = 'life_ended'`, [a1h])).rows.length, 1, "one post-mortem per life");

  await asUser(pg, USER, `select public.bot_request_redeploy($1)`, [a1h]);
  nowMs += 60_000;
  await tick();
  const revived = (await accounts()).find((a) => a.id === a1h)!;
  assert.deepEqual([revived.life, revived.status, +revived.balance <= 100, +revived.start_balance], [2, "active", true, 100]);
  const alive = await playbook(a1h);
  assert.equal(alive.lives.length, 1, "the busted life is not post-mortemed a second time");
  assert.ok(alive.learned >= dead.learned);
  await run(nowMs / 1000 + 300, nowMs / 1000 + 300 + 12 * 3600);
  await checkBooks();
  const second = (await trades()).filter((t) => t.account_id === a1h && t.life === 2);
  assert.ok(second.length > 0, "the next life trades again, from the same playbook");
  assert.equal((await accounts()).length, 2, "no extra accounts appeared");
  assert.equal((await pg.query(`select 1 from public.bot_trades where strategy <> 'aggro'`)).rows.length, 0);
});
