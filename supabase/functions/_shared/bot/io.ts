import type { Candle } from "./types.ts";

export interface SymbolFilters {
  step: number;
  tick: number;
}

// ───────────────────────── Market data (Binance public REST) ─────────────────────────

export interface Market {
  /** Klines ascending. The last one may still be forming. */
  klines(symbol: string, interval: string, opts: { startTime?: number; limit: number }): Promise<Candle[]>;
  /** LOT_SIZE step (qty) and PRICE_FILTER tick (price) per symbol. */
  symbolFilters(symbols: readonly string[]): Promise<Record<string, SymbolFilters>>;
}

// Same data mirror as the app, with Binance's main API as fallback in case the
// edge function's region can reach one but not the other.
const HOSTS = ["https://data-api.binance.vision/api/v3", "https://api.binance.com/api/v3"];

async function getJson(path: string): Promise<unknown> {
  let lastErr: unknown;
  for (const host of HOSTS) {
    try {
      const res = await fetch(`${host}${path}`, { signal: AbortSignal.timeout(10_000) });
      if (res.ok) return await res.json();
      lastErr = new Error(`${host} ${res.status}`);
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`Binance unreachable: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
}

type RawKline = [number, string, string, string, string, string, ...unknown[]];

export const binanceMarket: Market = {
  async klines(symbol, interval, opts) {
    const q = new URLSearchParams({ symbol, interval, limit: String(opts.limit) });
    if (opts.startTime != null) q.set("startTime", String(opts.startTime));
    const rows = (await getJson(`/klines?${q}`)) as RawKline[];
    return rows.map((k) => ({ time: Math.floor(k[0] / 1000), open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] }));
  },
  async symbolFilters(symbols) {
    const data = (await getJson(`/exchangeInfo?symbols=${encodeURIComponent(JSON.stringify(symbols))}`)) as {
      symbols: { symbol: string; filters: { filterType: string; stepSize?: string; tickSize?: string }[] }[];
    };
    const out: Record<string, SymbolFilters> = {};
    for (const s of data.symbols) {
      const lot = s.filters.find((f) => f.filterType === "LOT_SIZE");
      const price = s.filters.find((f) => f.filterType === "PRICE_FILTER");
      out[s.symbol] = { step: lot?.stepSize ? +lot.stepSize : 0.00001, tick: price?.tickSize ? +price.tickSize : 0.01 };
    }
    return out;
  },
};

// ───────────────────────── Database (PostgREST RPCs, service role) ─────────────────────────

export interface AccountRow {
  id: string;
  user_id: string;
  strategy: string;
  timeframe: string;
  balance: number;
  status: "active" | "busted";
  enabled: boolean;
  risk_pct: number;
  max_leverage: number;
}

export interface TradeRow {
  id: string;
  user_id: string;
  account_id: string;
  strategy: string;
  timeframe: string;
  symbol: string;
  side: "long" | "short";
  qty: number;
  entry_price: number;
  leverage: number;
  margin: number;
  liq_price: number;
  stop_price: number;
  take_profit: number | null;
  trailed: boolean;
  signal_bar_time: string;
  opened_at: string;
  checked_until: string;
  mfe_price: number | null;
  mae_price: number | null;
}

export interface BotState {
  accounts: AccountRow[];
  open_trades: TradeRow[];
  cursors: Record<string, string>;
}

export interface EventRow {
  user_id?: string | null;
  account_id?: string | null;
  trade_id?: string | null;
  symbol?: string | null;
  timeframe?: string | null;
  kind: string;
  message: string;
  data?: Record<string, unknown>;
}

export interface TradeUpdate {
  id: string;
  stop_price?: number;
  trailed?: boolean;
  mfe_price?: number;
  mae_price?: number;
  checked_until?: string;
  stop_event?: { at: string; from: number; to: number; note: string };
}

export interface OpenTradeInput {
  account_id: string;
  symbol: string;
  side: "long" | "short";
  qty: number;
  entry_price: number;
  leverage: number;
  stop_price: number;
  take_profit: number | null;
  risk_usd: number;
  risk_pct: number;
  signal_bar_time: string;
  opened_at: string;
  entry_reason: string;
  entry_indicators: Record<string, number>;
  sizing_notes: string[];
}

export interface StrategyMeta {
  key: string;
  name: string;
  version: number;
  summary: string;
  rules: string;
  params: Record<string, number>;
}

export interface Db {
  lock(ttlSeconds: number): Promise<boolean>;
  unlock(error: string | null, summary: unknown): Promise<void>;
  sync(strategies: StrategyMeta[], timeframes: readonly string[]): Promise<void>;
  getState(): Promise<BotState>;
  setCursor(key: string, barTimeIso: string): Promise<void>;
  openTrade(p: OpenTradeInput): Promise<{ trade: TradeRow; balance: number }>;
  closeTrade(a: { id: string; price: number; reason: string; feeRate: number; at: string; note: string }): Promise<{
    trade: TradeRow & { net_pnl: number };
    balance: number;
    status: "active" | "busted";
  } | null>;
  updateTrades(u: TradeUpdate[]): Promise<void>;
  log(events: EventRow[]): Promise<void>;
}

/** PostgREST client for the engine RPCs in supabase/bot.sql. */
export function restDb(url: string, serviceKey: string): Db {
  const headers: Record<string, string> = { apikey: serviceKey, "Content-Type": "application/json" };
  // Legacy service_role keys are JWTs and also go in Authorization; new sb_secret_ keys go only in apikey.
  if (serviceKey.startsWith("eyJ")) headers.Authorization = `Bearer ${serviceKey}`;

  async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
    const res = await fetch(`${url}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers,
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    if (!res.ok) {
      let msg = text;
      try {
        msg = (JSON.parse(text) as { message?: string }).message ?? text;
      } catch {
        // not JSON
      }
      throw new Error(`${fn}: ${msg}`);
    }
    return (text ? JSON.parse(text) : null) as T;
  }

  return {
    lock: (ttl) => rpc<boolean>("bot_lock", { p_ttl: ttl }),
    unlock: async (error, summary) => void (await rpc("bot_unlock", { p_error: error, p_summary: summary })),
    sync: async (s, tfs) => void (await rpc("bot_sync", { p_strategies: s, p_timeframes: tfs })),
    getState: () => rpc<BotState>("bot_get_state", {}),
    setCursor: async (key, t) => void (await rpc("bot_set_cursor", { p_key: key, p_bar_time: t })),
    openTrade: (p) => rpc("bot_open_trade", { p }),
    closeTrade: (a) =>
      rpc("bot_close_trade", { p_trade_id: a.id, p_price: a.price, p_reason: a.reason, p_fee_rate: a.feeRate, p_at: a.at, p_note: a.note }),
    updateTrades: async (u) => void (u.length && (await rpc("bot_update_trades", { p: u }))),
    log: async (e) => void (e.length && (await rpc("bot_log", { p: e }))),
  };
}
