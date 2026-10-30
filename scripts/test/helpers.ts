// Test helpers: a deterministic synthetic market and a PGlite-backed Db that runs
// the real supabase/schema.sql + supabase/bot.sql (with small stubs for the
// Supabase-only auth/storage schemas).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import type { Candle } from "../../supabase/functions/_shared/bot/types.ts";
import type { AnalysisDb, Db, Market } from "../../supabase/functions/_shared/bot/io.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Seeded PRNG (mulberry32). */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Normal-ish noise from a PRNG. */
const gauss = (r: () => number) => (r() + r() + r() + r() + r() + r() - 3) / Math.sqrt(0.5);

/**
 * Regime-switching random walk of 1m candles: trends and chop alternate every
 * few hours, so every strategy gets signals. startSec must be minute-aligned.
 */
export function syntheticMinutes(seed: number, startSec: number, minutes: number, startPrice: number): Candle[] {
  const r = rng(seed);
  const out: Candle[] = [];
  let price = startPrice;
  let drift = 0;
  let vol = 0.0008;
  for (let i = 0; i < minutes; i++) {
    if (i % 240 === 0) {
      drift = (r() - 0.5) * 0.0006;
      vol = 0.0004 + r() * 0.0012;
    }
    const open = price;
    const ret = drift + vol * gauss(r);
    const close = Math.max(open * (1 + ret), 0.0001);
    const wick = vol * Math.abs(gauss(r)) * 0.6;
    const high = Math.max(open, close) * (1 + wick * r());
    const low = Math.min(open, close) * (1 - wick * r());
    out.push({ time: startSec + i * 60, open, high, low, close, volume: 10 + r() * 90 * (1 + Math.abs(ret) / vol) });
    price = close;
  }
  return out;
}

/** Aggregates ascending 1m candles into bars of `sec` seconds (aligned to the epoch, like Binance). */
export function aggregate(minutes: Candle[], sec: number): Candle[] {
  const out: Candle[] = [];
  for (const c of minutes) {
    const t = Math.floor(c.time / sec) * sec;
    const last = out[out.length - 1];
    if (last && last.time === t) {
      last.high = Math.max(last.high, c.high);
      last.low = Math.min(last.low, c.low);
      last.close = c.close;
      last.volume += c.volume;
    } else out.push({ ...c, time: t });
  }
  return out;
}

