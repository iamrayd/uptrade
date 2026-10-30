import type { Candle, ExitReason, Side, StrategyDef } from "./types.ts";
import { breakevenStop, checkExit, MAKER_FEE, reachedR, TAKER_FEE, tighterStop } from "./risk.ts";
import { baseKey, CONFLUENCE } from "./confluence.ts";

// Performance analysis and learning for the strategy bots. Pure functions, no I/O,
// so the analyzer (analyze.ts), the live engine (tick.ts) and the tests share them.
//
//  - entryFeatures: the scale-free facts about an entry (stop width, trend strength,
//    session, confluence score, news, …) that lessons can filter on. The same function
//    runs on a live signal and on a journaled trade, so a lesson means the same thing
//    in both places.
//  - mistake tags: named, a-priori entry mistakes (stop inside the noise, weak trend, …).
//    Each is also a yes/no feature, so a recurring mistake becomes a lesson with far fewer
//    guesses (and a lower statistical bar) than a blind search over thresholds.
//  - reviewTrade:   a post-mortem of one closed trade: what went wrong, why, and the fix.
//  - setupStats / rankSetups: robust scores for each strategy × timeframe. A setup only
//    ranks high if its edge survives a confidence bound, extra slippage and drawdown.
//  - mineLessons / evaluateRule: entry filters learned from losing trades AND from shadow
//    signals (entries a gate blocked, or a busted bot could not take, replayed afterwards),
//    so a bot keeps learning when it trades little. A filter is learned on the oldest 70%
//    of the data and must also hold on the newest 30%, which it never saw, before it is used.
//  - simulateSignal: what a blocked signal would have done, so lessons that turn out to
//    cost money get retired.
//  - lessonImpact / tagStats: did entries get better after the lessons switched on?

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

// ───────────────────────── Entry features ─────────────────────────

export type FeatureValue = number | string;

/** What each feature means, for lesson titles and the AI prompt. */
export const FEATURES: Record<string, { label: string; kind: "number" | "category"; unit?: string }> = {
  stopPct: { label: "stop distance", kind: "number", unit: "% of price" },
  atrPct: { label: "volatility (ATR)", kind: "number", unit: "% of price" },
  stopAtr: { label: "stop distance in ATRs", kind: "number", unit: "ATR" },
  adx14: { label: "ADX (trend strength)", kind: "number" },
  diEdge: { label: "DMI lead in the trade's direction", kind: "number", unit: "DI points" },
  rsi: { label: "RSI", kind: "number" },
  rsiPrev: { label: "RSI on the previous bar", kind: "number" },
  volumeX: { label: "volume vs its 20-bar average", kind: "number", unit: "×" },
  trendDistPct: { label: "distance from EMA 200 in the trade's direction", kind: "number", unit: "%" },
  bandWidthPct: { label: "Bollinger band width", kind: "number", unit: "% of price" },
  confluence: { label: "confluence score (indicators that agree)", kind: "number", unit: "of 100" },
  htfAlign: { label: "next-timeframe-up trend vs the trade (1 with, 0 mixed, −1 against)", kind: "number" },
  newsScore: { label: "crypto-news sentiment in the trade's direction (−1 to +1)", kind: "number" },
  newsRisk: { label: "recent high-impact news risk (0 to 1)", kind: "number" },
  fng: { label: "Fear & Greed index", kind: "number" },
  side: { label: "direction", kind: "category" },
  symbol: { label: "coin", kind: "category" },
  session: { label: "UTC session", kind: "category" },
  weekend: { label: "weekend", kind: "category" },
};

// Each confluence check's own result (confluence.ts stores them as cf_<key> = 1/0 with every
// entry), as a yes/no lesson feature. Weight-0 checks become learnable this way.
const CF_CHECKS: Record<string, string> = {
  stopSane: "the stop clears normal noise",
  trend200: "price on the trade's side of EMA 200",
  emaStack: "EMA 50 stack agrees",
  momentum: "MACD histogram points the trade's way",
  strength: "ADX ≥ 20 with the DMI lead",
  notStretched: "not a stretched chase",
  volume: "volume not drying up",
  supertrend: "Supertrend agrees",
  htf: "the next timeframe up agrees",
  range: "a range, not a trend (ADX ≤ 25)",
  rsiTurn: "RSI already turning back",
};
for (const [k, label] of Object.entries(CF_CHECKS)) FEATURES[`cf_${k}`] = { label: `confluence check: ${label}`, kind: "category" };

