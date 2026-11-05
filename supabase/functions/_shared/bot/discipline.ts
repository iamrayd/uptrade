// Capital protection while a bot is learning. A setup that is losing should trade
// smaller, and wait after a loss, instead of repeating the same mistake at full size.
// The shadow-signal ledger (bot_filtered_signals) keeps feeding the learner either way.

export const DISCIPLINE = {
  /** Wait this many bars on a symbol after a loss there (1h and below; see disciplineFor). */
  cooldownBars: 3,
  /** Wait this many bars (any symbol) after this many losses in a row. */
  streakLosses: 3,
  streakCooldownBars: 6,
  /** A closed trade at or below this R counts as a loss. */
  lossR: -0.1,
};

/**
 * The rules by timeframe. A year replay (docs/strategies/V2-PLAN.md) showed the cooldown and the
 * risk cuts cost the daily setups most of their return (Supertrend 1d −2.3% with them, +13.3%
 * without): a daily bar is already a long wait, and a cut taken after a few losses is still in
 * force when the one large winner arrives. So 1d runs without them, 4h waits a shorter time,
 * and 1h and below keep the full rules.
 */
export function disciplineFor(timeframe?: string): { cooldownBars: number; streakCooldownBars: number; riskCuts: boolean } {
  if (timeframe === "1d") return { cooldownBars: 0, streakCooldownBars: 0, riskCuts: false };
  if (timeframe === "4h") return { cooldownBars: 1, streakCooldownBars: 2, riskCuts: true };
  return { cooldownBars: DISCIPLINE.cooldownBars, streakCooldownBars: DISCIPLINE.streakCooldownBars, riskCuts: true };
}

export interface RecentTrade {
  symbol: string;
  r: number | null;
  closed_at: string;
}

/**
 * Multiplier on the account's risk per trade, from how far the account is below its
 * starting balance and how its latest trades went. Smaller risk while losing keeps the
 * account alive to keep learning; it returns to full size once the account recovers.
 * `recent` is oldest first. On a timeframe without risk cuts (disciplineFor) it is always 1.
 */
export function riskMultiplier(a: { equity: number; startBalance: number; recent: RecentTrade[]; timeframe?: string }): { mult: number; note: string | null } {
  if (!disciplineFor(a.timeframe).riskCuts) return { mult: 1, note: null };
  const ratio = a.startBalance > 0 ? a.equity / a.startBalance : 1;
  const rs = a.recent.slice(-10).map((t) => t.r ?? 0);
  const avg = rs.length ? rs.reduce((s, x) => s + x, 0) / rs.length : 0;
  let streak = 0;
  for (let i = a.recent.length - 1; i >= 0 && (a.recent[i].r ?? 0) <= DISCIPLINE.lossR; i--) streak++;

  let mult = 1;
  let why = "";
  const cut = (m: number, w: string) => {
    if (m < mult) {
      mult = m;
      why = w;
    }
  };
  if (ratio < 0.4) cut(0.25, `the account is ${((1 - ratio) * 100).toFixed(0)}% below its starting balance`);
  else if (ratio < 0.7) cut(0.5, `the account is ${((1 - ratio) * 100).toFixed(0)}% below its starting balance`);
  if (rs.length >= 6 && avg < -0.3) cut(0.5, `the last ${rs.length} trades averaged ${avg.toFixed(2)}R`);
  if (streak >= DISCIPLINE.streakLosses) cut(0.5, `${streak} losses in a row`);
  return { mult, note: mult < 1 ? `Risk cut to ${(mult * 100).toFixed(0)}% of normal while the bot learns: ${why}.` : null };
}

export const CONVICTION = {
  /** Risk multiplier for a high-conviction entry (confluence ≥ hiScore on a setup rated at least Promising). */
  hiMult: 1.25,
  hiScore: 80,
  /** Risk multiplier for a low-conviction entry (confluence < loScore, or a setup rated Unproven/Avoid). */
  loMult: 0.75,
  loScore: 70,
};

/**
 * Conviction-weighted sizing: risk scaled by the entry's confluence score and the setup's
 * latest analyzer verdict. Multiplies ON TOP of riskMultiplier's cuts; leverage and margin
 * caps in sizePosition are unchanged. The analyzer reverts the account to flat sizing
 * (conviction = false) when 30+ weighted trades do worse than flat (tuning.ts).
 */
export function convictionMult(a: { cfScore: number | null; verdict: string | null }): { mult: number; note: string | null } {
  const strong = a.verdict === "promising" || a.verdict === "live_ready";
  const weak = a.verdict === "unproven" || a.verdict === "avoid";
  if (a.cfScore != null && a.cfScore >= CONVICTION.hiScore && strong)
    return { mult: CONVICTION.hiMult, note: `Risk raised to ${CONVICTION.hiMult}×: confluence ${a.cfScore} and the setup is rated ${a.verdict}.` };
  if ((a.cfScore != null && a.cfScore < CONVICTION.loScore) || weak)
    return { mult: CONVICTION.loMult, note: `Risk cut to ${CONVICTION.loMult}×: ${a.cfScore != null && a.cfScore < CONVICTION.loScore ? `confluence only ${a.cfScore}` : `the setup is rated ${a.verdict}`}.` };
  return { mult: 1, note: null };
}

/**
 * Until when (ms) the account must not enter `symbol`, or null. After a loss on the symbol it waits
 * `cooldownBars`; after a streak of losses on the account it waits `streakCooldownBars`.
 * `recent` is oldest first. The bar counts come from the timeframe (disciplineFor); 0 means no wait.
 */
export function cooldownUntil(recent: RecentTrade[], symbol: string, tfMs: number, timeframe?: string): { until: number; why: string } | null {
  const d = disciplineFor(timeframe);
  let out: { until: number; why: string } | null = null;
  const lastOnSymbol = [...recent].reverse().find((t) => t.symbol === symbol);
  if (d.cooldownBars > 0 && lastOnSymbol && (lastOnSymbol.r ?? 0) <= DISCIPLINE.lossR) {
    out = { until: +new Date(lastOnSymbol.closed_at) + d.cooldownBars * tfMs, why: `a loss on ${symbol}: wait ${d.cooldownBars} bar${d.cooldownBars === 1 ? "" : "s"}` };
  }
  const tail = recent.slice(-DISCIPLINE.streakLosses);
  if (d.streakCooldownBars > 0 && tail.length === DISCIPLINE.streakLosses && tail.every((t) => (t.r ?? 0) <= DISCIPLINE.lossR)) {
    const until = +new Date(tail[tail.length - 1].closed_at) + d.streakCooldownBars * tfMs;
    if (!out || until > out.until) out = { until, why: `${DISCIPLINE.streakLosses} losses in a row: wait ${d.streakCooldownBars} bars` };
  }
  return out;
}
