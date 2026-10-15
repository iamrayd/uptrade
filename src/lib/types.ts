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