/** Market session of a UTC time: asia 00–07, europe 07–13, us 13–21, late 21–24. */
export function sessionOf(ms: number) {
  const h = new Date(ms).getUTCHours();
  return h < 7 ? "asia" : h < 13 ? "europe" : h < 21 ? "us" : "late";
}

const round = (n: number, d = 4) => +n.toFixed(d);

/** Scale-free features of an entry. Price-level indicators are turned into percentages so one rule works on every coin. */
export function entryFeatures(a: { side: Side; entry: number; stop: number; symbol: string; at: number; indicators: Record<string, number>; strategy?: string }): Record<string, FeatureValue> {
  const ind = a.indicators;
  const sign = a.side === "long" ? 1 : -1;
  const close = ind.close ?? a.entry;
  const f: Record<string, FeatureValue> = {
    side: a.side,
    symbol: a.symbol,
    session: sessionOf(a.at),
    weekend: [0, 6].includes(new Date(a.at).getUTCDay()) ? "yes" : "no",
  };
  if (a.entry > 0) f.stopPct = round((Math.abs(a.entry - a.stop) / a.entry) * 100);
  if (ind.atr14 && close) {
    f.atrPct = round((ind.atr14 / close) * 100);
    f.stopAtr = round(Math.abs(a.entry - a.stop) / ind.atr14, 3);
  }
  for (const k of ["adx14", "rsi", "rsiPrev", "volumeX"]) if (Number.isFinite(ind[k])) f[k] = ind[k];
  if (Number.isFinite(ind.plusDI) && Number.isFinite(ind.minusDI)) f.diEdge = round(sign * (ind.plusDI - ind.minusDI), 2);
  if (ind.ema200) f.trendDistPct = round(((sign * (close - ind.ema200)) / ind.ema200) * 100);
  if (ind.bbUpper && ind.bbLower && ind.bbMid) f.bandWidthPct = round(((ind.bbUpper - ind.bbLower) / ind.bbMid) * 100);
  if (Number.isFinite(ind.cfScore)) f.confluence = ind.cfScore;
  if (Number.isFinite(ind.cfHtf)) f.htfAlign = ind.cfHtf;
  // The gate threshold this entry was judged against (per-setup); the low_confluence tag reads it.
  if (Number.isFinite(ind.cfMin)) f.cfMin = ind.cfMin;
  for (const k of Object.keys(CF_CHECKS)) if (Number.isFinite(ind[`cf_${k}`])) f[`cf_${k}`] = ind[`cf_${k}`] >= 1 ? "yes" : "no";
  // News sentiment is stored for the market; as a feature it is signed by the trade's direction.
  if (Number.isFinite(ind.newsScore)) f.newsScore = round(sign * ind.newsScore, 3);
  if (Number.isFinite(ind.newsRisk)) f.newsRisk = round(ind.newsRisk, 3);
  if (Number.isFinite(ind.fng)) f.fng = ind.fng;
  if (a.strategy) Object.assign(f, tagFeatures(a.strategy, f));
  return f;
}

export const tradeFeatures = (t: AnalysisTrade) =>
  entryFeatures({ side: t.side, entry: t.entry_price, stop: t.initial_stop, symbol: t.symbol, at: +new Date(t.opened_at), indicators: t.entry_indicators ?? {}, strategy: t.strategy });

// ───────────────────────── Lesson rules ─────────────────────────

/** "Skip the entry when <feature> <op> <value>". */
export interface LessonRule {
  feature: string;
  op: "lt" | "gte" | "eq";
  value: FeatureValue;
}

/** True if the rule says to skip an entry with these features. A missing feature never blocks. */
export function ruleBlocks(rule: LessonRule, f: Record<string, FeatureValue>) {
  const v = f[rule.feature];
  if (v == null) return false;
  if (rule.op === "eq") return String(v) === String(rule.value);
  if (typeof v !== "number") return false;
  return rule.op === "lt" ? v < +rule.value : v >= +rule.value;
}

export function describeRule(rule: LessonRule) {
  const meta = FEATURES[rule.feature];
  const label = meta?.label ?? rule.feature;
  if (rule.feature.startsWith("mk_") && rule.op === "eq") return `the entry shows the mistake "${label}"`;
  if (rule.op === "eq") return `${label} is ${rule.value}`;
  const unit = meta?.unit && meta.unit !== "×" ? ` ${meta.unit}` : meta?.unit ?? "";
  return `${label} ${rule.op === "lt" ? "below" : "at or above"} ${+(+rule.value).toPrecision(4)}${unit}`;
}

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
  /** Context that made the entry weaker, from the entry's own indicator readings. */
  flags: string[];
  /** Machine-readable keys of the mistakes in `flags` (see MISTAKE_TAGS). */
  tags?: string[];
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
  const f = tradeFeatures(t);
  const tagged = mistakeTags(t.strategy, f);
  const flags = tagged.map((m) => m.text);
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
  return { v: 1, outcome, category, title: meta.title, why, fix: meta.fix, mfeR, maeR, afterExitR, afterExitBars: after.length || null, flags, tags: tagged.map((m) => m.tag) };
}

