import type { Candle, Timeframe } from "./types.ts";
import { TF_SECONDS } from "./types.ts";
import { STRATEGIES, STRATEGY_BY_KEY } from "./strategies.ts";
import { lastClosedPeriod, periodBuckets, rankSetups, REVIEW_CATEGORIES, reviewTrade, setupStats, timing, VERDICT_LABEL, type AnalysisTrade, type ReportKind, type SetupStats, type TradeReview } from "./analysis.ts";
import type { AnalysisDb, AnalysisState, Market } from "./io.ts";

// One analysis run. Called hourly by pg_cron → bot-analyze edge function.
//
//  1. Reviews: a post-mortem for every newly closed trade. Losers that were stopped
//     or signalled out wait until a few more bars have closed, so the review can say
//     whether price went on to reach the target without us ("right idea, bad stop").
//  2. Verdicts: each setup's statistics and verdict, stored on the account for the dashboard.
//  3. Reports: for each kind (hourly, daily, weekly, monthly) whose latest period has
//     closed and has no report yet: period results, rankings by rule set, mistakes and
//     timing, plus a written analysis from Claude (or a built-in template).
//
// The analyzer only measures. It never changes what the bots trade: strategy v3 trades every
// signal of its five rule sets, and the owner decides from these reports which to keep.

export interface Narrative {
  headline: string;
  summary: string[];
  ranking_notes: string[];
  mistakes: { title: string; detail: string }[];
  improvements: { scope: string; action: string; rationale: string }[];
  caveats: string[];
}

export type Narrator = (input: { kind: ReportKind; data: ReportData; context: unknown }) => Promise<{ narrative: Narrative; model: string }>;

export interface AnalyzeSummary {
  reviewed: number;
  reviewsDeferred: number;
  /** Accounts whose verdict changed this run. */
  verdictsChanged: number;
  reports: string[];
  aiCalls: number;
  errors: string[];
}

const MAX_CANDLE_FETCHES = 100;
/** Candle requests stop after this long, so the AI write-up still fits in the edge function's time limit. */
const FETCH_BUDGET_MS = 45_000;
/** AI write-ups per run. Each one takes up to a minute and edge functions have a time limit; reports over budget wait for the next run. */
const MAX_AI_CALLS = 1;
/** Bars to watch after a losing exit, to see whether the idea worked without us. */
const postBars = (tf: string) => Math.min(10, Math.floor((3 * 86400) / (TF_SECONDS[tf as Timeframe] ?? 3600)));

const num = (v: unknown) => (v == null ? null : +(v as number));

export function parseTrade(r: Record<string, unknown>): AnalysisTrade {
  return {
    ...(r as unknown as AnalysisTrade),
    qty: +(r.qty as number),
    entry_price: +(r.entry_price as number),
    initial_stop: +(r.initial_stop as number),
    take_profit: num(r.take_profit),
    risk_usd: +(r.risk_usd as number),
    exit_price: +(r.exit_price as number),
    net_pnl: +(r.net_pnl as number),
    r_multiple: r.r_multiple == null ? 0 : +(r.r_multiple as number),
    mfe_price: num(r.mfe_price),
    mae_price: num(r.mae_price),
    entry_indicators: (r.entry_indicators as Record<string, number>) ?? {},
  };
}

