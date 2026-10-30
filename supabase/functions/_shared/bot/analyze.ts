import type { Candle, Timeframe } from "./types.ts";
import { TF_SECONDS } from "./types.ts";
import { STRATEGIES, STRATEGY_BY_KEY } from "./strategies.ts";
import {
  evaluateRule,
  FEATURES,
  LEARN,
  lastClosedPeriod,
  lessonImpact,
  lessonKey,
  lessonText,
  mineLessons,
  periodBuckets,
  rankSetups,
  replayBars,
  REVIEW_CATEGORIES,
  reviewTrade,
  setupStats,
  simulateSignal,
  slippedR,
  tagStats,
  timing,
  VERDICT_LABEL,
  type AnalysisTrade,
  type ImpactRow,
  type LessonRule,
  type ReportKind,
  type SetupStats,
  type ShadowSignal,
  type TagStat,
  type TradeReview,
} from "./analysis.ts";
import type { AccountTune, AnalysisDb, AnalysisState, FilteredSignalRow, LessonChange, LessonRecord, Market, NewLesson } from "./io.ts";
import { breakevenTune, convictionTune, probationTune, sweepConfluence, type SweepEntry } from "./tuning.ts";

// One analysis run. Called hourly by pg_cron → bot-analyze edge function.
//
//  1. Reviews: a post-mortem for every newly closed trade. Losers that were stopped
//     or signalled out wait until a few more bars have closed, so the review can say
//     whether price went on to reach the target without us ("right idea, bad stop").
//  2. Replays: every signal the bots did not trade (blocked by a lesson, the confluence
//     gate, a cooldown, the news gate, or because the account is busted) is replayed on
//     the strategy's own bars. Signals a lesson blocked keep score on that lesson, and a
//     lesson whose blocked signals would have made money is retired, on its lifetime
//     record or on its latest signals. Everything replayed is also learning data.
//  3. Learning: lessons waiting for room are switched on if they still hold on the latest
//     data; then new entry filters are mined from each setup's trades and replayed
//     signals (the mistake tags first among the candidates), confirmed on the newest 30%.
//     With auto-learn on they go live in the next bot run.
//  4. Reports: for each kind (hourly, daily, weekly, monthly) whose latest period has
//     closed and has no report yet: period results, rankings, mistakes, timing, lessons
//     and whether entries improved after them, plus a written analysis from Claude (or a
//     built-in template).

export interface Narrative {
  headline: string;
  summary: string[];
  ranking_notes: string[];
  mistakes: { title: string; detail: string }[];
  improvements: { scope: string; action: string; rationale: string }[];
  caveats: string[];
  /** Entry filters the AI suggests. They go through the same out-of-sample check as mined ones. */
  candidate_filters: { strategy: string; timeframe: string | null; feature: string; op: "lt" | "gte" | "eq"; value: string; reason: string }[];
}

export type Narrator = (input: { kind: ReportKind; data: ReportData; context: unknown }) => Promise<{ narrative: Narrative; model: string }>;

export interface AnalyzeSummary {
  reviewed: number;
  reviewsDeferred: number;
  signalsResolved: number;
  lessonsNew: number;
  lessonsPromoted: number;
  lessonsRetired: number;
  /** Accounts whose tuning changed this run (probation, threshold, breakeven, conviction or verdict). */
  accountsTuned: number;
  reports: string[];
  aiCalls: number;
  errors: string[];
}

const MAX_CANDLE_FETCHES = 100;
/** Candle requests stop after this long, so the AI write-up still fits in the edge function's time limit. */
const FETCH_BUDGET_MS = 45_000;
/** AI write-ups per run. Each one takes up to a minute and edge functions have a time limit; reports over budget wait for the next run. */
const MAX_AI_CALLS = 1;
/** Bars of history before the first signal of a replay batch: the longest strategy warm-up plus margin. */
const REPLAY_WARMUP = 450;
/** Bars to watch after a losing exit, to see whether the idea worked without us. */
const postBars = (tf: string) => Math.min(10, Math.floor((3 * 86400) / (TF_SECONDS[tf as Timeframe] ?? 3600)));

