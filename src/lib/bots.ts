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

// ── Aggressive accounts (strategy "aggro") ──

export const AGGRO_KEY = "aggro";
/** Phantom samples an average is shrunk with; the same number as AGGRO.prior in playbook.ts. */
const PLAYBOOK_PRIOR = 20;

const FACET_LABEL: Record<string, (v: string) => string> = {
  side: (v) => `${v}s`,
  sym: (v) => v.replace(/USDT$/, ""),
  htf: (v) => (v === "na" ? "no higher-timeframe read" : v === "mixed" ? "a mixed higher-timeframe trend" : `${v} the higher-timeframe trend`),
  cf: (v) => `${v === "lo" ? "low" : v === "hi" ? "high" : "middling"} confluence`,
  vol: (v) => (v === "na" ? "unknown volatility" : `${v} volatility`),
  adx: (v) => (v === "trend" ? "a trending market" : v === "range" ? "a ranging market" : v === "mid" ? "between range and trend" : "unknown trend strength"),
  ema: (v) => (v === "with" ? "the right side of EMA 200" : v === "against" ? "the wrong side of EMA 200" : "no EMA 200 yet"),
  ses: (v) => `the ${v} session`,
};

/** Plain words for a playbook cell key such as "s=donchian|htf=with" (cellLabel in playbook.ts). */
export function playbookCellLabel(key: string, strategyName: (k: string) => string = (k) => k) {
  return key
    .split("|")
    .map((part) => {
      const [k, v] = part.split("=");
      return k === "s" ? strategyName(v) : (FACET_LABEL[k]?.(v) ?? part);
    })
    .join(" · ");
}

export interface PlaybookRow {
  key: string;
  n: number;
  avgR: number;
}

/** What the playbook has learned: each rule set's average, and the rule set × context cells with the best and worst record. */
export function playbookSummary(pb: { cells: Record<string, [number, number]> } | null | undefined, minN = 15) {
  const rows: PlaybookRow[] = Object.entries(pb?.cells ?? {}).map(([key, [n, s]]) => ({ key, n: Math.round(n), avgR: s / (n + PLAYBOOK_PRIOR) }));
  const ruleSets = rows.filter((r) => /^s=[^|]+$/.test(r.key)).sort((x, y) => y.avgR - x.avgR);
  const contexts = rows.filter((r) => r.key.includes("|") && r.n >= minN).sort((x, y) => y.avgR - x.avgR);
  return { ruleSets, best: contexts.slice(0, 6), worst: contexts.slice(-6).reverse() };
}

/** The slope the playbook corrects its estimates with (calibrate in playbook.ts); null before any signal was checked. */
export function playbookSlope(pb: { cal?: { n: number; sx: number; sy: number; sxx: number; sxy: number } } | null | undefined) {
  const c = pb?.cal;
  if (!c || !(c.n > 0)) return null;
  const mx = c.sx / c.n;
  const my = c.sy / c.n;
  const slope = (c.sxy - c.n * mx * my) / (Math.max(c.sxx - c.n * mx * mx, 0) + 1);
  return { slope: Math.max(-3, Math.min(3, slope)), checked: Math.round(c.n), avgR: my };
}

export const fmtR = (r: number | null | undefined) => (r == null || !Number.isFinite(r) ? "—" : `${r > 0 ? "+" : r < 0 ? "−" : ""}${Math.abs(r).toFixed(2)}R`);