const TREND_STRATS = new Set(["ema_trend", "macd_adx", "supertrend", "donchian"]);

// ───────────────────────── Mistake tags ─────────────────────────

export interface MistakeTagDef {
  key: string;
  /** Short name; also the lesson's wording ("the entry shows the mistake …"). */
  label: string;
  /** The sentence when the entry shows this mistake, "" when it does not, null when it can't be told (feature missing or not applicable). */
  test(strategy: string, f: Record<string, FeatureValue>): string | null;
}

const fnum = (f: Record<string, FeatureValue>, k: string) => (typeof f[k] === "number" ? (f[k] as number) : null);

/** The entry mistakes the bots are known to make, in the order they are listed. Strategy keys are matched without the "_news" suffix. */
export const MISTAKE_TAGS: MistakeTagDef[] = [
  {
    key: "noise_stop",
    label: "stop inside the noise",
    test: (_s, f) => {
      const v = fnum(f, "stopAtr");
      return v == null ? null : v < 1 ? `The stop was only ${v.toFixed(2)} ATR away: inside normal bar-to-bar noise.` : "";
    },
  },
  {
    key: "weak_trend",
    label: "weak trend for a trend entry",
    test: (s, f) => {
      const v = fnum(f, "adx14");
      return v == null || !TREND_STRATS.has(baseKey(s)) ? null : v < 20 ? `ADX was ${v.toFixed(1)}: a weak trend for a trend-following entry.` : "";
    },
  },
  {
    key: "fading_trend",
    label: "fading a strong trend",
    test: (s, f) => {
      const v = fnum(f, "adx14");
      return v == null || baseKey(s) !== "bb_rsi" ? null : v > 28 ? `ADX was ${v.toFixed(1)}: a fairly strong trend to fade.` : "";
    },
  },
  {
    key: "stretched_entry",
    label: "chasing a stretched move",
    test: (s, f) => {
      const v = fnum(f, "rsi");
      if (v == null || baseKey(s) === "bb_rsi" || (f.side !== "long" && f.side !== "short")) return null;
      if (f.side === "long" && v > 70) return `RSI was ${v.toFixed(0)} on a long: buying an already stretched move.`;
      if (f.side === "short" && v < 30) return `RSI was ${v.toFixed(0)} on a short: selling an already stretched move.`;
      return "";
    },
  },
  {
    key: "counter_trend",
    label: "against the EMA 200 trend",
    test: (s, f) => {
      const v = fnum(f, "trendDistPct");
      if (v == null) return null;
      // A fade trades against the trend by design; it only counts when it is far against it.
      const limit = baseKey(s) === "bb_rsi" ? -5 : 0;
      return v < limit ? `The entry was against the EMA 200 trend (${v.toFixed(2)}%).` : "";
    },
  },
  {
    key: "late_entry",
    label: "late entry in an extended trend",
    test: (_s, f) => {
      const v = fnum(f, "trendDistPct");
      return v == null ? null : v > 8 ? `Price was already ${v.toFixed(1)}% past EMA 200: a late entry in an extended trend.` : "";
    },
  },
  {
    key: "thin_volume",
    label: "below-average volume",
    test: (_s, f) => {
      const v = fnum(f, "volumeX");
      return v == null ? null : v < 1 ? `Volume was below average (${v.toFixed(2)}×).` : "";
    },
  },
  {
    key: "dmi_against",
    label: "DMI favoured the other side",
    test: (s, f) => {
      const v = fnum(f, "diEdge");
      return v == null || baseKey(s) === "bb_rsi" ? null : v < 0 ? "The DMI favoured the other direction." : "";
    },
  },
  {
    key: "weekend",
    label: "weekend entry",
    test: (_s, f) => (f.weekend == null ? null : f.weekend === "yes" ? "Weekend entry: thinner liquidity." : ""),
  },
  {
    key: "low_confluence",
    label: "too few indicators agreed",
    test: (_s, f) => {
      const v = fnum(f, "confluence");
      const min = fnum(f, "cfMin") ?? CONFLUENCE.minScore;
      return v == null ? null : v < min ? `Only ${v.toFixed(0)}/100 of the confirming indicators agreed (this setup needs ${min}).` : "";
    },
  },
  {
    key: "htf_conflict",
    label: "against the higher-timeframe trend",
    test: (_s, f) => {
      const v = fnum(f, "htfAlign");
      return v == null ? null : v < 0 ? "The next timeframe up was trending against this entry." : "";
    },
  },
  {
    key: "bad_news",
    label: "news was against the trade",
    test: (_s, f) => {
      const v = fnum(f, "newsScore");
      return v == null ? null : v <= -0.25 ? `Crypto news leaned against this direction (${v.toFixed(2)}).` : "";
    },
  },
  {
    key: "event_risk",
    label: "entered into a news event",
    test: (_s, f) => {
      const v = fnum(f, "newsRisk");
      return v == null ? null : v >= 0.4 ? "A high-impact news event was fresh when this entry was taken." : "";
    },
  },
];