const num = (v: unknown) => (v == null ? null : +(v as number));
const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;

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
  const summary: AnalyzeSummary = { reviewed: 0, reviewsDeferred: 0, signalsResolved: 0, lessonsNew: 0, lessonsPromoted: 0, lessonsRetired: 0, accountsTuned: 0, reports: [], aiCalls: 0, errors: [] };
  let fetches = 0;
  const started = performance.now();
  const canFetch = () => fetches < MAX_CANDLE_FETCHES && performance.now() - started < FETCH_BUDGET_MS;
  const klines = async (symbol: string, tf: string, startTime: number, limit: number) => {
    fetches++;
    const tfMs = (TF_SECONDS[tf as Timeframe] ?? 3600) * 1000;
    return (await a.market.klines(symbol, tf, { startTime, limit })).filter((c) => c.time * 1000 + tfMs <= now());
  };

  const state: AnalysisState = await a.db.state();
  // Tolerate a database that has not had the latest supabase/bot.sql run yet.
  const resolvedSignals = state.resolved_signals ?? [];
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

  // ── 2. Replay the signals the bots did not trade ──
  const lessons = new Map(state.lessons.map((l) => [l.id, { ...l, blocked: +l.blocked, blocked_r: +l.blocked_r }]));
  const changes = new Map<string, LessonChange>();
  const change = (id: string, c: Omit<LessonChange, "id">) => changes.set(id, { ...(changes.get(id) ?? { id }), ...c });
  const resolved: { id: string; outcome_r: number | null; outcome_r_be?: number | null; outcome_note: string }[] = [];
  /** R of the signals each lesson blocked, oldest first: earlier runs, then this one. */
  const recentByLesson = new Map<string, number[]>();
  for (const s of resolvedSignals) {
    if ((s.reason ?? "lesson") !== "lesson") continue;
    for (const id of s.lesson_ids) recentByLesson.set(id, [...(recentByLesson.get(id) ?? []), +s.outcome_r]);
  }
  // One candle request covers every pending signal of a symbol × timeframe inside its window.
  const feeds = new Map<string, FilteredSignalRow[]>();
  for (const s of state.pending_signals) {
    if (!STRATEGY_BY_KEY[s.strategy]) continue;
    feeds.set(`${s.symbol}|${s.timeframe}`, [...(feeds.get(`${s.symbol}|${s.timeframe}`) ?? []), s]);
  }
  for (const [feed, list] of feeds) {
    const [symbol, tf] = feed.split("|");
    const tfSec = TF_SECONDS[tf as Timeframe] ?? 3600;
    let rest = [...list].sort((x, y) => +new Date(x.signal_bar_time) - +new Date(y.signal_bar_time));
    while (rest.length && canFetch()) {
      let candles: Candle[];
      try {
        candles = await klines(symbol, tf, +new Date(rest[0].signal_bar_time) - REPLAY_WARMUP * tfSec * 1000, 1000);
      } catch (e) {
        summary.errors.push(`replay ${feed}: ${msg(e)}`);
        break;
      }
      const lastMs = candles.length ? candles[candles.length - 1].time * 1000 : 0;
      const inWindow = new Set<string>();
      for (const s of rest) {
        const barMs = +new Date(s.signal_bar_time);
        if (barMs > lastMs) continue; // beyond this batch (or its bar has not closed yet)
        inWindow.add(s.id);
        const idx = candles.findIndex((c) => c.time * 1000 === barMs);
        if (idx < 0) {
          resolved.push({ id: s.id, outcome_r: null, outcome_note: "The exchange has no candle for this bar, so it could not be replayed." });
          continue;
        }
        try {
          const sim = simulateSignal(STRATEGY_BY_KEY[s.strategy], candles, idx, { side: s.side, entry: +s.entry_price, stop: +s.stop_price, takeProfit: num(s.take_profit) }, replayBars(tfSec));
          if (!sim.done) continue; // still open: next run
          // The same signal with the breakeven-stop variant: the pair is how the rule is judged (tuning.ts).
          const simBe = simulateSignal(STRATEGY_BY_KEY[s.strategy], candles, idx, { side: s.side, entry: +s.entry_price, stop: +s.stop_price, takeProfit: num(s.take_profit) }, replayBars(tfSec), true);
          resolved.push({
            id: s.id,
            outcome_r: sim.rSlip,
            outcome_r_be: simBe.done ? simBe.rSlip : sim.rSlip,
            outcome_note: `Would have closed by ${sim.reason.replace("_", " ")} after ${sim.bars} bars at ${sim.rSlip >= 0 ? "+" : ""}${sim.rSlip.toFixed(2)}R after slippage.`,
          });
          if ((s.reason ?? "lesson") !== "lesson") continue;
          for (const id of s.lesson_ids) {
            const l = lessons.get(id);
            if (!l) continue;
            l.blocked++;
            l.blocked_r += sim.rSlip;
            change(id, { blocked: l.blocked, blocked_r: +l.blocked_r.toFixed(4) });
            recentByLesson.set(id, [...(recentByLesson.get(id) ?? []), sim.rSlip]);
          }
        } catch (e) {
          summary.errors.push(`replay ${s.id}: ${msg(e)}`);
        }
      }
      const left = rest.filter((s) => !inWindow.has(s.id));
      if (left.length === rest.length) break;
      rest = left;
    }
  }
  await a.db.resolveSignals(resolved);
  summary.signalsResolved = resolved.filter((r) => r.outcome_r != null).length;

  // A lesson is retired when the signals it blocked would have made money: over its lifetime, or over its latest ones.
  for (const l of lessons.values()) {
    if (l.status !== "active") continue;
    const recent = (recentByLesson.get(l.id) ?? []).slice(-LEARN.retireWindow);
    const lifetime = l.blocked >= LEARN.retireAfter ? l.blocked_r / l.blocked : null;
    const latest = recent.length >= LEARN.retireAfter ? mean(recent) : null;
    const [why, avg] = lifetime != null && lifetime >= LEARN.retireAvgR ? [`The ${l.blocked} signals it blocked`, lifetime] : latest != null && latest >= LEARN.retireAvgR ? [`The latest ${recent.length} signals it blocked`, latest] : [null, 0];
    if (!why) continue;
    l.status = "retired";
    change(l.id, {
      status: "retired",
      retired_reason: `${why} would have averaged ${avg >= 0 ? "+" : ""}${avg.toFixed(2)}R after slippage: the filter was costing money, so it was switched off.`,
    });
    summary.lessonsRetired++;
  }

  // ── 3 & 4. Per user: learn, then report ──
  const users = new Set(state.accounts.map((x) => x.user_id));
  const lastReport = new Map(state.last_reports.map((r) => [`${r.user_id}:${r.kind}`, +new Date(r.period_start)]));
  const newLessons: NewLesson[] = [];
  const tunes: AccountTune[] = [];
  for (const userId of users) {
    try {
      const autoLearn = state.settings.find((s) => s.user_id === userId)?.auto_learn ?? true;
      const accounts = state.accounts.filter((x) => x.user_id === userId);
      const mine = trades.filter((t) => t.user_id === userId);
      const shadow: ShadowSignal[] = resolvedSignals
        .filter((s) => s.user_id === userId && STRATEGY_BY_KEY[s.strategy] && s.outcome_r != null)
        .map((s) => ({ id: s.id, strategy: s.strategy, timeframe: s.timeframe, features: s.features, outcome_r: +s.outcome_r, reason: s.reason ?? "lesson", signal_bar_time: s.signal_bar_time, lesson_ids: s.lesson_ids }));
      const myLessons = [...lessons.values()].filter((l) => l.user_id === userId);
      const setups = accounts.map((acc) =>
        setupStats({ strategy: acc.strategy, timeframe: acc.timeframe, startBalance: +acc.start_balance, busted: acc.status === "busted", trades: mine.filter((t) => t.account_id === acc.id) }),
      );

      // ── Per-setup tuning (tuning.ts): probation, confluence threshold, breakeven stop, conviction sizing ──
      for (const [i, acc] of accounts.entries()) {
        const st = setups[i];
        const tune: AccountTune = { id: acc.id };
        if (st.verdict !== acc.verdict) tune.verdict = st.verdict;
        const accShadows = resolvedSignals.filter((s) => s.account_id === acc.id && s.outcome_r != null);
        const accTrades = mine.filter((t) => t.account_id === acc.id);
        const p = probationTune({
          probation: acc.probation,
          changedAt: acc.probation_changed_at,
          replayRs: accShadows.map((s) => +s.outcome_r),
          verdict: st.verdict,
          now: now(),
        });
        if (p != null) tune.probation = p;
        const entries: SweepEntry[] = [
          ...accTrades.filter((t) => Number.isFinite(t.entry_indicators?.cfScore)).map((t) => ({ confluence: t.entry_indicators.cfScore, r: slippedR(t), t: +new Date(t.opened_at) })),
          ...accShadows.filter((s) => Number.isFinite(+(s.features?.confluence as number))).map((s) => ({ confluence: +(s.features.confluence as number), r: +s.outcome_r, t: +new Date(s.signal_bar_time) })),
        ];
        const mc = sweepConfluence({ entries, current: acc.min_confluence, changedAt: acc.min_confluence_changed_at, now: now() });
        if (mc != null) tune.min_confluence = mc;
        const pairs = accShadows.filter((s) => s.outcome_r_be != null).map((s) => ({ base: +s.outcome_r, be: +s.outcome_r_be! }));
        const be = breakevenTune({ breakeven: acc.breakeven, changedAt: acc.breakeven_changed_at, pairs, now: now() });
        if (be != null) tune.breakeven = be;
        const convTrades = accTrades
          .filter((t) => Number.isFinite(t.entry_indicators?.convMult))
          .map((t) => ({ r: slippedR(t), mult: t.entry_indicators.convMult }));
        const cv = convictionTune({ conviction: acc.conviction, trades: convTrades });
        if (cv != null) tune.conviction = cv;
        if (Object.keys(tune).length > 1) {
          tunes.push(tune);
          summary.accountsTuned++;
        }
      }

      const taken = new Set(myLessons.map((l) => lessonKey(l.strategy, l.timeframe, l)));
      const timeframes = [...new Set(accounts.map((x) => x.timeframe))];
      const activeFor = (strategy: string, tf: string) =>
        [...myLessons, ...newLessons.filter((n) => n.user_id === userId)].filter(
          (l) => l.status === "active" && l.strategy === strategy && (l.timeframe == null || l.timeframe === tf),
        ).length;
      const hasRoom = (strategy: string, timeframe: string | null) => (timeframe ? [timeframe] : timeframes).every((tf) => activeFor(strategy, tf) < LEARN.maxActivePerAccount);
      const scopeOf = (strategy: string, timeframe: string | null) => ({
        trades: mine.filter((t) => t.strategy === strategy && (timeframe == null || t.timeframe === timeframe)),
        shadow: shadow.filter((s) => s.strategy === strategy && (timeframe == null || s.timeframe === timeframe)),
      });
      const addLesson = (strategy: string, timeframe: string | null, rule: LessonRule, title: string, explanation: string, evidence: unknown, source: "mined" | "ai") => {
        const l: NewLesson = { user_id: userId, strategy, timeframe, ...rule, status: autoLearn && hasRoom(strategy, timeframe) ? "active" : "proposed", source, title, explanation, evidence };
        newLessons.push(l);
        summary.lessonsNew++;
        return l;
      };

      // Lessons that were waiting for room (not ones the owner paused) go live once there is room and they still hold on today's data.
      if (autoLearn) {
        for (const l of myLessons.filter((x) => x.status === "proposed" && !x.paused).sort((x, y) => +new Date(x.created_at) - +new Date(y.created_at))) {
          if (!hasRoom(l.strategy, l.timeframe)) continue;
          const sc = scopeOf(l.strategy, l.timeframe);
          if (!evaluateRule(sc.trades, { feature: l.feature, op: l.op, value: l.value }, sc.shadow).passed) continue;
          l.status = "active";
          change(l.id, { status: "active" });
          summary.lessonsPromoted++;
        }
      }

      const inForce = myLessons.filter((l) => l.status === "active" || l.status === "proposed");
      const learned = mineLessons(mine, taken, inForce, shadow).map((m) => addLesson(m.strategy, m.timeframe, m.rule, m.title, m.explanation, m.evidence, "mined"));
      const retired = myLessons.filter((l) => changes.get(l.id)?.status === "retired");

      for (const kind of ["daily", "weekly", "monthly", "hourly"] as ReportKind[]) {
        const [ps, pe] = lastClosedPeriod(kind, now());
        if ((lastReport.get(`${userId}:${kind}`) ?? -Infinity) >= ps) continue;
        const data = buildReport({ kind, ps, pe, trades: mine, shadow, setups, reviews, categoryOf, lessons: [...myLessons, ...learned], learned, retired });
        let narrative: Narrative = templateNarrative(data);
        let aiModel: string | null = null;
        let aiError: string | null = null;
        const wantsAi = a.narrator != null && aiKinds.has(kind);
        if (wantsAi && summary.aiCalls >= MAX_AI_CALLS && kind !== "hourly") continue; // written up by the next run
        if (a.narrator && wantsAi && summary.aiCalls < MAX_AI_CALLS) {
          summary.aiCalls++;
          try {
            const res = await a.narrator({ kind, data, context: aiContext(myLessons) });
            narrative = res.narrative;
            aiModel = res.model;
            // The AI's filter ideas only become lessons if the data backs them up on newer trades.
            for (const c of res.narrative.candidate_filters ?? []) {
              const rule = parseRule(c);
              if (!rule || !STRATEGY_BY_KEY[c.strategy] || taken.has(lessonKey(c.strategy, c.timeframe, rule))) continue;
              const sc = scopeOf(c.strategy, c.timeframe);
              const ev = evaluateRule(sc.trades, rule, sc.shadow);
              if (!ev.passed) continue;
              taken.add(lessonKey(c.strategy, c.timeframe, rule));
              const txt = lessonText(c.strategy, c.timeframe, rule, ev);
              const l = addLesson(c.strategy, c.timeframe, rule, txt.title, `Suggested by the AI analysis (${c.reason.trim()}). ${txt.explanation}`, ev, "ai");
              data.lessons.new.push(lessonSummary(l));
            }
          } catch (e) {
            aiError = msg(e);
          }
        }
        await a.db.saveReport({
          user_id: userId,
          kind,
          period_start: new Date(ps).toISOString(),
          period_end: new Date(pe).toISOString(),
          data,
          narrative,
          ai_model: aiModel,
          ai_error: aiError,
        });
        summary.reports.push(kind);
      }
    } catch (e) {
      summary.errors.push(`user ${userId}: ${msg(e)}`);
    }
  }
  await a.db.saveLessons([...newLessons, ...changes.values()]);
  await a.db.tuneAccounts(tunes);
  return summary;
}

