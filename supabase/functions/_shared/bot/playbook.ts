import type { Side } from "./types.ts";

// The playbook: what an aggressive account has learned, and how that turns into a bet size.
//
// An aggressive account ("aggro", strategies.ts) owns no entry rules. On every bar it sees the
// signals of all the rule sets in its pool and must decide which one to take and how much to
// risk. The playbook is its memory for that decision:
//
//  - Every signal is described by its CONTEXT (Facets): which rule set fired, the side, the coin,
//    the higher-timeframe trend, the confluence band, volatility, trend strength, the side of
//    EMA 200 and the session.
//  - Every signal's outcome in R is learned, whether it was traded or not: untraded signals are
//    replayed by the analyzer (shadow signals), so the account learns from all of them and not
//    only from the few it took.
//  - The memory is a table of (count, sum of R) per context cell. An estimate is built from the
//    general to the specific, each level shrunk toward the one above it (`prior` phantom samples),
//    so one lucky trade teaches little and a context with a real record is trusted.
//  - Old samples fade (`decay`), so the playbook follows the market it is in.
//  - The risk of a trade follows the expected R (a fraction of Kelly), from nothing up to maxRisk.
//  - When a life ends, the trades that took the account from its peak to the end are learned a
//    second time, so the contexts that killed a life weigh more in the next one.
//
// The playbook belongs to the account and survives a redeploy: the balance starts again at the
// starting balance, the memory does not. Pure functions: the live engine, the replay and the
// tests share them.

/** The key of the aggressive meta strategy. */
export const AGGRO_KEY = "aggro";

export const AGGRO = {
  /** No new entries for the rest of the UTC day once the account is up this much on the day. */
  dayTarget: 0.1,
  /** No new entries for the rest of the UTC day once the account is down this much on the day. */
  dayStop: -0.15,
  /** Risk per trade as a share of equity: never above this, and at least minRisk when a trade is taken. */
  maxRisk: 0.1,
  minRisk: 0.02,
  /** A signal is only traded when its expected R is at least this. */
  minEdge: 0.05,
  /** Risk = expected R × this (a fraction of the Kelly bet for a spread of about 1.6R). */
  kelly: 0.4,
  /** Phantom samples each level of the estimate is shrunk with. */
  prior: 20,
  /**
   * How much of each context's deviation from its rule set's average is added. Every outcome sits
   * in all eight context cells of its rule set, so at 1 a single result would be counted eight times.
   */
  facetWeight: 0.25,
  /** Each new sample in a cell scales the cell's older samples by this: about 500 samples of memory. */
  decay: 0.998,
  /** A rule set is not traded before it has this many learned samples. */
  minSamples: 10,
  /** Outcomes are clipped to this range of R before they are learned, so one outlier cannot own a cell. */
  rClip: [-2, 5] as readonly [number, number],
  /** Extra weight of a losing trade that took a life from its peak to its end. */
  fatalWeight: 1,
  /**
   * Calibration: the playbook checks its own raw estimates against what the signals then did
   * (a regression of realized R on the raw estimate, about `1 / (1 − calDecay)` signals of memory)
   * and trades on the corrected number. No trade before `calMin` checked signals. The slope is
   * shrunk toward 0 with `calPrior` phantom signals of spread `calVar`, and capped.
   *
   * Why it is on: replayed over a year without it (scripts/experiments/aggro-variants.ts), on 15m,
   * 1h and 4h alike and with every memory setting tried, the signals the raw estimate rated best
   * did WORSE than the ones it rated worst. A context that has just paid is usually a move that
   * is spent. Betting on the raw record lost more than the calibrated playbook on both timeframes.
   */
  calibration: true,
  calDecay: 0.999,
  calMin: 200,
  calPrior: 100,
  calVar: 0.01,
  calMaxSlope: 3,
  /** Ended lives kept in the playbook. */
  maxLives: 50,
};

export interface Facets {
  /** Key of the rule set that produced the signal. */
  src: string;
  side: Side;
  sym: string;
  /** The next timeframe up, relative to the trade. */
  htf: "with" | "against" | "mixed" | "na";
  /** Confluence score band: lo < 50, mid 50–79, hi ≥ 80. */
  cf: "lo" | "mid" | "hi";
  /** ATR(14) against its own 100-bar average. */
  vol: "calm" | "normal" | "wild" | "na";
  /** ADX(14): range < 20, trend ≥ 25. */
  adx: "range" | "mid" | "trend" | "na";
  /** Price against EMA 200, relative to the trade. */
  ema: "with" | "against" | "na";
  /** UTC session of the signal. */
  ses: string;
}