// Each tag is also a yes/no lesson feature.
for (const t of MISTAKE_TAGS) FEATURES[`mk_${t.key}`] = { label: t.label, kind: "category" };

/** yes/no features for every tag that can be told for this entry. */
export function tagFeatures(strategy: string, f: Record<string, FeatureValue>): Record<string, FeatureValue> {
  const out: Record<string, FeatureValue> = {};
  for (const t of MISTAKE_TAGS) {
    const r = t.test(strategy, f);
    if (r != null) out[`mk_${t.key}`] = r ? "yes" : "no";
  }
  return out;
}

/** The mistakes this entry shows, with a plain-language sentence each. */
export function mistakeTags(strategy: string, f: Record<string, FeatureValue>): { tag: string; label: string; text: string }[] {
  return MISTAKE_TAGS.flatMap((t) => {
    const r = t.test(strategy, f);
    return r ? [{ tag: t.key, label: t.label, text: r }] : [];
  });
}

/** Plain-language warnings about the entry context, from the readings at the signal. */
export const contextFlags = (strategy: string, f: Record<string, FeatureValue>): string[] => mistakeTags(strategy, f).map((m) => m.text);

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

// ───────────────────────── Learning: entry filters ─────────────────────────

export const LEARN = {
  /** Entries (trades plus replayed shadow signals) a scope needs before anything is learned from it. */
  minTrades: 30,
  /** Oldest share used to learn; the rest is the out-of-sample check. */
  trainShare: 0.7,
  /** A filter may skip at most this share of the training entries. */
  maxBlockedShare: 0.5,
  /** Blocked training entries must average at most this R. */
  maxBlockedAvgR: -0.25,
  /** Kept training entries must beat the scope's average by this much R. */
  minLift: 0.1,
  /** Total R the filter must have saved in training. */
  minSavedR: 2,
  /**
   * Welch t-statistic (kept vs blocked R) the filter needs on the training entries. Dozens of
   * candidate filters are tried per setup, so a plain 95% bar would pass noise; ~3 is roughly
   * a Bonferroni-corrected bar for that many tries.
   */
  minTrainT: 3,
  /** Out-of-sample entries the filter must block to count as confirmed. */
  minTestBlocked: 4,
  /** Welch t-statistic the filter needs on the newer entries (same direction, weaker bar). */
  minTestT: 1,
  /** Active lessons per setup. A backstop: maxTotalBlockShare is the real guard against filtering a bot out of trading. */
  maxActivePerAccount: 8,
  /** All active lessons together may skip at most this share of a setup's signals. */
  maxTotalBlockShare: 0.6,
  /** Blocked signals checked before a lesson can be retired. */
  retireAfter: 8,
  /** Retire when the signals a lesson blocked would have averaged at least this R (after slippage). */
  retireAvgR: 0.1,
  /** A lesson is also judged on its latest blocked signals, so a filter that stopped working is caught even when its early record was good. */
  retireWindow: 12,
};

/**
 * Mistake-tag lessons test one of ~13 named, a-priori hypotheses instead of dozens of blind
 * thresholds, so the multiple-comparison burden is far lower and the bars can be, too.
 */
export const LEARN_TAG: typeof LEARN = { ...LEARN, minTrades: 20, maxBlockedAvgR: -0.15, minSavedR: 1.5, minTrainT: 2, minTestBlocked: 3 };

const cfgFor = (rule: Pick<LessonRule, "feature">) => (rule.feature.startsWith("mk_") ? LEARN_TAG : LEARN);

