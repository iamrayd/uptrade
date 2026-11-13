import type { Candle, ExitReason, Side } from "./types.ts";

// Performance analysis for the strategy bots. Pure functions, no I/O, so the analyzer
// (analyze.ts) and the tests share them.
//
//  - reviewTrade: a post-mortem of one closed trade: what went wrong, why, and the fix.
//  - setupStats / rankSetups: robust scores for each strategy × timeframe. A setup only
//    ranks high if its edge survives a confidence bound, extra slippage and drawdown.
//  - periodBuckets / timing: results by period, weekday and session.
//
// Nothing here changes what the bots trade. Strategy v3 trades every signal; these numbers
// are what the owner reads to decide which rule sets to keep.

// ───────────────────────── Inputs ─────────────────────────

/** A closed bot trade as the analyzer sees it (numbers already parsed). */
export interface AnalysisTrade {
  id: string;
  user_id: string;
  account_id: string;
  strategy: string;
  timeframe: string;
  symbol: string;
  side: Side;
  qty: number;
  entry_price: number;
  initial_stop: number;
  take_profit: number | null;
  risk_usd: number;
  opened_at: string;
  closed_at: string;
  exit_reason: ExitReason;
  exit_price: number;
  exit_note: string | null;
  net_pnl: number;
  r_multiple: number;
  mfe_price: number | null;
  mae_price: number | null;
  entry_indicators: Record<string, number>;
}


/** Market session of a UTC time: asia 00–07, europe 07–13, us 13–21, late 21–24. */
export function sessionOf(ms: number) {
  const h = new Date(ms).getUTCHours();
  return h < 7 ? "asia" : h < 13 ? "europe" : h < 21 ? "us" : "late";
}

const round = (n: number, d = 4) => +n.toFixed(d);

// ───────────────────────── Trade review (post-mortem) ─────────────────────────

export interface TradeReview {
  v: 1;
  outcome: "win" | "loss" | "scratch";
  category: string;
  title: string;
  why: string;
  fix: string;
  /** Best and worst excursion in R (price distance ÷ initial stop distance). */
  mfeR: number | null;
  maeR: number | null;
  /** Best excursion from the entry, in R, during the bars after the exit (did it work out without us?). */
  afterExitR: number | null;
  afterExitBars: number | null;
}

export const REVIEW_CATEGORIES: Record<string, { title: string; fix: string }> = {
  liquidated: { title: "Liquidated", fix: "Lower the leverage cap so the liquidation price sits further beyond the stop." },
  gap_slippage: { title: "Stop gapped", fix: "Avoid holding through low-liquidity hours, or size down when volatility spikes." },
  gave_back: { title: "Winner turned loser", fix: "Move the stop to breakeven (or take partial profit) once the trade is +1R." },
  stopped_then_ran: { title: "Right idea, stopped out", fix: "The stop sat inside normal noise: widen it (e.g. +0.5 ATR) or wait for a pullback entry." },
  exit_too_early: { title: "Exited, then it worked", fix: "The exit signal fired on noise: require confirmation (two bars) before exiting on a signal." },
  stale: { title: "No movement", fix: "Filter out quiet markets (low ATR or ADX) where reversion setups don't get paid." },
  no_follow_through: { title: "False signal", fix: "Price went against the entry from the start: add a confirmation filter or skip this context." },
  chop: { title: "Chopped out", fix: "Price moved a little, then reversed to the stop: typical of ranging markets; a trend-strength filter helps." },
  target_hit: { title: "Target hit", fix: "Nothing to fix." },
  left_on_table: { title: "Left profit on the table", fix: "The trade ran much further after peaking: trail with a tighter stop or scale out." },
  clean_win: { title: "Winner", fix: "Nothing to fix." },
  scratch: { title: "Scratch", fix: "Breakeven: fees were the only cost." },
};

/** Price distance from the entry in R, positive in the trade's favour. */
export function toR(t: Pick<AnalysisTrade, "side" | "entry_price" | "initial_stop">, price: number | null) {
  if (price == null) return null;
  const risk = Math.abs(t.entry_price - t.initial_stop);
  if (!risk) return null;
  return round((t.side === "long" ? price - t.entry_price : t.entry_price - price) / risk, 3);
}

