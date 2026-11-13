import type { BotAccount, BotExitReason, BotTrade } from "./types";

/** The timeframes the bots trade (TIMEFRAMES in supabase/functions/_shared/bot/types.ts). */
export const BOT_TIMEFRAMES = ["15m", "1h", "4h"] as const;
export const BOT_SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT"];
/** Closed trades a rule set needs before its result is more than luck (the analyzer's verdicts use the same bar). */
export const ENOUGH_TRADES = 30;
/** The month's stretch goal for each $100 account. */
export const BOT_GOAL = 500;

export const EXIT_LABEL: Record<BotExitReason, string> = {
  stop_loss: "Stop loss",
  trailing_stop: "Trailing stop",
  take_profit: "Take profit",
  signal: "Exit signal",
  time_exit: "Time stop",
  liquidation: "Liquidated",
};

/** Unrealized PnL of an isolated trade, floored at −margin (it would be liquidated first). */
export function botUnrealized(t: Pick<BotTrade, "side" | "qty" | "entry_price" | "margin">, mark: number | undefined) {
  if (mark == null) return 0;
  const pnl = t.side === "long" ? (mark - t.entry_price) * t.qty : (t.entry_price - mark) * t.qty;
  return Math.max(pnl, -t.margin);
}

/** Equity = free balance + margin in open trades + their unrealized PnL. */
export function botEquity(acc: Pick<BotAccount, "balance">, open: BotTrade[], prices: Record<string, number>) {
  return open.reduce((s, t) => s + t.margin + botUnrealized(t, prices[t.symbol]), acc.balance);
}

export interface BotStats {
  trades: number;
  wins: number;
  winRate: number | null;
  net: number;
  profitFactor: number | null;
  avgR: number | null;
  fees: number;
  maxDrawdownPct: number;
  curve: { time: number; equity: number }[];
}

/** Stats from closed trades (oldest first) and a realized equity curve. */
export function botStats(start: number, closed: BotTrade[], createdAt: string): BotStats {
  const list = [...closed].sort((a, b) => +new Date(a.closed_at!) - +new Date(b.closed_at!));
  let eq = start;
  let peak = start;
  let maxDd = 0;
  const curve = [{ time: Math.floor(+new Date(createdAt) / 1000), equity: start }];
  for (const t of list) {
    eq += t.net_pnl ?? 0;
    peak = Math.max(peak, eq);
    maxDd = Math.max(maxDd, peak > 0 ? (peak - eq) / peak : 0);
    const time = Math.floor(+new Date(t.closed_at!) / 1000);
    // lightweight-charts needs strictly increasing times
    const last = curve[curve.length - 1];
    if (time <= last.time) last.equity = eq;
    else curve.push({ time, equity: eq });
  }
  const wins = list.filter((t) => (t.net_pnl ?? 0) > 0);
  const grossWin = wins.reduce((s, t) => s + (t.net_pnl ?? 0), 0);
  const grossLoss = -list.filter((t) => (t.net_pnl ?? 0) <= 0).reduce((s, t) => s + (t.net_pnl ?? 0), 0);
  const withR = list.filter((t) => t.r_multiple != null);
  return {
    trades: list.length,
    wins: wins.length,
    winRate: list.length ? (wins.length / list.length) * 100 : null,
    net: eq - start,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
    avgR: withR.length ? withR.reduce((s, t) => s + t.r_multiple!, 0) / withR.length : null,
    fees: list.reduce((s, t) => s + t.entry_fee + (t.exit_fee ?? 0), 0),
    maxDrawdownPct: maxDd * 100,
    curve,
  };
}

/** R-multiple of a price move from entry, using the initial stop distance. */
export function priceToR(t: Pick<BotTrade, "side" | "entry_price" | "initial_stop">, price: number | null) {
  if (price == null) return null;
  const risk = Math.abs(t.entry_price - t.initial_stop);
  if (!risk) return null;
  return (t.side === "long" ? price - t.entry_price : t.entry_price - price) / risk;
}

export const fmtR = (r: number | null | undefined) => (r == null || !Number.isFinite(r) ? "—" : `${r > 0 ? "+" : r < 0 ? "−" : ""}${Math.abs(r).toFixed(2)}R`);

/** Plain names for the readings a rule set stores with a trade (entry_indicators). */
const READING_LABEL: Record<string, string> = {
  close: "Close of the signal bar",
  atr14: "Average bar range (ATR 14)",
  ema200: "EMA 200",
  ema20: "EMA 20",
  ema50: "EMA 50",
  gapTop: "Gap top",
  gapBottom: "Gap bottom",
  gapAge: "Bars since the gap formed",
  blockTop: "Block top",
  blockBottom: "Block bottom",
  blockAge: "Bars since the break",
  brokenSwing: "Swing level that broke",
  bbUpper: "Upper band",
  bbMid: "Middle band",
  bbLower: "Lower band",
  rsi: "RSI now",
  rsiPrev: "RSI on the bar before",
  adx14: "Trend strength (ADX 14)",
  channelHigh20: "20-bar high",
  channelLow20: "20-bar low",
  volumeX: "Volume vs its average (×)",
};

/** A reading's plain name; an unknown key is spaced out ("sweptLevel" → "Swept level"). */
export function readingLabel(key: string) {
  if (READING_LABEL[key]) return READING_LABEL[key];
  const words = key.replace(/([a-z])([A-Z0-9])/g, "$1 $2").replace(/_/g, " ").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