export interface RuleEvidence {
  train: { n: number; blocked: number; blockedAvgR: number; keptAvgR: number; allAvgR: number; savedR: number; t: number };
  test: { n: number; blocked: number; blockedAvgR: number | null; keptAvgR: number | null; allAvgR: number; t: number };
  passed: boolean;
  why: string;
}

function split<T>(xs: T[], pred: (x: T) => boolean): [T[], T[]] {
  const a: T[] = [];
  const b: T[] = [];
  for (const x of xs) (pred(x) ? a : b).push(x);
  return [a, b];
}
const avgR = (l: { r: number }[]) => (l.length ? l.reduce((s, x) => s + x.r, 0) / l.length : null);

/** Welch t-statistic of mean(kept) − mean(blocked). Large and positive: the blocked trades really are worse. */
export function welchT(kept: number[], blocked: number[]) {
  if (kept.length < 2 || blocked.length < 2) return 0;
  // A floor on the variance keeps all-identical outcomes (e.g. every blocked trade at −1R) from dividing by zero.
  const v = (xs: number[]) => Math.max(sd(xs) ** 2, 0.05);
  return (mean(kept) - mean(blocked)) / Math.sqrt(v(kept) / kept.length + v(blocked) / blocked.length);
}

/**
 * A signal the bot did not trade, replayed afterwards (bot_filtered_signals). It is learning data
 * like a trade: a busted bot, a gate and a lesson all leave these behind.
 */
export interface ShadowSignal {
  id?: string;
  strategy: string;
  timeframe: string;
  features: Record<string, FeatureValue>;
  /** R of the replay, after slippage. */
  outcome_r: number;
  /** Why it was not traded: lesson | confluence | cooldown | news | busted. */
  reason: string;
  signal_bar_time: string;
  lesson_ids?: string[];
}

interface Row {
  r: number;
  f: Record<string, FeatureValue>;
  /** Entry time (ms): what the oldest-first split orders by. */
  t: number;
  strategy: string;
  timeframe: string;
}

const tradeRow = (t: AnalysisTrade): Row => ({ r: slippedR(t), f: tradeFeatures(t), t: +new Date(t.opened_at), strategy: t.strategy, timeframe: t.timeframe });
// Tags are recomputed so signals logged before a tag existed still carry it.
const shadowRow = (s: ShadowSignal): Row => ({
  r: s.outcome_r,
  f: { ...s.features, ...tagFeatures(s.strategy, s.features) },
  t: +new Date(s.signal_bar_time),
  strategy: s.strategy,
  timeframe: s.timeframe,
});
const toRows = (trades: AnalysisTrade[], shadow: ShadowSignal[] = []): Row[] => [...trades.map(tradeRow), ...shadow.map(shadowRow)].sort((x, y) => x.t - y.t);

/** Checks a rule on a scope's entries (oldest first): learned on the first 70%, confirmed on the rest. */
export function evaluateRule(trades: AnalysisTrade[], rule: LessonRule, shadow: ShadowSignal[] = []): RuleEvidence {
  return evaluateRows(toRows(trades, shadow), rule);
}

function evaluateRows(rows: Row[], rule: LessonRule, cfg: typeof LEARN = cfgFor(rule)): RuleEvidence {
  const cut = Math.floor(rows.length * cfg.trainShare);
  const train = rows.slice(0, cut);
  const test = rows.slice(cut);
  const [tb, tk] = split(train, (x) => ruleBlocks(rule, x.f));
  const [sb, sk] = split(test, (x) => ruleBlocks(rule, x.f));
  const ev: RuleEvidence = {
    train: {
      n: train.length,
      blocked: tb.length,
      blockedAvgR: avgR(tb) ?? 0,
      keptAvgR: avgR(tk) ?? 0,
      allAvgR: avgR(train) ?? 0,
      savedR: -tb.reduce((s, x) => s + x.r, 0),
      t: +welchT(tk.map((x) => x.r), tb.map((x) => x.r)).toFixed(2),
    },
    test: { n: test.length, blocked: sb.length, blockedAvgR: avgR(sb), keptAvgR: avgR(sk), allAvgR: avgR(test) ?? 0, t: +welchT(sk.map((x) => x.r), sb.map((x) => x.r)).toFixed(2) },
    passed: false,
    why: "",
  };
  const t = ev.train;
  const fail = (why: string) => ({ ...ev, why });
  if (rows.length < cfg.minTrades) return fail(`needs ${cfg.minTrades} entries, has ${rows.length}`);
  if (t.blocked < Math.max(5, 0.1 * t.n)) return fail("blocks too few training entries");
  if (t.blocked > cfg.maxBlockedShare * t.n) return fail("would skip too many entries");
  if (t.blockedAvgR > cfg.maxBlockedAvgR) return fail("the entries it blocks weren't bad enough");
  if (t.keptAvgR - t.allAvgR < cfg.minLift) return fail("doesn't lift the remaining entries enough");
  if (t.savedR < cfg.minSavedR) return fail("saves too little R");
  if (t.t < cfg.minTrainT) return fail(`not statistically clear (t = ${t.t.toFixed(1)}, need ${cfg.minTrainT})`);
  const s = ev.test;
  if (s.blocked < cfg.minTestBlocked) return fail("not enough newer entries to confirm it");
  if ((s.blockedAvgR ?? 0) >= 0) return fail("the newer entries it would block were not losers");
  if ((s.keptAvgR ?? -9) <= s.allAvgR) return fail("doesn't improve the newer entries");
  if (s.t < cfg.minTestT) return fail(`too weak on the newer entries (t = ${s.t.toFixed(1)})`);
  return { ...ev, passed: true, why: "confirmed on newer entries" };
}

