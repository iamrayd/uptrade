export type Side = "buy" | "sell";
export type PositionSide = "long" | "short";
export type OrderType = "market" | "limit";

export interface Account {
  user_id: string;
  balance: number;
  created_at: string;
}

export interface BalanceAdjustment {
  id: string;
  amount: number;
  note: string | null;
  balance_after: number;
  created_at: string;
}

export interface Position {
  id: string;
  symbol: string;
  side: PositionSide;
  qty: number;
  entry_qty: number;
  closed_qty: number;
  avg_entry: number;
  avg_exit: number | null;
  realized_pnl: number; // gross price PnL, before fees
  status: "open" | "closed";
  opened_at: string;
  closed_at: string | null;
  leverage: number;
  margin: number; // isolated margin currently held
  fees: number; // all fees paid (incl. liquidation fee)
  liq_price: number | null; // 0/null = can't be liquidated
  close_reason: "closed" | "liquidated" | null;
  last_fill_at: string | null;
}

export interface Order {
  id: string;
  symbol: string;
  side: Side;
  type: OrderType | "liquidation";
  qty: number;
  limit_price: number | null;
  status: "open" | "filled" | "cancelled";
  fill_price: number | null;
  cancel_reason: string | null;
  created_at: string;
  filled_at: string | null;
  leverage: number;
  fee: number;
}

export interface Fill {
  id: string;
  order_id: string;
  position_id: string;
  symbol: string;
  side: Side;
  qty: number;
  price: number;
  realized_pnl: number;
  fee: number;
  created_at: string;
}

export interface JournalEntry {
  position_id: string;
  notes: string;
  tags: string[];
  rating: number | null;
  screenshots: string[];
  updated_at: string;
}

export type HistoryRow = Position & {
  journal: Pick<JournalEntry, "tags" | "rating" | "notes"> | null;
};

export interface Candle {
  time: number; // UTC seconds (bar open)
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number; // base asset
}

// ── Strategy bots (supabase/bot.sql) ──

export type BotExitReason = "stop_loss" | "trailing_stop" | "take_profit" | "signal" | "time_exit" | "liquidation";

export interface BotSettings {
  user_id: string;
  enabled: boolean;
  start_balance: number;
  risk_pct: number;
  max_leverage: number;
  /** Switch lessons on automatically once they're confirmed on newer trades. */
  auto_learn: boolean;
  created_at: string;
}

export interface BotStrategy {
  key: string;
  name: string;
  version: number;
  summary: string;
  rules: string;
  params: Record<string, number>;
}

export interface BotAccount {
  id: string;
  strategy: string;
  timeframe: string;
  balance: number; // free cash, excludes margin in open trades
  start_balance: number;
  status: "active" | "busted";
  created_at: string;
}

export interface BotTrade {
  id: string;
  account_id: string;
  strategy: string;
  timeframe: string;
  symbol: string;
  side: PositionSide;
  status: "open" | "closed";
  qty: number;
  entry_price: number;
  leverage: number;
  margin: number;
  liq_price: number;
  initial_stop: number;
  stop_price: number;
  take_profit: number | null;
  risk_usd: number;
  risk_pct: number;
  entry_fee: number;
  signal_bar_time: string;
  opened_at: string;
  entry_reason: string;
  entry_indicators: Record<string, number>;
  sizing_notes: string[];
  trailed: boolean;
  stop_history: { at: string; from: number; to: number; note: string }[];
  mfe_price: number | null;
  mae_price: number | null;
  exit_price: number | null;
  exit_fee: number | null;
  closed_at: string | null;
  exit_reason: BotExitReason | null;
  exit_note: string | null;
  realized_pnl: number | null;
  net_pnl: number | null;
  r_multiple: number | null;
  /** Post-mortem written by the hourly analysis (null until reviewed). */
  review: BotTradeReview | null;
}

export interface BotTradeReview {
  outcome: "win" | "loss" | "scratch";
  category: string;
  title: string;
  why: string;
  fix: string;
  mfeR: number | null;
  maeR: number | null;
  afterExitR: number | null;
  afterExitBars: number | null;
  flags: string[];
  /** Keys of the mistakes in `flags` (reviews written before tags existed have none). */
  tags?: string[];
}

export type BotLessonStatus = "proposed" | "active" | "retired" | "rejected";

