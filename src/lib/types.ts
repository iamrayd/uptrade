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
  realized_pnl: number;
  status: "open" | "closed";
  opened_at: string;
  closed_at: string | null;
}

export interface Order {
  id: string;
  symbol: string;
  side: Side;
  type: OrderType;
  qty: number;
  limit_price: number | null;
  status: "open" | "filled" | "cancelled";
  fill_price: number | null;
  cancel_reason: string | null;
  created_at: string;
  filled_at: string | null;
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
}