/** Candidate rules for a scope: quantile thresholds on numeric features, every value of categorical ones. */
export function candidateRules(trades: AnalysisTrade[], shadow: ShadowSignal[] = []): LessonRule[] {
  return candidatesFromRows(toRows(trades, shadow));
}

function candidatesFromRows(rows: Row[]): LessonRule[] {
  const feats = rows.map((x) => x.f);
  const out: LessonRule[] = [];
  for (const [key, meta] of Object.entries(FEATURES)) {
    const vals = feats.map((f) => f[key]).filter((v) => v != null);
    if (vals.length < 0.9 * rows.length) continue;
    if (meta.kind === "category") {
      const counts = new Map<string, number>();
      for (const v of vals) counts.set(String(v), (counts.get(String(v)) ?? 0) + 1);
      if (counts.size < 2) continue;
      // A mistake tag only ever blocks the entries that show it.
      for (const [v, c] of counts) if (c >= 5 && (!key.startsWith("mk_") || v === "yes")) out.push({ feature: key, op: "eq", value: v });
    } else {
      const nums = (vals as number[]).slice(0, Math.floor(rows.length * LEARN.trainShare)).sort((a, b) => a - b);
      if (nums.length < 10) continue;
      const qs = new Set<number>();
      for (let q = 0.2; q <= 0.81; q += 0.1) qs.add(+nums[Math.floor(q * (nums.length - 1))].toPrecision(3));
      for (const v of qs) {
        out.push({ feature: key, op: "lt", value: v });
        out.push({ feature: key, op: "gte", value: v });
      }
    }
  }
  return out;
}

export interface MinedLesson {
  strategy: string;
  timeframe: string | null;
  rule: LessonRule;
  title: string;
  explanation: string;
  evidence: RuleEvidence;
}

export function lessonText(strategy: string, timeframe: string | null, rule: LessonRule, ev: RuleEvidence) {
  const scope = timeframe ? `${strategy} ${timeframe}` : `${strategy} (all timeframes)`;
  const r = (n: number | null) => (n == null ? "?" : `${n >= 0 ? "+" : ""}${n.toFixed(2)}R`);
  return {
    title: `${scope}: skip entries when ${describeRule(rule)}`,
    explanation:
      `Losing entries clustered where ${describeRule(rule)}: on the older ${ev.train.n} entries (trades plus skipped signals that were replayed), the ${ev.train.blocked} such entries averaged ${r(ev.train.blockedAvgR)} ` +
      `vs ${r(ev.train.keptAvgR)} for the rest (${ev.train.savedR.toFixed(1)}R lost). It held on the ${ev.test.n} newer entries it wasn't learned from: ` +
      `${ev.test.blocked} such entries averaged ${r(ev.test.blockedAvgR)} vs ${r(ev.test.keptAvgR)} for the rest. R includes ${SLIPPAGE * 100}% slippage per side.`,
  };
}

/**
 * Learns at most one new filter per scope (strategy × timeframe, then strategy-wide).
 * `taken` holds "strategy|timeframe|feature|op" keys that already have a lesson.
 * Entries that a current lesson (`inForce`: active or proposed) would have skipped are left
 * out, so each new lesson targets the losers the existing ones still let through. Shadow
 * signals count as entries, so a bot that trades little (or is busted) still has data.
 * A new lesson is refused if, with the existing ones, it would skip more than
 * LEARN.maxTotalBlockShare of the scope's signals.
 */