export async function runAnalysis(a: {
  market: Market;
  db: AnalysisDb;
  now?: () => number;
  narrator?: Narrator | null;
  /** Report kinds that get an AI write-up (others use the template). */
  aiKinds?: ReportKind[];
}): Promise<AnalyzeSummary> {
  const now = a.now ?? Date.now;
  const aiKinds = new Set(a.aiKinds ?? ["daily", "weekly", "monthly"]);
  const summary: AnalyzeSummary = { reviewed: 0, reviewsDeferred: 0, verdictsChanged: 0, reports: [], aiCalls: 0, errors: [] };
  let fetches = 0;
  const started = performance.now();
  const canFetch = () => fetches < MAX_CANDLE_FETCHES && performance.now() - started < FETCH_BUDGET_MS;
  const klines = async (symbol: string, tf: string, startTime: number, limit: number) => {
    fetches++;
    const tfMs = (TF_SECONDS[tf as Timeframe] ?? 3600) * 1000;
    return (await a.market.klines(symbol, tf, { startTime, limit })).filter((c) => c.time * 1000 + tfMs <= now());
  };

  const state: AnalysisState = await a.db.state();
  const trades = state.trades.map(parseTrade);
  const reviews = new Map<string, TradeReview>();
  for (const r of state.trades) if (r.review) reviews.set(r.id, r.review as TradeReview);
  const categoryOf = new Map(state.trades.filter((r) => r.review_category).map((r) => [r.id, r.review_category as string]));

  // ── 1. Reviews ──
  const newReviews: { id: string; review: TradeReview }[] = [];
  for (const [i, t] of trades.entries()) {
    if (state.trades[i].reviewed) continue;
    const wantsAfter = t.r_multiple <= -0.1 && ["stop_loss", "trailing_stop", "signal"].includes(t.exit_reason);
    let after: Candle[] = [];
    if (wantsAfter) {
      const tfMs = (TF_SECONDS[t.timeframe as Timeframe] ?? 3600) * 1000;
      const n = postBars(t.timeframe);
      const firstBar = (Math.floor(+new Date(t.closed_at) / tfMs) + 1) * tfMs;
      if (now() < firstBar + n * tfMs || !canFetch()) {
        summary.reviewsDeferred++;
        continue;
      }
      try {
        after = (await klines(t.symbol, t.timeframe, firstBar, n)).slice(0, n);
      } catch (e) {
        summary.errors.push(`review ${t.id}: ${msg(e)}`);
        summary.reviewsDeferred++;
        continue;
      }
    }
    const review = reviewTrade(t, after);
    newReviews.push({ id: t.id, review });
    reviews.set(t.id, review);
    categoryOf.set(t.id, review.category);
  }
  await a.db.saveReviews(newReviews);
  summary.reviewed = newReviews.length;

  // ── 2 & 3. Per user: verdicts, then reports ──
  const users = new Set(state.accounts.map((x) => x.user_id));
  const lastReport = new Map(state.last_reports.map((r) => [`${r.user_id}:${r.kind}`, +new Date(r.period_start)]));
  const verdicts: { id: string; verdict: string }[] = [];
  for (const userId of users) {
    try {
      // Only the rule sets that trade today are reported on.
      const accounts = state.accounts.filter((x) => x.user_id === userId && STRATEGY_BY_KEY[x.strategy]);
      const mine = trades.filter((t) => t.user_id === userId && STRATEGY_BY_KEY[t.strategy]);
      const setups = accounts.map((acc) =>
        setupStats({ strategy: acc.strategy, timeframe: acc.timeframe, startBalance: +acc.start_balance, busted: acc.status === "busted", trades: mine.filter((t) => t.account_id === acc.id) }),
      );
      for (const [i, acc] of accounts.entries()) if (setups[i].verdict !== acc.verdict) verdicts.push({ id: acc.id, verdict: setups[i].verdict });

      for (const kind of ["daily", "weekly", "monthly", "hourly"] as ReportKind[]) {
        const [ps, pe] = lastClosedPeriod(kind, now());
        if ((lastReport.get(`${userId}:${kind}`) ?? -Infinity) >= ps) continue;
        const data = buildReport({ kind, ps, pe, trades: mine, setups, reviews, categoryOf });
        let narrative: Narrative = templateNarrative(data);
        let aiModel: string | null = null;
        let aiError: string | null = null;
        const wantsAi = a.narrator != null && aiKinds.has(kind);
        if (wantsAi && summary.aiCalls >= MAX_AI_CALLS && kind !== "hourly") continue; // written up by the next run
        if (a.narrator && wantsAi && summary.aiCalls < MAX_AI_CALLS) {
          summary.aiCalls++;
          try {
            const res = await a.narrator({ kind, data, context: aiContext() });
            narrative = res.narrative;
            aiModel = res.model;
          } catch (e) {
            aiError = msg(e);
          }
        }
        await a.db.saveReport({ user_id: userId, kind, period_start: new Date(ps).toISOString(), period_end: new Date(pe).toISOString(), data, narrative, ai_model: aiModel, ai_error: aiError });
        summary.reports.push(kind);
      }
    } catch (e) {
      summary.errors.push(`user ${userId}: ${msg(e)}`);
    }
  }
  await a.db.saveVerdicts(verdicts);
  summary.verdictsChanged = verdicts.length;
  return summary;
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ───────────────────────── Report data ─────────────────────────

export interface ReportData {
  kind: ReportKind;
  periodStart: string;
  periodEnd: string;
  period: {
    trades: number;
    wins: number;
    netUsd: number;
    sumR: number;
    buckets: ReturnType<typeof periodBuckets>;
    bySetup: { strategy: string; timeframe: string; trades: number; wins: number; netUsd: number; sumR: number }[];
  };
  setups: SetupStats[];
  /** The rule sets over all their timeframes together: the table the owner decides from. */
  strategies: StrategyRow[];
  rankings: ReturnType<typeof rankSetups>;
  timing: ReturnType<typeof timing>;
  mistakes: {
    period: MistakeRow[];
    allTime: MistakeRow[];
    /** The most frequent loss reason per setup, all time. */
    bySetup: { strategy: string; timeframe: string; category: string; title: string; count: number; losses: number; fix: string }[];
    examples: { tradeId: string; strategy: string; timeframe: string; symbol: string; side: string; r: number; title: string; why: string; fix: string }[];
  };
}

/** One rule set over all its timeframes. */
export interface StrategyRow {
  strategy: string;
  name: string;
  trades: number;
  wins: number;
  winRate: number | null;
  netUsd: number;
  avgR: number | null;
  sumR: number;
  profitFactor: number | null;
}

/** Every trading rule set over all its timeframes, best average R first. Rule sets without trades come last. */
export function strategyRows(trades: AnalysisTrade[]): StrategyRow[] {
  return STRATEGIES.map((s) => {
    const list = trades.filter((t) => t.strategy === s.key);
    const wins = list.filter((t) => t.net_pnl > 0);
    const grossWin = wins.reduce((x, t) => x + t.net_pnl, 0);
    const grossLoss = -list.filter((t) => t.net_pnl <= 0).reduce((x, t) => x + t.net_pnl, 0);
    const sumR = list.reduce((x, t) => x + t.r_multiple, 0);
    return {
      strategy: s.key,
      name: s.name,
      trades: list.length,
      wins: wins.length,
      winRate: list.length ? +((wins.length / list.length) * 100).toFixed(1) : null,
      netUsd: +list.reduce((x, t) => x + t.net_pnl, 0).toFixed(4),
      avgR: list.length ? +(sumR / list.length).toFixed(3) : null,
      sumR: +sumR.toFixed(3),
      profitFactor: grossLoss > 0 ? +(grossWin / grossLoss).toFixed(2) : null,
    };
  }).sort((x, y) => (y.avgR ?? -Infinity) - (x.avgR ?? -Infinity));
}

interface MistakeRow {
  category: string;
  title: string;
  count: number;
  sumR: number;
  fix: string;
}

function mistakeRows(list: AnalysisTrade[], categoryOf: Map<string, string>): MistakeRow[] {
  const m = new Map<string, MistakeRow>();
  for (const t of list) {
    if (t.r_multiple > -0.1) continue;
    const cat = categoryOf.get(t.id);
    if (!cat) continue;
    const meta = REVIEW_CATEGORIES[cat];
    const row = m.get(cat) ?? { category: cat, title: meta?.title ?? cat, count: 0, sumR: 0, fix: meta?.fix ?? "" };
    row.count++;
    row.sumR += t.r_multiple;
    m.set(cat, row);
  }
  return [...m.values()].map((x) => ({ ...x, sumR: +x.sumR.toFixed(2) })).sort((x, y) => x.sumR - y.sumR);
}

export function buildReport(a: {
  kind: ReportKind;
  ps: number;
  pe: number;
  trades: AnalysisTrade[];
  setups: SetupStats[];
  reviews: Map<string, TradeReview>;
  categoryOf: Map<string, string>;
}): ReportData {
  const inPeriod = a.trades.filter((t) => {
    const c = +new Date(t.closed_at);
    return c >= a.ps && c < a.pe;
  });
  const setupMap = new Map<string, ReportData["period"]["bySetup"][number]>();
  for (const t of inPeriod) {
    const k = `${t.strategy}:${t.timeframe}`;
    const row = setupMap.get(k) ?? { strategy: t.strategy, timeframe: t.timeframe, trades: 0, wins: 0, netUsd: 0, sumR: 0 };
    row.trades++;
    if (t.net_pnl > 0) row.wins++;
    row.netUsd += t.net_pnl;
    row.sumR += t.r_multiple;
    setupMap.set(k, row);
  }
  const bySetupMistakes: ReportData["mistakes"]["bySetup"] = [];
  for (const s of a.setups) {
    const losers = a.trades.filter((t) => t.strategy === s.strategy && t.timeframe === s.timeframe && t.r_multiple <= -0.1);
    const rows = mistakeRows(losers, a.categoryOf).sort((x, y) => y.count - x.count);
    if (rows[0]) bySetupMistakes.push({ strategy: s.strategy, timeframe: s.timeframe, category: rows[0].category, title: rows[0].title, count: rows[0].count, losses: losers.length, fix: rows[0].fix });
  }
  // Worst losers of the period; if the period had none, the most recent ones.
  const pool = inPeriod.some((t) => t.r_multiple <= -0.1) ? inPeriod : a.trades.slice(-60);
  const examples = pool
    .filter((t) => t.r_multiple <= -0.1 && a.reviews.has(t.id))
    .sort((x, y) => x.r_multiple - y.r_multiple)
    .slice(0, 8)
    .map((t) => {
      const r = a.reviews.get(t.id)!;
      return { tradeId: t.id, strategy: t.strategy, timeframe: t.timeframe, symbol: t.symbol, side: t.side, r: +t.r_multiple.toFixed(2), title: r.title, why: r.why, fix: r.fix };
    });
  const sum = (l: AnalysisTrade[], f: (t: AnalysisTrade) => number) => +l.reduce((s, t) => s + f(t), 0).toFixed(4);
  return {
    kind: a.kind,
    periodStart: new Date(a.ps).toISOString(),
    periodEnd: new Date(a.pe).toISOString(),
    period: {
      trades: inPeriod.length,
      wins: inPeriod.filter((t) => t.net_pnl > 0).length,
      netUsd: sum(inPeriod, (t) => t.net_pnl),
      sumR: sum(inPeriod, (t) => t.r_multiple),
      buckets: periodBuckets(a.kind, inPeriod),
      bySetup: [...setupMap.values()].sort((x, y) => y.netUsd - x.netUsd),
    },
    setups: a.setups,
    strategies: strategyRows(a.trades),
    rankings: rankSetups(a.setups),
    timing: timing(a.trades),
    mistakes: { period: mistakeRows(inPeriod, a.categoryOf), allTime: mistakeRows(a.trades, a.categoryOf), bySetup: bySetupMistakes, examples },
  };
}

/** Background the AI needs: what each rule set does and how the paper accounts trade. */
function aiContext() {
  return {
    strategies: STRATEGIES.map((s) => ({ key: s.key, name: s.name, summary: s.summary, params: s.params })),
    paperTradingAssumptions:
      "Each setup (rule set × timeframe) is a separate $100 paper account trading BTC/ETH/SOL on Binance prices, 2% risk per trade, max 20x isolated leverage, taker fee 0.02%, maker 0%. " +
      "Every signal of a rule set is traded: there is no score, filter, cooldown or learning between a signal and an order. One position per coin per account. " +
      "This is a 2 to 4 week trial of five rule sets; the owner will drop the weak ones and keep the strong ones. " +
      "R = net PnL ÷ planned risk. 'Slip' figures subtract an extra 0.05% per side for real-exchange slippage, which the paper fills do not charge. lcbR is the 95% lower confidence bound of mean R.",
  };
}

// ───────────────────────── Template narrative (no AI) ─────────────────────────

const signR = (n: number | null | undefined) => (n == null ? "?" : `${n >= 0 ? "+" : ""}${n.toFixed(2)}R`);
const usd = (n: number) => `${n < 0 ? "−" : "+"}$${Math.abs(n).toFixed(2)}`;
const label = (s: { strategy: string; timeframe: string | null }) => `${STRATEGY_BY_KEY[s.strategy]?.name ?? s.strategy} ${s.timeframe ?? "(all timeframes)"}`;

export function templateNarrative(d: ReportData): Narrative {
  const p = d.period;
  const span = { hourly: "hour", daily: "day", weekly: "week", monthly: "month" }[d.kind];
  const best = d.rankings.best[0];
  const eff = d.rankings.effective[0];
  const ret = d.rankings.highestReturn[0];
  const ready = d.setups.filter((s) => s.verdict === "live_ready");
  const summary = [
    p.trades
      ? `This ${span}: ${p.trades} closed trades, ${p.wins} winners (${Math.round((p.wins / p.trades) * 100)}%), ${usd(p.netUsd)} net, ${signR(p.sumR)} in total.` +
        (p.bySetup[0] ? ` Best setup: ${label(p.bySetup[0])} (${usd(p.bySetup[0].netUsd)}).` : "") +
        (p.bySetup.length > 1 ? ` Worst: ${label(p.bySetup[p.bySetup.length - 1])} (${usd(p.bySetup[p.bySetup.length - 1].netUsd)}).` : "")
      : `No trades closed this ${span}.`,
    ready.length
      ? `${ready.length} setup${ready.length > 1 ? "s pass" : " passes"} every check for a small live test: ${ready.map(label).join(", ")}.`
      : "No setup has passed every check for live trading yet (30+ trades, positive edge at the 95% confidence bound after slippage, PF ≥ 1.3, drawdown ≤ 25%, mostly winning weeks).",
  ];
  const traded = d.strategies.filter((x) => x.trades > 0);
  if (traded.length)
    summary.push(`By rule set, all time: ${traded.map((x) => `${x.name} ${signR(x.avgR)} per trade over ${x.trades} (${x.winRate}% wins)`).join("; ")}.`);
  const ranking_notes = [
    best ? `Best overall: ${label(best)}, score ${best.score}/100 (${VERDICT_LABEL[best.verdict]}). ${best.verdictReason}` : "",
    eff ? `Most effective per trade: ${label(eff)}, ${signR(eff.avgRSlip)} per trade after slippage over ${eff.trades} trades.` : "",
    ret ? `Highest return: ${label(ret)}, ${ret.returnPct >= 0 ? "+" : ""}${ret.returnPct.toFixed(1)}% with a ${ret.maxDrawdownPct.toFixed(1)}% max drawdown.` : "",
  ].filter(Boolean);
  const mistakes = (d.mistakes.period.length ? d.mistakes.period : d.mistakes.allTime).slice(0, 3).map((m) => ({
    title: `${m.title} (${m.count}×, ${signR(m.sumR)})`,
    detail: m.fix,
  }));
  const improvements = d.mistakes.bySetup
    .filter((m) => m.count >= 3 && m.count / m.losses >= 0.4)
    .slice(0, 5)
    .map((m) => ({ scope: label(m), action: m.fix, rationale: `${m.count} of its ${m.losses} losses were "${m.title}".` }));
  return {
    headline: p.trades ? `${p.trades} trades, ${usd(p.netUsd)} (${signR(p.sumR)}) this ${span}` : `Quiet ${span}: no closed trades`,
    summary,
    ranking_notes,
    mistakes,
    improvements,
    caveats: ["Paper results on a few weeks of data can be luck. Trust a setup only after the confidence bound stays positive for 30+ trades."],
  };
}