const INTERVAL_SEC: Record<string, number> = { "1m": 60, "5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "4h": 14400, "1d": 86400 };

/** A Market over pre-generated 1m candles, as seen at time now() (the current bar is partial). */
export function fakeMarket(minutesBySymbol: Record<string, Candle[]>, now: () => number, steps: Record<string, number>): Market & { calls: number } {
  const TICK: Record<string, number> = { BTCUSDT: 0.01, ETHUSDT: 0.01, SOLUSDT: 0.01 };
  const agg = new Map<string, Candle[]>();
  const series = (sym: string, iv: string) => {
    const k = `${sym}:${iv}`;
    if (!agg.has(k)) agg.set(k, iv === "1m" ? minutesBySymbol[sym] : aggregate(minutesBySymbol[sym], INTERVAL_SEC[iv]));
    return agg.get(k)!;
  };
  const m = {
    calls: 0,
    async klines(symbol: string, interval: string, opts: { startTime?: number; limit: number }) {
      m.calls++;
      const sec = INTERVAL_SEC[interval];
      const nowSec = Math.floor(now() / 1000);
      const all = series(symbol, interval);
      const formingStart = Math.floor(nowSec / sec) * sec;
      // Closed bars, plus the forming bar rebuilt from the minutes seen so far.
      let bars = all.filter((c) => c.time < formingStart);
      const mins = minutesBySymbol[symbol].filter((c) => c.time >= formingStart && c.time <= nowSec);
      if (mins.length) bars = [...bars, aggregate(mins, sec)[0]];
      if (opts.startTime != null) return bars.filter((c) => c.time * 1000 >= opts.startTime!).slice(0, opts.limit).map((c) => ({ ...c }));
      return bars.slice(-opts.limit).map((c) => ({ ...c }));
    },
    async symbolFilters() {
      return Object.fromEntries(Object.entries(steps).map(([s, step]) => [s, { step, tick: TICK[s] ?? 0.01 }]));
    },
  };
  return m;
}

const STUBS = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth;
create table auth.users (id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create schema storage;
create table storage.buckets (id text primary key, name text, public boolean);
create table storage.objects (bucket_id text, name text);
create function storage.foldername(name text) returns text[] language sql immutable as $$ select string_to_array(name, '/') $$;
grant usage on schema public, auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
`;

export async function freshDb() {
  const pg = new PGlite();
  await pg.exec(STUBS);
  await pg.exec(readFileSync(join(ROOT, "supabase", "schema.sql"), "utf8"));
  await pg.exec(readFileSync(join(ROOT, "supabase", "bot.sql"), "utf8"));
  // Supabase grants table access to these roles by default; RLS does the rest.
  await pg.exec(`
    grant select, insert, update, delete on all tables in schema public to anon, authenticated, service_role;
  `);
  return pg;
}

/** Runs the engine RPCs the way PostgREST would: as service_role. */
export function pgDb(pg: PGlite): Db {
  async function call<T>(sql: string, params: unknown[]): Promise<T> {
    return pg.transaction(async (tx) => {
      await tx.exec("set local role service_role");
      const res = await tx.query<{ r: T }>(sql, params);
      return res.rows[0]?.r as T;
    });
  }
  const j = (v: unknown) => JSON.stringify(v);
  return {
    lock: (ttl) => call("select public.bot_lock($1::int) r", [ttl]),
    unlock: async (e, s) => void (await call("select public.bot_unlock($1, $2::jsonb) r", [e, j(s)])),
    sync: async (s, tfs) => void (await call("select public.bot_sync($1::jsonb, $2::text[]) r", [j(s), tfs])),
    getState: () => call("select public.bot_get_state() r", []),
    setCursor: async (k, t) => void (await call("select public.bot_set_cursor($1, $2::timestamptz) r", [k, t])),
    openTrade: (p) => call("select public.bot_open_trade($1::jsonb) r", [j(p)]),
    closeTrade: (a) =>
      call("select public.bot_close_trade($1::uuid, $2::numeric, $3, $4::numeric, $5::timestamptz, $6) r", [a.id, a.price, a.reason, a.feeRate, a.at, a.note]),
    updateTrades: async (u) => void (u.length && (await call("select public.bot_update_trades($1::jsonb) r", [j(u)]))),
    log: async (e) => void (e.length && (await call("select public.bot_log($1::jsonb) r", [j(e)]))),
    logFiltered: async (f) => void (f.length && (await call("select public.bot_log_filtered($1::jsonb) r", [j(f)]))),
  };
}

/** The analysis RPCs, as service_role. */
export function pgAnalysisDb(pg: PGlite): AnalysisDb {
  const call = async <T>(sql: string, params: unknown[]) =>
    pg.transaction(async (tx) => {
      await tx.exec("set local role service_role");
      return (await tx.query<{ r: T }>(sql, params)).rows[0]?.r as T;
    });
  const j = (v: unknown) => JSON.stringify(v);
  return {
    state: () => call("select public.bot_analysis_state() r", []),
    saveReviews: async (r) => void (r.length && (await call("select public.bot_save_reviews($1::jsonb) r", [j(r)]))),
    resolveSignals: async (r) => void (r.length && (await call("select public.bot_resolve_signals($1::jsonb) r", [j(r)]))),
    saveLessons: async (r) => void (r.length && (await call("select public.bot_save_lessons($1::jsonb) r", [j(r)]))),
    saveReport: async (r) => void (await call("select public.bot_save_report($1::jsonb) r", [j(r)])),
    tuneAccounts: async (r) => void (r.length && (await call("select public.bot_tune_accounts($1::jsonb) r", [j(r)]))),
  };
}

export const USER = "00000000-0000-4000-8000-000000000001";
export const OTHER_USER = "00000000-0000-4000-8000-000000000002";