export function mineLessons(
  trades: AnalysisTrade[],
  taken: Set<string>,
  inForce: (LessonRule & { strategy: string; timeframe: string | null })[] = [],
  shadow: ShadowSignal[] = [],
): MinedLesson[] {
  const scopes = new Map<string, { all: number; kept: Row[] }>();
  for (const x of toRows(trades, shadow)) {
    const blocked = inForce.some((l) => l.strategy === x.strategy && (l.timeframe == null || l.timeframe === x.timeframe) && ruleBlocks(l, x.f));
    for (const k of [`${x.strategy}|${x.timeframe}`, `${x.strategy}|*`]) {
      const sc = scopes.get(k) ?? { all: 0, kept: [] };
      sc.all++;
      if (!blocked) sc.kept.push(x);
      scopes.set(k, sc);
    }
  }
  const out: MinedLesson[] = [];
  for (const [k, sc] of scopes) {
    const rows = sc.kept;
    if (rows.length < LEARN_TAG.minTrades) continue;
    const [strategy, tf] = k.split("|");
    const timeframe = tf === "*" ? null : tf;
    const alreadyBlocked = sc.all - rows.length;
    let best: { rule: LessonRule; ev: RuleEvidence } | null = null;
    for (const rule of candidatesFromRows(rows)) {
      if (taken.has(lessonKey(strategy, timeframe, rule))) continue;
      const ev = evaluateRows(rows, rule);
      if (!ev.passed || (best && ev.train.savedR <= best.ev.train.savedR)) continue;
      if (alreadyBlocked + rows.filter((x) => ruleBlocks(rule, x.f)).length > LEARN.maxTotalBlockShare * sc.all) continue;
      best = { rule, ev };
    }
    if (!best) continue;
    taken.add(lessonKey(strategy, timeframe, best.rule));
    out.push({ strategy, timeframe, rule: best.rule, ...lessonText(strategy, timeframe, best.rule, best.ev), evidence: best.ev });
  }
  return out;
}

export const lessonKey = (strategy: string, timeframe: string | null, rule: Pick<LessonRule, "feature" | "op">) =>
  `${strategy}|${timeframe ?? "*"}|${rule.feature}|${rule.op}`;

// ───────────────────────── Did the lessons help? ─────────────────────────

export interface ImpactRow {
  strategy: string;
  timeframe: string;
  /** Active lessons that apply to this setup. */
  lessons: number;
  /** When the first of them switched on. */
  since: string;
  before: { n: number; avgR: number | null };
  after: { n: number; avgR: number | null };
}

/**
 * Per setup with active lessons: average R (after slippage) of the last `window` trades opened
 * before the first lesson switched on vs every trade opened since. A small `after.n` means the
 * lessons have not been tested by many trades yet.
 */
export function lessonImpact(
  trades: AnalysisTrade[],
  lessons: { strategy: string; timeframe: string | null; status: string; activated_at: string | null }[],
  setups: { strategy: string; timeframe: string }[],
  window = 30,
): ImpactRow[] {
  const out: ImpactRow[] = [];
  for (const s of setups) {
    const mine = lessons.filter((l) => l.status === "active" && l.activated_at && l.strategy === s.strategy && (l.timeframe == null || l.timeframe === s.timeframe));
    if (!mine.length) continue;
    const since = Math.min(...mine.map((l) => +new Date(l.activated_at!)));
    const list = trades.filter((t) => t.strategy === s.strategy && t.timeframe === s.timeframe).sort((x, y) => +new Date(x.opened_at) - +new Date(y.opened_at));
    const before = list.filter((t) => +new Date(t.opened_at) < since).slice(-window);
    const after = list.filter((t) => +new Date(t.opened_at) >= since);
    const m = (l: AnalysisTrade[]) => (l.length ? mean(l.map(slippedR)) : null);
    out.push({ strategy: s.strategy, timeframe: s.timeframe, lessons: mine.length, since: new Date(since).toISOString(), before: { n: before.length, avgR: m(before) }, after: { n: after.length, avgR: m(after) } });
  }
  return out;
}

export interface TagStat {
  tag: string;
  label: string;
  /** Entries showing the mistake / not showing it, with their average R after slippage. */
  withN: number;
  withAvgR: number | null;
  withoutN: number;
  withoutAvgR: number | null;
  /** Total R the entries showing the mistake lost relative to the rest: withN × (withoutAvgR − withAvgR). */
  costR: number;
}