const FACET_KEYS = ["side", "sym", "htf", "cf", "vol", "adx", "ema", "ses"] as const;
type FacetKey = (typeof FACET_KEYS)[number];

const FACET_LABEL: Record<FacetKey, (v: string) => string> = {
  side: (v) => `${v}s`,
  sym: (v) => v.replace(/USDT$/, ""),
  htf: (v) => (v === "na" ? "no higher-timeframe read" : `${v} the higher-timeframe trend`).replace("mixed the", "a mixed"),
  cf: (v) => `${v === "lo" ? "low" : v === "hi" ? "high" : "middling"} confluence`,
  vol: (v) => (v === "na" ? "unknown volatility" : `${v} volatility`),
  adx: (v) => (v === "trend" ? "a trending market (ADX ≥ 25)" : v === "range" ? "a ranging market (ADX < 20)" : v === "mid" ? "a market between range and trend" : "unknown trend strength"),
  ema: (v) => (v === "with" ? "the right side of EMA 200" : v === "against" ? "the wrong side of EMA 200" : "no EMA 200 yet"),
  ses: (v) => `the ${v} session`,
};

/** Plain words for a cell key, for the dashboard and the journal. */
export function cellLabel(key: string) {
  if (key === "*") return "every signal";
  return key
    .split("|")
    .map((part) => {
      const [k, v] = part.split("=");
      return k === "s" ? v : (FACET_LABEL[k as FacetKey]?.(v) ?? part);
    })
    .join(" · ");
}

/** The cells one signal belongs to: all signals, its rule set, each context alone, and each context within the rule set. */
export function cellKeys(f: Facets): string[] {
  const s = `s=${f.src}`;
  return ["*", s, ...FACET_KEYS.map((k) => `${k}=${f[k]}`), ...FACET_KEYS.map((k) => `${s}|${k}=${f[k]}`)];
}

export interface LifeRecord {
  life: number;
  started_at: string | null;
  ended_at: string;
  cause: "busted" | "redeployed";
  trades: number;
  wins: number;
  /** Highest realized equity of the life, and the equity it ended with. */
  peak: number;
  end: number;
  /** The contexts that lost the most between the peak and the end. */
  fatal: { key: string; label: string; n: number; r: number }[];
  summary: string;
}

export interface Playbook {
  v: 1;
  /** Cell key → [weighted count, weighted sum of R]. */
  cells: Record<string, [number, number]>;
  /** Outcomes learned so far (not decayed). */
  learned: number;
  /** Counts the saves: the engine only stores a playbook over the revision it read. */
  rev: number;
  /** Decayed sums of (raw estimate x, realized R y) over the signals whose estimate was recorded: how far the estimates can be trusted. */
  cal: { n: number; sx: number; sy: number; sxx: number; sxy: number };
  /** Equity at the start of the current UTC day, for the daily target and loss limit. */
  day: { date: string; start: number; life: number } | null;
  /** The last life whose post-mortem is written. */
  autopsied: number;
  lives: LifeRecord[];
}

/** What a new account knows before its first trade (aggro-seed.ts). */
export interface PlaybookSeed {
  cells: Record<string, readonly [number, number]>;
  cal?: Playbook["cal"];
}

const NO_CAL: Playbook["cal"] = { n: 0, sx: 0, sy: 0, sxx: 0, sxy: 0 };

export function newPlaybook(seed?: PlaybookSeed | null): Playbook {
  const cells: Playbook["cells"] = {};
  for (const [k, v] of Object.entries(seed?.cells ?? {})) cells[k] = [v[0], v[1]];
  return { v: 1, cells, learned: 0, rev: 0, cal: { ...(seed?.cal ?? NO_CAL) }, day: null, autopsied: 0, lives: [] };
}