export interface BotLesson {
  id: string;
  strategy: string;
  timeframe: string | null;
  feature: string;
  op: "lt" | "gte" | "eq";
  value: number | string;
  status: BotLessonStatus;
  source: "mined" | "ai";
  title: string;
  explanation: string;
  blocked: number;
  blocked_r: number;
  retired_reason: string | null;
  created_at: string;
  activated_at: string | null;
  /** The owner paused it: it is not switched back on automatically. */
  paused: boolean;
}

export type BotReportKind = "hourly" | "daily" | "weekly" | "monthly";
export type BotVerdict = "live_ready" | "promising" | "unproven" | "needs_data" | "avoid";

export interface BotSetupStats {
  strategy: string;
  timeframe: string;
  trades: number;
  wins: number;
  winRate: number | null;
  netUsd: number;
  returnPct: number;
  avgR: number | null;
  lcbR: number | null;
  avgRSlip: number | null;
  lcbRSlip: number | null;
  profitFactor: number | null;
  maxDrawdownPct: number;
  positiveWeeksPct: number | null;
  weeks: number;
  liquidations: number;
  busted: boolean;
  score: number;
  verdict: BotVerdict;
  verdictReason: string;
}

export interface BotBucket {
  label: string;
  start: number;
  trades: number;
  wins: number;
  netUsd: number;
  sumR: number;
}

export interface BotTimingRow {
  key: string;
  trades: number;
  winRate: number;
  avgR: number;
  sumR: number;
}

export interface BotMistakeRow {
  category: string;
  title: string;
  count: number;
  sumR: number;
  fix: string;
}

export interface BotLessonSummary {
  id?: string;
  strategy: string;
  timeframe: string | null;
  title: string;
  status: string;
  source: string;
  blocked?: number;
  blockedR?: number;
}

/** Mirrors ReportData in supabase/functions/_shared/bot/analyze.ts. */
export interface BotReportData {
  kind: BotReportKind;
  periodStart: string;
  periodEnd: string;
  period: {
    trades: number;
    wins: number;
    netUsd: number;
    sumR: number;
    buckets: BotBucket[];
    bySetup: { strategy: string; timeframe: string; trades: number; wins: number; netUsd: number; sumR: number }[];
  };
  setups: BotSetupStats[];
  rankings: { best: BotSetupStats[]; effective: BotSetupStats[]; highestReturn: BotSetupStats[] };
  timing: { byHour: BotTimingRow[]; byWeekday: BotTimingRow[]; bySession: BotTimingRow[] };
  mistakes: {
    period: BotMistakeRow[];
    allTime: BotMistakeRow[];
    bySetup: { strategy: string; timeframe: string; category: string; title: string; count: number; losses: number; fix: string }[];
    examples: { tradeId: string; strategy: string; timeframe: string; symbol: string; side: string; r: number; title: string; why: string; fix: string; flags: string[] }[];
  };
  lessons: { active: BotLessonSummary[]; proposed: BotLessonSummary[]; new: BotLessonSummary[]; retired: BotLessonSummary[] };
  /** Reports written before the learning upgrade don't have this. */
  learning?: {
    impact: { strategy: string; timeframe: string; lessons: number; since: string; before: { n: number; avgR: number | null }; after: { n: number; avgR: number | null } }[];
    tags: { tag: string; label: string; withN: number; withAvgR: number | null; withoutN: number; withoutAvgR: number | null; costR: number }[];
    replayed: { reason: string; n: number; avgR: number | null }[];
    gate: { skippedN: number; skippedAvgR: number | null; tradedN: number; tradedAvgR: number | null };
  };
}

export interface BotNarrative {
  headline: string;
  summary: string[];
  ranking_notes: string[];
  mistakes: { title: string; detail: string }[];
  improvements: { scope: string; action: string; rationale: string }[];
  caveats: string[];
}

export interface BotReport {
  id: string;
  kind: BotReportKind;
  period_start: string;
  period_end: string;
  data: BotReportData;
  narrative: BotNarrative | null;
  ai_model: string | null;
  ai_error: string | null;
  created_at: string;
}

export interface BotEvent {
  id: number;
  account_id: string | null;
  trade_id: string | null;
  symbol: string | null;
  timeframe: string | null;
  kind: string;
  message: string;
  created_at: string;
}

export interface BotRuntime {
  last_started_at: string | null;
  last_finished_at: string | null;
  last_error: string | null;
  runs: number;
}