/** Best price in the trade's favour reached by these candles, in R from the entry. */
export function bestExcursionR(t: Pick<AnalysisTrade, "side" | "entry_price" | "initial_stop">, candles: Candle[]) {
  if (!candles.length) return null;
  const best = t.side === "long" ? Math.max(...candles.map((c) => c.high)) : Math.min(...candles.map((c) => c.low));
  return toR(t, best);
}

/**
 * Post-mortem of a closed trade from its own numbers. `after` are the strategy-timeframe
 * bars that closed after the exit (may be empty when not fetched).
 */
export function reviewTrade(t: AnalysisTrade, after: Candle[] = []): TradeReview {
  const r = t.r_multiple;
  const mfeR = toR(t, t.mfe_price);
  const maeR = toR(t, t.mae_price);
  const afterExitR = after.length ? bestExcursionR(t, after) : null;
  const tpR = t.take_profit != null ? toR(t, t.take_profit) : null;
  const runTarget = Math.max(1.5, tpR ?? 0);
  const fmt = (n: number | null) => (n == null ? "?" : `${n >= 0 ? "+" : ""}${n.toFixed(2)}R`);

  let category: string;
  let why: string;
  const outcome: TradeReview["outcome"] = Math.abs(r) < 0.1 ? "scratch" : r > 0 ? "win" : "loss";
  if (outcome === "scratch") {
    category = "scratch";
    why = `Closed at ${fmt(r)}: about breakeven after fees.`;
  } else if (outcome === "win") {
    if (t.exit_reason === "take_profit") {
      category = "target_hit";
      why = `Reached the planned target for ${fmt(r)}.`;
    } else if (mfeR != null && mfeR - r >= 1.5) {
      category = "left_on_table";
      why = `Peaked at ${fmt(mfeR)} but exited at ${fmt(r)}, giving back ${(mfeR - r).toFixed(1)}R.`;
    } else {
      category = "clean_win";
      why = `Exited by the rules for ${fmt(r)}.`;
    }
  } else if (t.exit_reason === "liquidation") {
    category = "liquidated";
    why = "The liquidation price was hit before the stop could fill, so the whole margin was lost.";
  } else if ((t.exit_note ?? "").includes("(slippage)") && r < -1.2) {
    category = "gap_slippage";
    why = `Price jumped past the stop, so it filled at ${fmt(r)} instead of about −1R.`;
  } else if (mfeR != null && mfeR >= 1) {
    category = "gave_back";
    why = `Was up ${fmt(mfeR)} before reversing into a ${fmt(r)} loss.`;
  } else if ((t.exit_reason === "stop_loss" || t.exit_reason === "trailing_stop") && afterExitR != null && afterExitR >= runTarget) {
    category = "stopped_then_ran";
    why = `Stopped out at ${fmt(r)}, then price reached ${fmt(afterExitR)} from the entry within ${after.length} bars. The direction was right; the stop or the timing wasn't.`;
  } else if (t.exit_reason === "signal" && afterExitR != null && afterExitR >= runTarget) {
    category = "exit_too_early";
    why = `The exit signal closed it at ${fmt(r)}, then price reached ${fmt(afterExitR)} from the entry within ${after.length} bars.`;
  } else if (t.exit_reason === "time_exit") {
    category = "stale";
    why = `Neither the stop nor the target was reached in time (best ${fmt(mfeR)}); closed at ${fmt(r)}.`;
  } else if (mfeR == null || mfeR < 0.3) {
    category = "no_follow_through";
    why = `Price never got more than ${fmt(mfeR)} in favour before hitting ${fmt(r)}: the entry signal had no follow-through.`;
  } else {
    category = "chop";
    why = `Moved ${fmt(mfeR)} in favour, then reversed to the stop for ${fmt(r)}.`;
  }
  const meta = REVIEW_CATEGORIES[category];
  return { v: 1, outcome, category, title: meta.title, why, fix: meta.fix, mfeR, maeR, afterExitR, afterExitBars: after.length || null };
}