/** How costly each mistake has been across trades and replayed signals, worst first. */
export function tagStats(trades: AnalysisTrade[], shadow: ShadowSignal[] = []): TagStat[] {
  const rows = toRows(trades, shadow);
  return MISTAKE_TAGS.map((t) => {
    const key = `mk_${t.key}`;
    const w = rows.filter((x) => x.f[key] === "yes");
    const o = rows.filter((x) => x.f[key] === "no");
    const wa = avgR(w);
    const oa = avgR(o);
    return { tag: t.key, label: t.label, withN: w.length, withAvgR: wa, withoutN: o.length, withoutAvgR: oa, costR: wa == null || oa == null ? 0 : +(w.length * (oa - wa)).toFixed(2) };
  })
    .filter((x) => x.withN > 0)
    .sort((a, b) => b.costR - a.costR);
}

// ───────────────────────── Counterfactual of a blocked signal ─────────────────────────

export interface SimResult {
  /** False while the trade would still be open (wait for more bars). */
  done: boolean;
  /** R after fees only, the way the live engine computes it. */
  r: number;
  /** R after fees and SLIPPAGE per side: the same basis lessons are learned on, so use this to judge them. */
  rSlip: number;
  reason: ExitReason | "open";
  bars: number;
}

/** How long a replayed signal is followed: about a week of bars, between 24 and 200. Bounds how long a signal stays unresolved. */
export const replayBars = (secondsPerBar: number) => Math.max(24, Math.min(200, Math.floor((7 * 86400) / secondsPerBar)));

/**
 * Replays a signal a lesson blocked, with the strategy's own management, on the
 * strategy-timeframe bars (stop first when a bar touches both, like the backtester).
 * `candles` are closed bars, ascending; `signalIdx` is the signal bar. R is per unit
 * of size, fees included, the same way the live engine computes it.
 */
export function simulateSignal(
  strategy: StrategyDef,
  candles: Candle[],
  signalIdx: number,
  sig: { side: Side; entry: number; stop: number; takeProfit: number | null },
  maxBars = 200,
  /** Also apply the breakeven rule: stop to fee cover once the trade reaches +1R (judging exit management). */
  breakeven = false,
): SimResult {
  const { side, entry } = sig;
  let stop = sig.stop;
  let trailed = false;
  let best: number | null = null;
  const risk = Math.abs(entry - sig.stop) + entry * TAKER_FEE + sig.stop * TAKER_FEE;
  const result = (exit: number, feeRate: number, reason: ExitReason, bars: number): SimResult => {
    const pnl = side === "long" ? exit - entry : entry - exit;
    const r = (pnl - entry * TAKER_FEE - exit * feeRate) / risk;
    return { done: true, r: round(r, 3), rSlip: round(r - (SLIPPAGE * (entry + exit)) / risk, 3), reason, bars };
  };
  let pendingExit: ExitReason | null = null;
  for (let i = signalIdx + 1; i < candles.length; i++) {
    const c = candles[i];
    const bars = i - signalIdx;
    if (pendingExit) return result(c.open, TAKER_FEE, pendingExit, bars);
    const fill = checkExit({ side, stop, takeProfit: sig.takeProfit, liqPrice: 0, trailed }, c);
    if (fill) return result(fill.price, fill.feeRate === MAKER_FEE ? MAKER_FEE : TAKER_FEE, fill.reason, bars);
    if (bars >= maxBars) return result(c.close, TAKER_FEE, "time_exit", bars);
    const hi = side === "long" ? c.high : c.low;
    best = best == null ? hi : side === "long" ? Math.max(best, hi) : Math.min(best, hi);
    const hist = candles.slice(Math.max(0, i + 1 - 600), i + 1);
    const m = strategy.manage(hist, { side, entryPrice: entry, stop, takeProfit: sig.takeProfit, barsHeld: bars });
    if (m.exit) pendingExit = m.exit.reason;
    else {
      // The breakeven rule and the strategy's own trailing stop compete; the tighter one wins (like live).
      let proposed = m.stop ?? undefined;
      if (breakeven && reachedR(side, entry, sig.stop, best)) {
        const be = breakevenStop(side, entry);
        proposed = proposed == null ? be : side === "long" ? Math.max(proposed, be) : Math.min(proposed, be);
      }
      const ns = tighterStop(side, stop, proposed);
      if (ns != null) {
        if (side === "long" ? ns >= c.close : ns <= c.close) pendingExit = "trailing_stop";
        else {
          stop = ns;
          trailed = true;
        }
      }
    }
  }
  return { done: false, r: 0, rSlip: 0, reason: "open", bars: candles.length - 1 - signalIdx };
}
