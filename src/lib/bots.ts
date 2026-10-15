import type { BotAccount, BotExitReason, BotTrade } from "./types";

export const BOT_TIMEFRAMES = ["5m", "15m", "30m", "1h", "4h", "1d"] as const;
export const BOT_SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT"];
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