// ───────────────────────── Setup statistics and ranking ─────────────────────────

/** Extra cost per side, as a fraction of notional, to stress-test paper results for live slippage. */
export const SLIPPAGE = 0.0005;

export type Verdict = "live_ready" | "promising" | "unproven" | "needs_data" | "avoid";

export const VERDICT_LABEL: Record<Verdict, string> = {
  live_ready: "Ready for a small live test",
  promising: "Promising",
  unproven: "Unproven",
  needs_data: "Needs more trades",
  avoid: "Avoid",
};

export interface SetupStats {
  strategy: string;
  timeframe: string;
  trades: number;
  wins: number;
  winRate: number | null;
  netUsd: number;
  returnPct: number;
  avgR: number | null;
  /** 95% one-sided lower confidence bound of the mean R: the edge we can actually count on. */
  lcbR: number | null;
  /** Average R after SLIPPAGE per side, for real-exchange fills. */
  avgRSlip: number | null;
  lcbRSlip: number | null;
  profitFactor: number | null;
  maxDrawdownPct: number;
  /** Share of calendar weeks (UTC, Monday start) with net profit. */
  positiveWeeksPct: number | null;
  weeks: number;
  liquidations: number;
  busted: boolean;
  score: number;
  verdict: Verdict;
  verdictReason: string;
}

const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
function sd(xs: number[]) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}
const clamp = (x: number, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, x));

/** Monday 00:00 UTC of the week containing `ms`. */
export function weekStart(ms: number) {
  const d = new Date(ms);
  const day = (d.getUTCDay() + 6) % 7;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day);
}

/** Slippage-stressed R of one trade: SLIPPAGE on both the entry and the exit notional. */
export function slippedR(t: AnalysisTrade) {
  if (!(t.risk_usd > 0)) return t.r_multiple;
  return t.r_multiple - (SLIPPAGE * t.qty * (t.entry_price + t.exit_price)) / t.risk_usd;
}

export function setupStats(a: { strategy: string; timeframe: string; startBalance: number; busted: boolean; trades: AnalysisTrade[] }): SetupStats {
  const list = [...a.trades].sort((x, y) => +new Date(x.closed_at) - +new Date(y.closed_at));
  const n = list.length;
  const rs = list.map((t) => t.r_multiple);
  const rsSlip = list.map(slippedR);
  const wins = list.filter((t) => t.net_pnl > 0);
  const grossWin = wins.reduce((s, t) => s + t.net_pnl, 0);
  const grossLoss = -list.filter((t) => t.net_pnl <= 0).reduce((s, t) => s + t.net_pnl, 0);
  let eq = a.startBalance;
  let peak = eq;
  let maxDd = 0;
  const weekly = new Map<number, number>();
  for (const t of list) {
    eq += t.net_pnl;
    peak = Math.max(peak, eq);
    maxDd = Math.max(maxDd, peak > 0 ? (peak - eq) / peak : 0);
    const w = weekStart(+new Date(t.closed_at));
    weekly.set(w, (weekly.get(w) ?? 0) + t.net_pnl);
  }
  const lcb = (xs: number[]) => (xs.length >= 2 ? mean(xs) - (1.645 * sd(xs)) / Math.sqrt(xs.length) : null);
  const weeks = weekly.size;
  const s: SetupStats = {
    strategy: a.strategy,
    timeframe: a.timeframe,
    trades: n,
    wins: wins.length,
    winRate: n ? (wins.length / n) * 100 : null,
    netUsd: eq - a.startBalance,
    returnPct: a.startBalance ? ((eq - a.startBalance) / a.startBalance) * 100 : 0,
    avgR: n ? mean(rs) : null,
    lcbR: lcb(rs),
    avgRSlip: n ? mean(rsSlip) : null,
    lcbRSlip: lcb(rsSlip),
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
    maxDrawdownPct: maxDd * 100,
    positiveWeeksPct: weeks ? ([...weekly.values()].filter((v) => v > 0).length / weeks) * 100 : null,
    weeks,
    liquidations: list.filter((t) => t.exit_reason === "liquidation").length,
    busted: a.busted,
    score: 0,
    verdict: "needs_data",
    verdictReason: "",
  };
  s.score = readinessScore(s);
  Object.assign(s, verdictOf(s));
  return s;
}

