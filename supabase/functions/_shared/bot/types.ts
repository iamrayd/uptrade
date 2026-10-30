// Shared by the bot-tick edge function (Deno), the backtester and the tests (Node).
// Plain TypeScript with no runtime dependencies, so it runs unchanged in both.

export interface Candle {
  time: number; // UTC seconds (bar open)
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type Side = "long" | "short";

export type ExitReason =
  | "stop_loss"
  | "trailing_stop"
  | "take_profit"
  | "signal"
  | "time_exit"
  | "liquidation";

/** An entry the strategy wants to take, built from the last closed bar. */
export interface Signal {
  side: Side;
  /** Protective stop. */
  stop: number;
  /** Fixed target, or null when the strategy only trails / exits on a signal. */
  takeProfit: number | null;
  /** Plain-language reason, written into the trade journal. */
  reason: string;
  /** Indicator readings on the signal bar, written into the trade journal. */
  indicators: Record<string, number>;
}

/** What a strategy sees about one of its open trades when a bar closes. */
export interface OpenTradeView {
  side: Side;
  entryPrice: number;
  stop: number;
  takeProfit: number | null;
  /** Bars closed since entry (0 on the bar the trade was opened after). */
  barsHeld: number;
}

/** A strategy's decision on an open trade at a bar close. */
export interface ManageResult {
  exit?: { reason: "signal" | "time_exit"; note: string };
  /** New stop. The engine only accepts it if it is tighter (moves in the trade's favour). */
  stop?: number;
  stopNote?: string;
}

export type EntryResult = Signal | { skip: string } | null;

export interface StrategyDef {
  key: string;
  name: string;
  version: number;
  /** One-line description for the dashboard. */
  summary: string;
  /** Full rules (markdown), shown on the dashboard and copied into docs/strategies. */
  rules: string;
  params: Record<string, number>;
  /** Closed bars needed before signals are trusted (indicator warm-up). */
  warmup: number;
  /** The strategy whose trigger, stops and exits this one reuses (news variants). The confluence gate reads the base key. */
  baseKey?: string;
  /** True when entries also pass the crypto-news gate (news.ts). */
  newsAware?: boolean;
  /** Looks at the last closed bar (candles are ascending, all closed). */
  entry(candles: Candle[]): EntryResult;
  manage(candles: Candle[], trade: OpenTradeView): ManageResult;
}

export const TIMEFRAMES = ["5m", "15m", "30m", "1h", "4h", "1d"] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

export const TF_SECONDS: Record<Timeframe, number> = {
  "5m": 300,
  "15m": 900,
  "30m": 1800,
  "1h": 3600,
  "4h": 14400,
  "1d": 86400,
};

export const SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT"] as const;
