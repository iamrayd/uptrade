import { CONFLUENCE } from "./confluence.ts";

// Per-setup tuning decisions, made hourly by the analyzer (analyze.ts) and written to
// bot_accounts via bot_tune_accounts. Pure functions, so the tests can drive them directly.
//
//  - Probation: a setup trades shadow-only (zero capital) until its replayed signals prove
//    an edge after slippage. New 5m/15m/30m setups start on probation (EVIDENCE.md: they
//    lose money after slippage); a setup whose verdict turns "avoid" goes back on it.
//  - Per-setup confluence threshold: swept over {65,70,75,80} on the setup's own entries
//    (trades plus replayed signals); a higher bar is adopted only when it improves BOTH
//    halves of the data and does not skip more than the 60% room rule allows.
//  - Breakeven stop: judged on paired replays (outcome_r vs outcome_r_be of the SAME
//    signals), switched on when it reliably saves R, off when it stops helping.
//  - Conviction sizing: reverted to flat when 30+ conviction-weighted trades did worse
//    than flat sizing would have.
//
// Every flip waits TUNE.flipCooldownMs since the last one (hysteresis), so a setup cannot
// oscillate run to run.

export const TUNE = {
  /** A tuned value may not flip again within this long. */
  flipCooldownMs: 7 * 86400_000,
  /** Entries a decision needs before it is made. */
  minEntries: 30,
  /** Profit factor (after slippage) the replayed entries need to clear probation. */
  promotePf: 1.1,
  /** Confluence thresholds the sweep tries. */
  thresholds: [65, 70, 75, 80],
  /** A threshold may not skip more than this share of the setup's entries (the room rule). */
  maxSkipShare: 0.6,
  /** Total R the breakeven variant must save, and the t-statistic it needs, to switch on. */
  beMinSavedR: 2,
  beMinT: 2,
  /** Latest paired replays the breakeven rule is re-judged on once active. */
  beRetireWindow: 30,
};

const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
function sd(xs: number[]) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}

/** True when the value flipped less than the cooldown ago, so it must not flip again yet. */
export const inCooldown = (changedAt: string | null, now: number) => changedAt != null && now - +new Date(changedAt) < TUNE.flipCooldownMs;

/** Profit factor of a list of R outcomes (already slippage-adjusted). Null when nothing lost. */
export function profitFactor(rs: number[]) {
  const win = rs.filter((r) => r > 0).reduce((s, r) => s + r, 0);
  const loss = -rs.filter((r) => r <= 0).reduce((s, r) => s + r, 0);
  return loss > 0 ? win / loss : null;
}

/**
 * Should the setup's probation flag change? `replayRs` are the R outcomes (after slippage)
 * of its replayed signals, oldest first; `verdict` is the setup's latest verdict.
 * Returns the new value, or null for no change.
 */
export function probationTune(a: { probation: boolean; changedAt: string | null; replayRs: number[]; verdict: string | null; now: number }): boolean | null {
  if (inCooldown(a.changedAt, a.now)) return null;
  if (a.probation) {
    if (a.replayRs.length < TUNE.minEntries) return null;
    const pf = profitFactor(a.replayRs);
    return pf == null || pf > TUNE.promotePf ? false : null;
  }
  return a.verdict === "avoid" ? true : null;
}

export interface SweepEntry {
  /** The entry's confluence score (0–100). */
  confluence: number;
  /** Its R after slippage (trade or replayed signal). */
  r: number;
  /** Entry time (ms), for the two-halves split. */
  t: number;
}

/**
 * Sweeps the confluence threshold on the setup's own entries. Adopts the highest candidate
 * (from TUNE.thresholds, capped 80, floored at the global default) that keeps ≥ minEntries,
 * beats the CURRENT threshold's average R in BOTH time-halves, and does not skip more than
 * maxSkipShare of the entries. Returns the new threshold, or null for no change.
 */
export function sweepConfluence(a: { entries: SweepEntry[]; current: number | null; changedAt: string | null; now: number }): number | null {
  if (inCooldown(a.changedAt, a.now)) return null;
  const current = a.current ?? CONFLUENCE.minScore;
  const rows = [...a.entries].sort((x, y) => x.t - y.t);
  if (rows.length < TUNE.minEntries) return null;
  const halves = [rows.slice(0, Math.floor(rows.length / 2)), rows.slice(Math.floor(rows.length / 2))];
  const avgAt = (half: SweepEntry[], th: number) => {
    const kept = half.filter((e) => e.confluence >= th);
    return kept.length ? mean(kept.map((e) => e.r)) : null;
  };
  let best: number | null = null;
  for (const th of TUNE.thresholds) {
    if (th <= current || th < CONFLUENCE.minScore || th > 80) continue;
    const kept = rows.filter((e) => e.confluence >= th);
    if (kept.length < TUNE.minEntries) continue;
    if ((rows.length - kept.length) / rows.length > TUNE.maxSkipShare) continue;
    const better = halves.every((half) => {
      const cand = avgAt(half, th);
      const base = avgAt(half, current);
      return cand != null && base != null && cand > base;
    });
    if (better) best = th;
  }
  return best;
}

/**
 * Should the breakeven rule change? `pairs` are the SAME signals replayed both ways
 * (plain and with the breakeven stop), oldest first. Switch on when the variant saved
 * ≥ beMinSavedR with t ≥ beMinT over ≥ minEntries pairs; switch off when its latest
 * beRetireWindow pairs stopped helping. Returns the new value, or null for no change.
 */
export function breakevenTune(a: { breakeven: boolean; changedAt: string | null; pairs: { base: number; be: number }[]; now: number }): boolean | null {
  if (inCooldown(a.changedAt, a.now)) return null;
  const diffs = a.pairs.map((p) => p.be - p.base);
  if (a.breakeven) {
    const recent = diffs.slice(-TUNE.beRetireWindow);
    return recent.length >= TUNE.beRetireWindow && mean(recent) < 0 ? false : null;
  }
  if (diffs.length < TUNE.minEntries) return null;
  const saved = diffs.reduce((s, d) => s + d, 0);
  const t = mean(diffs) / Math.max(sd(diffs) / Math.sqrt(diffs.length), 1e-9);
  return saved >= TUNE.beMinSavedR && t >= TUNE.beMinT ? true : null;
}

/**
 * Should conviction sizing revert to flat? `trades` are the account's closed trades that
 * carried a conviction multiplier (entry_indicators.convMult), with their R after slippage.
 * Reverts (returns false) when, over ≥ minEntries such trades, the multiplier-weighted
 * average R is worse than the flat average. Returns null for no change.
 */
export function convictionTune(a: { conviction: boolean; trades: { r: number; mult: number }[] }): boolean | null {
  if (!a.conviction || a.trades.length < TUNE.minEntries) return null;
  const flat = mean(a.trades.map((t) => t.r));
  const weighted = mean(a.trades.map((t) => t.r * t.mult));
  return weighted < flat ? false : null;
}