/**
 * 0–100. Weights: edge after slippage (lower confidence bound) 35, sample size 20,
 * profit factor 15, weekly consistency 15, drawdown 15. Below 30 trades every part
 * but the sample size is scaled down, so a short lucky streak can't top the ranking.
 * A busted account scores 0.
 */
export function readinessScore(s: SetupStats) {
  if (s.busted || !s.trades) return 0;
  const conf = clamp(s.trades / 30, 0, 1);
  const parts: [number, number][] = [
    [35, conf * clamp((s.lcbRSlip ?? s.avgRSlip ?? 0) / 0.3)],
    [20, clamp(s.trades / 50, 0, 1)],
    [15, conf * (s.profitFactor == null ? (s.wins ? 1 : -1) : clamp(s.profitFactor - 1))],
    [15, conf * (s.positiveWeeksPct == null ? 0 : clamp((s.positiveWeeksPct - 50) / 50))],
    [15, conf * (1 - 2 * clamp(s.maxDrawdownPct / 30, 0, 1))],
  ];
  const total = parts.reduce((x, [w]) => x + w, 0);
  const v = parts.reduce((x, [w, p]) => x + w * p, 0) / total;
  return Math.round(clamp(50 + 50 * v, 0, 100));
}

export function verdictOf(s: SetupStats): { verdict: Verdict; verdictReason: string } {
  const pf = s.profitFactor == null ? "∞" : s.profitFactor.toFixed(2);
  if (s.busted) return { verdict: "avoid", verdictReason: "The account is busted." };
  if (s.trades < 10) return { verdict: "needs_data", verdictReason: `Only ${s.trades} closed trades: too few to tell skill from luck.` };
  if (s.trades >= 20 && (s.avgRSlip ?? 0) < 0)
    return { verdict: "avoid", verdictReason: `Loses ${(s.avgRSlip ?? 0).toFixed(2)}R per trade after slippage over ${s.trades} trades.` };
  if (s.trades >= 30 && (s.lcbRSlip ?? -1) > 0 && (s.profitFactor == null || s.profitFactor >= 1.3) && s.maxDrawdownPct <= 25 && (s.positiveWeeksPct ?? 0) >= 50)
    return {
      verdict: "live_ready",
      verdictReason: `Positive edge even at the 95% confidence bound after slippage (${(s.lcbRSlip ?? 0).toFixed(2)}R), PF ${pf}, max drawdown ${s.maxDrawdownPct.toFixed(1)}%, ${Math.round(s.positiveWeeksPct ?? 0)}% winning weeks.`,
    };
  if ((s.avgRSlip ?? 0) > 0 && (s.profitFactor == null || s.profitFactor > 1.1))
    return {
      verdict: "promising",
      verdictReason: `Profitable after slippage (${(s.avgRSlip ?? 0).toFixed(2)}R per trade, PF ${pf}), but ${s.trades < 30 ? `${s.trades} trades isn't enough yet` : "the edge isn't statistically clear yet or the drawdown is too deep"}.`,
    };
  return { verdict: "unproven", verdictReason: `No clear edge yet: ${(s.avgRSlip ?? 0).toFixed(2)}R per trade after slippage, PF ${pf}.` };
}

export interface Rankings {
  /** Highest readiness score: the best candidate for real trading. */
  best: SetupStats[];
  /** Highest edge per trade we can count on (confidence bound after slippage), min 10 trades. */
  effective: SetupStats[];
  /** Highest account return. */
  highestReturn: SetupStats[];
}

export function rankSetups(all: SetupStats[], top = 5): Rankings {
  const by = (f: (s: SetupStats) => number) => (x: SetupStats, y: SetupStats) => f(y) - f(x);
  return {
    best: [...all].filter((s) => s.trades > 0).sort(by((s) => s.score + s.trades / 1e4)).slice(0, top),
    effective: [...all].filter((s) => s.trades >= 10 && !s.busted).sort(by((s) => s.lcbRSlip ?? -9)).slice(0, top),
    highestReturn: [...all].filter((s) => s.trades > 0).sort(by((s) => s.returnPct)).slice(0, top),
  };
}