function parseRule(c: Narrative["candidate_filters"][number]): LessonRule | null {
  const meta = FEATURES[c.feature];
  if (!meta || !["lt", "gte", "eq"].includes(c.op)) return null;
  if (meta.kind === "category") return c.op === "eq" ? { feature: c.feature, op: "eq", value: String(c.value) } : null;
  const v = Number(c.value);
  return c.op !== "eq" && Number.isFinite(v) ? { feature: c.feature, op: c.op, value: v } : null;
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
  rankings: ReturnType<typeof rankSetups>;
  timing: ReturnType<typeof timing>;
  mistakes: {
    period: MistakeRow[];
    allTime: MistakeRow[];
    /** The most frequent loss reason per setup, all time. */
    bySetup: { strategy: string; timeframe: string; category: string; title: string; count: number; losses: number; fix: string }[];
    examples: { tradeId: string; strategy: string; timeframe: string; symbol: string; side: string; r: number; title: string; why: string; fix: string; flags: string[] }[];
  };
  lessons: { active: LessonSummary[]; proposed: LessonSummary[]; new: LessonSummary[]; retired: LessonSummary[] };
  /** Did the bots get better? What they replayed, how costly each mistake has been, and entries before vs after lessons. */
  learning: {
    /** Setups with active lessons: average R of the trades before the first lesson switched on vs since. */
    impact: ImpactRow[];
    /** The most expensive mistakes, all time (trades plus replayed signals). */
    tags: TagStat[];
    /** Signals the bots did not trade and replayed since, by reason. */
    replayed: { reason: string; n: number; avgR: number | null }[];
    /** The confluence gate: signals it skipped (replayed) vs trades it let through. */
    gate: { skippedN: number; skippedAvgR: number | null; tradedN: number; tradedAvgR: number | null };
  };
}

