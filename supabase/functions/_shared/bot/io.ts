import type { Candle } from "./types.ts";
import type { RecentTrade } from "./discipline.ts";
import type { NewsState } from "./news.ts";

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
  start_balance: number;
  /** Shadow-only: signals are logged and replayed but never traded (tuning.ts decides). */
  probation: boolean;
  /** Per-setup confluence threshold; null: the global default. */
  min_confluence: number | null;
  /** Move the stop to fee cover once the trade reaches +1R. */
  breakeven: boolean;
  /** Scale risk by entry confluence and the setup's verdict. */
  conviction: boolean;
  /** The setup's latest analyzer verdict (live_ready | promising | unproven | needs_data | avoid), null before the first run. */
  verdict: string | null;
  /** Latest closed trades, oldest first. */
  recent: RecentTrade[];
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
  initial_stop: number;
  stop_price: number;
  take_profit: number | null;
  trailed: boolean;
  signal_bar_time: string;
  opened_at: string;
  checked_until: string;
  mfe_price: number | null;
  mae_price: number | null;
}

/** An active lesson: skip entries that match its rule (see analysis.ts). */
export interface LessonRow {
  id: string;
  user_id: string;
  strategy: string;
  timeframe: string | null;
  feature: string;
  op: "lt" | "gte" | "eq";
  value: number | string;
  title: string;
}

export interface BotState {
  accounts: AccountRow[];
  open_trades: TradeRow[];
  cursors: Record<string, string>;
  lessons?: LessonRow[];
  /** Latest crypto-news read (null before bot-news has run). */
  news?: (NewsState & { updated_at: string }) | null;
}

/** Why a signal was not traded. */
export type SkipReason = "lesson" | "confluence" | "cooldown" | "news" | "busted" | "probation" | "min_stop";

export interface FilteredSignalInput {
  account_id: string;
  reason: SkipReason;
  lesson_ids: string[];
  symbol: string;
  side: "long" | "short";
  entry_price: number;
  stop_price: number;
  take_profit: number | null;
  signal_bar_time: string;
  features: Record<string, number | string>;
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
    trade: TradeRow & { net_pnl: number; r_multiple: number | null; closed_at: string };
    balance: number;
    status: "active" | "busted";
  } | null>;
  updateTrades(u: TradeUpdate[]): Promise<void>;
  log(events: EventRow[]): Promise<void>;
  logFiltered(rows: FilteredSignalInput[]): Promise<void>;
}

// ───────────────────────── Analysis (bot-analyze) ─────────────────────────

export interface LessonRecord extends LessonRow {
  status: "proposed" | "active" | "retired" | "rejected";
  /** The owner paused it: it is not switched back on automatically. */
  paused?: boolean;
  activated_at?: string | null;
  source: "mined" | "ai";
  explanation: string;
  blocked: number;
  blocked_r: number;
  created_at: string;
}

export interface FilteredSignalRow {
  id: string;
  user_id: string;
  account_id: string;
  reason: SkipReason;
  features: Record<string, number | string>;
  lesson_ids: string[];
  strategy: string;
  timeframe: string;
  symbol: string;
  side: "long" | "short";
  entry_price: number;
  stop_price: number;
  take_profit: number | null;
  signal_bar_time: string;
  created_at: string;
}

export interface TunableAccount {
  id: string;
  user_id: string;
  strategy: string;
  timeframe: string;
  start_balance: number;
  status: "active" | "busted";
  probation: boolean;
  probation_changed_at: string | null;
  min_confluence: number | null;
  min_confluence_changed_at: string | null;
  breakeven: boolean;
  breakeven_changed_at: string | null;
  conviction: boolean;
  verdict: string | null;
}

export interface AccountTune {
  id: string;
  probation?: boolean;
  min_confluence?: number | null;
  breakeven?: boolean;
  conviction?: boolean;
  verdict?: string;
}

export interface AnalysisState {
  settings: { user_id: string; auto_learn: boolean }[];
  accounts: TunableAccount[];
  /** Closed trades, oldest first, with numbers possibly as strings (Postgres numerics). */
  trades: (Record<string, unknown> & { id: string; reviewed: boolean; review_category: string | null; review: unknown })[];
  lessons: LessonRecord[];
  pending_signals: FilteredSignalRow[];
  /** Replayed signals (newest 4000): learning data and each lesson's recent record. */
  resolved_signals: (Omit<FilteredSignalRow, "entry_price" | "stop_price" | "take_profit" | "created_at"> & { outcome_r: number; outcome_r_be?: number | null; resolved_at: string })[];
  last_reports: { user_id: string; kind: string; period_start: string }[];
}

export interface NewLesson {
  user_id: string;
  strategy: string;
  timeframe: string | null;
  feature: string;
  op: "lt" | "gte" | "eq";
  value: number | string;
  status: "proposed" | "active";
  source: "mined" | "ai";
  title: string;
  explanation: string;
  evidence: unknown;
}

export interface LessonChange {
  id: string;
  status?: "proposed" | "active" | "retired";
  blocked?: number;
  blocked_r?: number;
  retired_reason?: string;
}

export interface ReportInput {
  user_id: string;
  kind: string;
  period_start: string;
  period_end: string;
  data: unknown;
  narrative: unknown;
  ai_model: string | null;
  ai_error: string | null;
}

export interface AnalysisDb {
  state(): Promise<AnalysisState>;
  saveReviews(rows: { id: string; review: unknown }[]): Promise<void>;
  resolveSignals(rows: { id: string; outcome_r: number | null; outcome_r_be?: number | null; outcome_note: string }[]): Promise<void>;
  saveLessons(rows: (NewLesson | LessonChange)[]): Promise<void>;
  saveReport(r: ReportInput): Promise<void>;
  tuneAccounts(rows: AccountTune[]): Promise<void>;
}

/** Calls a PostgREST RPC with the service-role key. */
function rpcClient(url: string, serviceKey: string) {
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
  return rpc;
}

/** PostgREST client for the news RPC in supabase/bot.sql. */
export function restNewsDb(url: string, serviceKey: string) {
  const rpc = rpcClient(url, serviceKey);
  return { saveNews: async (data: NewsState) => void (await rpc("bot_save_news", { p: { data } })) };
}

/** PostgREST client for the engine RPCs in supabase/bot.sql. */
export function restDb(url: string, serviceKey: string): Db {
  const rpc = rpcClient(url, serviceKey);
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
    logFiltered: async (f) => void (f.length && (await rpc("bot_log_filtered", { p: f }))),
  };
}

/** PostgREST client for the analysis RPCs in supabase/bot.sql. */
export function restAnalysisDb(url: string, serviceKey: string): AnalysisDb {
  const rpc = rpcClient(url, serviceKey);
  return {
    state: () => rpc<AnalysisState>("bot_analysis_state", {}),
    saveReviews: async (r) => void (r.length && (await rpc("bot_save_reviews", { p: r }))),
    resolveSignals: async (r) => void (r.length && (await rpc("bot_resolve_signals", { p: r }))),
    saveLessons: async (r) => void (r.length && (await rpc("bot_save_lessons", { p: r }))),
    saveReport: async (r) => void (await rpc("bot_save_report", { p: r })),
    tuneAccounts: async (r) => void (r.length && (await rpc("bot_tune_accounts", { p: r }))),
  };
}