// ───────────────────────── Period and timing breakdowns ─────────────────────────

export interface Bucket {
  label: string;
  start: number; // ms
  trades: number;
  wins: number;
  netUsd: number;
  sumR: number;
}

function bucketize(trades: AnalysisTrade[], key: (ms: number) => [number, string]) {
  const m = new Map<number, Bucket>();
  for (const t of trades) {
    const [start, label] = key(+new Date(t.closed_at));
    const b = m.get(start) ?? { label, start, trades: 0, wins: 0, netUsd: 0, sumR: 0 };
    b.trades++;
    if (t.net_pnl > 0) b.wins++;
    b.netUsd += t.net_pnl;
    b.sumR += t.r_multiple;
    m.set(start, b);
  }
  return [...m.values()].sort((a, b) => a.start - b.start);
}

export type ReportKind = "hourly" | "daily" | "weekly" | "monthly";
export const REPORT_KINDS: ReportKind[] = ["hourly", "daily", "weekly", "monthly"];

/** The most recent fully closed period of each kind, as [start, end) in ms (UTC). */
export function lastClosedPeriod(kind: ReportKind, now: number): [number, number] {
  const H = 3600_000;
  const D = 24 * H;
  if (kind === "hourly") {
    const end = Math.floor(now / H) * H;
    return [end - H, end];
  }
  if (kind === "daily") {
    const end = Math.floor(now / D) * D;
    return [end - D, end];
  }
  if (kind === "weekly") {
    const end = weekStart(now);
    return [end - 7 * D, end];
  }
  const d = new Date(now);
  const end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1);
  return [start, end];
}

/** Sub-buckets of a report period: hours for a day, days for a week, weeks for a month. */
export function periodBuckets(kind: ReportKind, trades: AnalysisTrade[]) {
  const iso = (ms: number) => new Date(ms).toISOString();
  if (kind === "hourly") return bucketize(trades, (ms) => [Math.floor(ms / 600_000) * 600_000, iso(Math.floor(ms / 600_000) * 600_000).slice(11, 16)]);
  if (kind === "daily") return bucketize(trades, (ms) => [Math.floor(ms / 3600_000) * 3600_000, `${iso(Math.floor(ms / 3600_000) * 3600_000).slice(11, 13)}:00`]);
  if (kind === "weekly") return bucketize(trades, (ms) => [Math.floor(ms / 86400_000) * 86400_000, iso(Math.floor(ms / 86400_000) * 86400_000).slice(0, 10)]);
  return bucketize(trades, (ms) => [weekStart(ms), `week of ${iso(weekStart(ms)).slice(5, 10)}`]);
}

export interface TimingRow {
  key: string;
  trades: number;
  winRate: number;
  avgR: number;
  sumR: number;
}

/** All-time results by entry hour (UTC), weekday and session: when do the bots do well? */
export function timing(trades: AnalysisTrade[]) {
  const group = (key: (t: AnalysisTrade) => string, order: string[]) => {
    const m = new Map<string, AnalysisTrade[]>();
    for (const t of trades) m.set(key(t), [...(m.get(key(t)) ?? []), t]);
    return order
      .filter((k) => m.has(k))
      .map((k): TimingRow => {
        const l = m.get(k)!;
        const sumR = l.reduce((s, t) => s + t.r_multiple, 0);
        return { key: k, trades: l.length, winRate: (l.filter((t) => t.net_pnl > 0).length / l.length) * 100, avgR: sumR / l.length, sumR };
      });
  };
  const opened = (t: AnalysisTrade) => new Date(t.opened_at);
  const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  return {
    byHour: group((t) => String(opened(t).getUTCHours()).padStart(2, "0"), Array.from({ length: 24 }, (_, h) => String(h).padStart(2, "0"))),
    byWeekday: group((t) => days[(opened(t).getUTCDay() + 6) % 7], days),
    bySession: group((t) => sessionOf(+opened(t)), ["asia", "europe", "us", "late"]),
  };
}