/** A playbook read back from the database (null when the account has none yet, or it is unreadable). */
export function readPlaybook(raw: unknown): Playbook | null {
  const p = raw as Partial<Playbook> | null;
  if (!p || typeof p !== "object" || p.v !== 1 || !p.cells || typeof p.cells !== "object") return null;
  const c = (p.cal ?? {}) as Partial<Playbook["cal"]>;
  const cal = { n: +(c.n ?? 0) || 0, sx: +(c.sx ?? 0) || 0, sy: +(c.sy ?? 0) || 0, sxx: +(c.sxx ?? 0) || 0, sxy: +(c.sxy ?? 0) || 0 };
  return { v: 1, cells: p.cells, learned: +(p.learned ?? 0) || 0, rev: +(p.rev ?? 0) || 0, cal, day: p.day ?? null, autopsied: +(p.autopsied ?? 0) || 0, lives: Array.isArray(p.lives) ? p.lives : [] };
}

export interface Outcome {
  facets: Facets;
  /** R after costs. */
  r: number;
  /** Weight of the sample (default 1). */
  w?: number;
  /** The raw estimate the signal had when it fired, when it was recorded: it is then checked against `r` (calibration). */
  raw?: number | null;
}

/** Adds outcomes to the playbook's cells and to its calibration (in place), oldest first. */
export function learn(pb: Playbook, outcomes: Outcome[]) {
  for (const o of outcomes) {
    if (!Number.isFinite(o.r)) continue;
    const r = Math.max(AGGRO.rClip[0], Math.min(AGGRO.rClip[1], o.r));
    const w = o.w ?? 1;
    if (o.raw != null && Number.isFinite(o.raw)) {
      const d = AGGRO.calDecay;
      const c = pb.cal;
      pb.cal = { n: +(c.n * d + 1).toFixed(4), sx: +(c.sx * d + o.raw).toFixed(6), sy: +(c.sy * d + r).toFixed(6), sxx: +(c.sxx * d + o.raw * o.raw).toFixed(6), sxy: +(c.sxy * d + o.raw * r).toFixed(6) };
    }
    for (const k of cellKeys(o.facets)) {
      const [n, s] = pb.cells[k] ?? [0, 0];
      pb.cells[k] = [+(n * AGGRO.decay + w).toFixed(4), +(s * AGGRO.decay + w * r).toFixed(4)];
    }
    pb.learned++;
  }
  return pb;
}

export interface Estimate {
  /** Expected R of the signal: the raw estimate, corrected by how raw estimates have related to outcomes. This is what is traded on. */
  exp: number;
  /** The raw estimate: the context's own record, shrunk. */
  raw: number;
  /** The calibration slope in force (1 would mean the raw estimates are right as they are; below 0, that well-rated contexts have been doing worse). */
  slope: number;
  /** Signals the calibration rests on. */
  checked: number;
  /** The rule set's own average (shrunk), before the context. */
  base: number;
  /** Learned samples of the rule set. */
  n: number;
  /** What each context adds or takes away, largest effect first. */
  parts: { key: string; dev: number; n: number }[];
}

/**
 * Expected R of a signal. Built from the general to the specific: all signals → the rule set →
 * each context within the rule set. Every level is shrunk toward the level above with `prior`
 * phantom samples; a context the rule set has not seen yet borrows what that context did for
 * all rule sets. The contexts overlap, so only `facetWeight` of each deviation is added.
 */
export function estimate(pb: Playbook, f: Facets): Estimate {
  const K = AGGRO.prior;
  const cell = (k: string) => pb.cells[k] ?? [0, 0];
  const [gn, gs] = cell("*");
  const g = gs / (gn + K);
  const s = `s=${f.src}`;
  const [sn, ss] = cell(s);
  const base = (ss + K * g) / (sn + K);
  let raw = base;
  const parts: Estimate["parts"] = [];
  for (const k of FACET_KEYS) {
    const [fn, fs] = cell(`${k}=${f[k]}`);
    const general = (fs + K * g) / (fn + K) - g;
    const key = `${s}|${k}=${f[k]}`;
    const [n, sum] = cell(key);
    const dev = (sum + K * (base + general)) / (n + K) - base;
    raw += AGGRO.facetWeight * dev;
    parts.push({ key, dev: AGGRO.facetWeight * dev, n });
  }
  parts.sort((x, y) => Math.abs(y.dev) - Math.abs(x.dev));
  const { exp, slope } = calibrate(pb, raw);
  return { exp, raw, slope, checked: pb.cal.n, base, n: sn, parts };
}

/**
 * The raw estimate corrected by the playbook's own record: expected R = the average outcome of
 * all checked signals + slope × (raw − the average raw estimate). The slope is learned, so the
 * playbook finds out by itself whether a good record in a context is a reason to bet on it
 * (slope > 0) or a sign the move is spent (slope < 0), and it follows that as it changes.
 */