interface MistakeRow {
  category: string;
  title: string;
  count: number;
  sumR: number;
  fix: string;
}

export interface LessonSummary {
  id?: string;
  strategy: string;
  timeframe: string | null;
  title: string;
  status: string;
  source: string;
  blocked?: number;
  blockedR?: number;
}

function lessonSummary(l: NewLesson | LessonRecord): LessonSummary {
  const rec = l as LessonRecord;
  return {
    id: rec.id,
    strategy: l.strategy,
    timeframe: l.timeframe,
    title: l.title,
    status: l.status,
    source: l.source,
    blocked: rec.blocked != null ? +rec.blocked : undefined,
    blockedR: rec.blocked_r != null ? +(+rec.blocked_r).toFixed(2) : undefined,
  };
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
  shadow: ShadowSignal[];
  setups: SetupStats[];
  reviews: Map<string, TradeReview>;
  categoryOf: Map<string, string>;
  lessons: (LessonRecord | NewLesson)[];
  learned: NewLesson[];
  retired: LessonRecord[];
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
      return { tradeId: t.id, strategy: t.strategy, timeframe: t.timeframe, symbol: t.symbol, side: t.side, r: +t.r_multiple.toFixed(2), title: r.title, why: r.why, fix: r.fix, flags: r.flags };
    });
  const sum = (l: AnalysisTrade[], f: (t: AnalysisTrade) => number) => +l.reduce((s, t) => s + f(t), 0).toFixed(4);
  const existing = a.lessons.filter((l) => (l as LessonRecord).id);
  const avg = (xs: number[]) => (xs.length ? +mean(xs).toFixed(3) : null);
  const reasons = [...new Set(a.shadow.map((x) => x.reason))].sort();
  const traded = a.trades.filter((t) => Number.isFinite(t.entry_indicators?.cfScore));
  const skipped = a.shadow.filter((x) => x.reason === "confluence");
  const impact = lessonImpact(
    a.trades,
    existing.map((l) => ({ strategy: l.strategy, timeframe: l.timeframe, status: l.status, activated_at: (l as LessonRecord).activated_at ?? null })),
    a.setups,
  );
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
    rankings: rankSetups(a.setups),
    timing: timing(a.trades),
    mistakes: { period: mistakeRows(inPeriod, a.categoryOf), allTime: mistakeRows(a.trades, a.categoryOf), bySetup: bySetupMistakes, examples },
    lessons: {
      active: existing.filter((l) => l.status === "active").map(lessonSummary),
      proposed: existing.filter((l) => l.status === "proposed").map(lessonSummary),
      new: a.learned.map(lessonSummary),
      retired: a.retired.map(lessonSummary),
    },
    learning: {
      impact,
      tags: tagStats(a.trades, a.shadow).filter((x) => x.costR > 0).slice(0, 8),
      replayed: reasons.map((reason) => ({ reason, n: a.shadow.filter((x) => x.reason === reason).length, avgR: avg(a.shadow.filter((x) => x.reason === reason).map((x) => x.outcome_r)) })),
      gate: { skippedN: skipped.length, skippedAvgR: avg(skipped.map((x) => x.outcome_r)), tradedN: traded.length, tradedAvgR: avg(traded.map((t) => t.r_multiple)) },
    },
  };
}