export function calibrate(pb: Playbook, raw: number): { exp: number; slope: number } {
  if (!AGGRO.calibration) return { exp: raw, slope: 1 };
  const c = pb.cal;
  if (!(c.n > 0)) return { exp: 0, slope: 0 };
  const mx = c.sx / c.n;
  const my = c.sy / c.n;
  const sxx = c.sxx - c.n * mx * mx;
  const sxy = c.sxy - c.n * mx * my;
  const slope = Math.max(-AGGRO.calMaxSlope, Math.min(AGGRO.calMaxSlope, sxy / (Math.max(sxx, 0) + AGGRO.calPrior * AGGRO.calVar)));
  return { exp: my + slope * (raw - mx), slope };
}

const signedR = (r: number) => `${r >= 0 ? "+" : "−"}${Math.abs(r).toFixed(2)}R`;

/** The share of equity to risk on a signal with this estimate; 0 with the reason when it is not worth a trade. */
export function riskFor(est: Estimate): { pct: number; why: string } {
  if (est.n < AGGRO.minSamples) return { pct: 0, why: `the playbook has only ${Math.round(est.n)} samples of this rule set (needs ${AGGRO.minSamples}).` };
  if (AGGRO.calibration && est.checked < AGGRO.calMin) return { pct: 0, why: `the playbook has checked its estimates against only ${Math.round(est.checked)} outcomes (needs ${AGGRO.calMin}) before it bets on them.` };
  if (est.exp < AGGRO.minEdge) return { pct: 0, why: `the playbook expects ${signedR(est.exp)} in this context (needs ${signedR(AGGRO.minEdge)}).` };
  const pct = Math.min(AGGRO.maxRisk, Math.max(AGGRO.minRisk, est.exp * AGGRO.kelly));
  return { pct, why: `the playbook expects ${signedR(est.exp)} in this context, so it risks ${(pct * 100).toFixed(1)}% of equity.` };
}

/** One line on why the estimate is what it is: the two contexts that move it most. */
export function explain(est: Estimate) {
  const top = est.parts.filter((p) => Math.abs(p.dev) >= 0.005).slice(0, 2);
  const src = est.parts[0]?.key.split("|")[0].slice(2) ?? "";
  const bits = top.map((p) => `${cellLabel(p.key.split("|")[1])} ${signedR(p.dev)}`);
  const turn = est.slope < 0 ? "lately a good record has been followed by worse results, so the estimate is turned around" : "a good record has kept paying, so the estimate stands";
  return `${src} averages ${signedR(est.base)} over ${Math.round(est.n)} samples${bits.length ? `; ${bits.join(", ")}` : ""}; record-based estimate ${signedR(est.raw)}. Checked against ${Math.round(est.checked)} outcomes: ${turn} (slope ${est.slope.toFixed(2)})`;
}

const utcDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Starts a new day (or a new life) for the daily target. Returns true when the playbook changed. */
export function rollDay(pb: Playbook, now: number, equity: number, life: number) {
  const date = utcDate(now);
  if (pb.day && pb.day.date === date && pb.day.life === life) return false;
  pb.day = { date, start: +equity.toFixed(8), life };
  return true;
}

/** Whether the day's target or loss limit stops new entries. */
export function dayGuard(pb: Playbook, equity: number): { block: boolean; pnl: number; why: string } {
  const start = pb.day?.start ?? 0;
  const pnl = start > 0 ? equity / start - 1 : 0;
  const pct = `${pnl >= 0 ? "+" : "−"}${Math.abs(pnl * 100).toFixed(1)}%`;
  if (pnl >= AGGRO.dayTarget) return { block: true, pnl, why: `the day's target is reached (${pct} today, target +${AGGRO.dayTarget * 100}%): no new entries until 00:00 UTC.` };
  if (pnl <= AGGRO.dayStop) return { block: true, pnl, why: `the day's loss limit is reached (${pct} today, limit ${AGGRO.dayStop * 100}%): no new entries until 00:00 UTC.` };
  return { block: false, pnl, why: "" };
}

export interface LifeTrade {
  facets: Facets | null;
  /** R after costs; null when it could not be computed. */
  r: number | null;
  /** Net dollars. */
  net: number;
  closed_at: string;
}