/** Background the AI needs: what each strategy does, and the features a filter can use. */
function aiContext(lessons: LessonRecord[]) {
  return {
    strategies: STRATEGIES.map((s) => ({ key: s.key, name: s.name, summary: s.summary, params: s.params })),
    filterFeatures: FEATURES,
    existingLessons: lessons.map((l) => ({ strategy: l.strategy, timeframe: l.timeframe, feature: l.feature, op: l.op, value: l.value, status: l.status })),
    paperTradingAssumptions:
      "Each setup is a separate $100 paper account trading BTC/ETH/SOL on Binance prices, 2% risk per trade (cut to 50% or 25% while an account is deeply down or on a losing streak), max 20x isolated leverage, taker fee 0.02%, maker 0%. " +
      "A signal is traded only if most confirming indicators agree (confluence score ≥ 65/100), it is not in a cooldown after a loss, and no active lesson blocks it; every skipped signal is replayed afterwards and counts as learning data. " +
      "Strategies ending in _news also wait out fresh high-impact crypto news and do not trade against one-sided news. " +
      "R = net PnL ÷ planned risk. 'Slip' figures subtract an extra 0.05% per side for real-exchange slippage. lcbR is the 95% lower confidence bound of mean R.",
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
  const L = d.learning;
  // Did entries get better after the lessons switched on? Weighted by the number of trades on each side.
  const withBoth = L.impact.filter((x) => x.before.avgR != null && x.after.avgR != null && x.after.n > 0);
  if (withBoth.length) {
    const nB = withBoth.reduce((x, r) => x + r.before.n, 0);
    const nA = withBoth.reduce((x, r) => x + r.after.n, 0);
    const aB = withBoth.reduce((x, r) => x + r.before.avgR! * r.before.n, 0) / nB;
    const aA = withBoth.reduce((x, r) => x + r.after.avgR! * r.after.n, 0) / nA;
    summary.push(`Since lessons switched on, ${nA} trades across ${withBoth.length} setups averaged ${signR(aA)} per trade (after slippage) vs ${signR(aB)} over the ${nB} trades before. ${nA < 30 ? "That is still a small sample." : ""}`.trim());
  }
  if (L.gate.skippedN >= 5 && L.gate.skippedAvgR != null)
    summary.push(`The confluence gate skipped ${L.gate.skippedN} signals that would have averaged ${signR(L.gate.skippedAvgR)} (replayed); the trades it let through averaged ${signR(L.gate.tradedAvgR)} over ${L.gate.tradedN}.`);
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
  for (const t of d.learning.tags.slice(0, 3)) improvements.push({ scope: "All bots", action: `Avoid the mistake "${t.label}"`, rationale: `${t.withN} entries showing it averaged ${signR(t.withAvgR)} vs ${signR(t.withoutAvgR)} without it (${t.costR.toFixed(1)}R lost).` });
  for (const l of d.lessons.new) improvements.push({ scope: label(l), action: l.title, rationale: l.status === "active" ? "Learned this run and now active." : "Learned this run; waiting for your approval." });
  return {
    headline: p.trades ? `${p.trades} trades, ${usd(p.netUsd)} (${signR(p.sumR)}) this ${span}` : `Quiet ${span}: no closed trades`,
    summary,
    ranking_notes,
    mistakes,
    improvements,
    caveats: ["Paper results on a few weeks of data can be luck. Trust a setup only after the confidence bound stays positive for 30+ trades."],
    candidate_filters: [],
  };
}