/**
 * The post-mortem of a life that ended. Writes the life's record and learns the fatal trades
 * (the losers between the life's equity peak and its end) a second time, so the next life
 * weighs those contexts more. Changes the playbook in place and returns the record.
 */
export function autopsy(
  pb: Playbook,
  a: { life: number; startedAt: string | null; endedAt: string; startBalance: number; endEquity: number; cause: "busted" | "redeployed"; trades: LifeTrade[] },
): LifeRecord {
  const list = [...a.trades].sort((x, y) => +new Date(x.closed_at) - +new Date(y.closed_at));
  let eq = a.startBalance;
  let peak = a.startBalance;
  let peakIdx = -1;
  list.forEach((t, i) => {
    eq += t.net;
    if (eq >= peak) {
      peak = eq;
      peakIdx = i;
    }
  });
  const fatal = list.slice(peakIdx + 1).filter((t) => t.net < 0);
  learn(pb, fatal.filter((t) => t.facets && t.r != null).map((t) => ({ facets: t.facets!, r: t.r!, w: AGGRO.fatalWeight })));
  pb.learned -= fatal.filter((t) => t.facets && t.r != null && Number.isFinite(t.r)).length; // the same trades, counted once

  // Which contexts the fatal trades shared: the rule set, and the rule set in each context.
  const tally = new Map<string, { n: number; r: number }>();
  for (const t of fatal) {
    if (!t.facets || t.r == null) continue;
    for (const k of cellKeys(t.facets).filter((x) => x.startsWith("s="))) {
      const c = tally.get(k) ?? { n: 0, r: 0 };
      tally.set(k, { n: c.n + 1, r: c.r + t.r });
    }
  }
  const worst = [...tally.entries()]
    .filter(([, c]) => c.n >= 2 && c.r < 0)
    .sort((x, y) => x[1].r - y[1].r)
    .slice(0, 3)
    .map(([key, c]) => ({ key, label: cellLabel(key), n: c.n, r: +c.r.toFixed(2) }));

  const usd = (n: number) => `$${n.toFixed(2)}`;
  const days = a.startedAt ? (+new Date(a.endedAt) - +new Date(a.startedAt)) / 86_400_000 : null;
  const lasted = days == null ? "" : days >= 1 ? ` lasted ${days.toFixed(1)} days and` : ` lasted ${Math.max(1, Math.round(days * 24))} hours and`;
  const summary = [
    `Life ${a.life}${lasted} took ${list.length} trade${list.length === 1 ? "" : "s"}; it ${a.cause === "busted" ? "busted" : "was redeployed"} at ${usd(a.endEquity)}.`,
    peak > a.startBalance ? `It peaked at ${usd(peak)}, then lost ${usd(peak - a.endEquity)} over ${list.length - peakIdx - 1} trade${list.length - peakIdx - 1 === 1 ? "" : "s"}.` : "It never got above its starting balance.",
    worst.length ? `The losses after the peak came mostly from: ${worst.map((w) => `${w.label} (${w.n} trades, ${signedR(w.r)})`).join("; ")}. Those count double in the next life.` : fatal.length ? "The losses after the peak shared no context; they count double in the next life." : "",
  ]
    .filter(Boolean)
    .join(" ");

  const record: LifeRecord = {
    life: a.life,
    started_at: a.startedAt,
    ended_at: a.endedAt,
    cause: a.cause,
    trades: list.length,
    wins: list.filter((t) => t.net > 0).length,
    peak: +peak.toFixed(2),
    end: +a.endEquity.toFixed(2),
    fatal: worst,
    summary,
  };
  pb.lives = [...pb.lives.filter((l) => l.life !== a.life), record].slice(-AGGRO.maxLives);
  pb.autopsied = Math.max(pb.autopsied, a.life);
  return record;
}

/** The cells with the best and the worst record, for the dashboard: rule set × context cells with enough samples. */
export function playbookTable(pb: Playbook, minN = 8) {
  const rows = Object.entries(pb.cells)
    .filter(([k, [n]]) => k.includes("|") && n >= minN)
    .map(([key, [n, s]]) => ({ key, label: cellLabel(key), n: Math.round(n), avgR: +(s / (n + AGGRO.prior)).toFixed(3) }))
    .sort((x, y) => y.avgR - x.avgR);
  return { best: rows.slice(0, 8), worst: rows.slice(-8).reverse().filter((r) => r.avgR < 0) };
}
