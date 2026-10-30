import type { Candle, Side, Timeframe } from "./types.ts";
import { TF_SECONDS } from "./types.ts";
import { atr, dmi, ema, macd, rsi, sma, supertrend } from "./indicators.ts";

// The patience gate. A strategy's own trigger (a cross, a breakout) is only the start:
// before a signal becomes a trade, independent indicators vote on whether the market
// agrees. Most weighted checks must pass (not all).
//
//  - The weights come from data, not taste. A year of BTC/ETH/SOL history (20,000 trades, all
//    five strategies, 5m–1d; scripts/gate-analysis.ts) showed which checks really separate winners
//    from losers: MACD momentum and volume did, in both halves of the year; the textbook ones did
//    not. A trend-strength check (ADX ≥ 20) and "the next timeframe up agrees" even had slightly
//    NEGATIVE lift: they mark mature trends that are about to tire. Those checks keep weight 0:
//    they are still recorded with every trade and signal, so the learner keeps testing them and
//    a weight can be raised when the data starts to back it.
//  - Checks the trigger already guarantees are left out, so the score measures
//    confirmation the trigger did not give (see IMPLIED).
//  - The higher-timeframe trend is built from the same bars (no extra requests):
//    the strategy's bars are merged into the next timeframe up.
//  - Pure functions: the live engine, the backtester and the analyzer share them.

export const CONFLUENCE = {
  /** Entries below this score (0–100) are skipped and kept as shadow signals to learn from. */
  minScore: 65,
  /** Higher-timeframe trend: close vs its EMA and the EMA's slope over 3 bars. */
  htfEma: 20,
  htfMinBars: 24,
};

/** The next timeframe up, used for the trend filter. 1d has none. */
const HTF: Partial<Record<Timeframe, Timeframe>> = { "5m": "1h", "15m": "1h", "30m": "4h", "1h": "4h", "4h": "1d" };

/** Strategy key without the news suffix. */
export const baseKey = (key: string) => key.replace(/_news$/, "");

/**
 * Merges bars into larger ones aligned to the epoch (like Binance). Only complete
 * bars are returned: a partial bucket at either end is dropped.
 */
export function aggregateTo(c: Candle[], baseSec: number, htfSec: number): Candle[] {
  const out: Candle[] = [];
  for (const x of c) {
    const t = Math.floor(x.time / htfSec) * htfSec;
    const last = out[out.length - 1];
    if (last && last.time === t) {
      last.high = Math.max(last.high, x.high);
      last.low = Math.min(last.low, x.low);
      last.close = x.close;
      last.volume += x.volume;
    } else out.push({ ...x, time: t });
  }
  if (!out.length) return out;
  const lastBase = c[c.length - 1];
  if (lastBase.time + baseSec < out[out.length - 1].time + htfSec) out.pop();
  if (out.length && c[0].time > out[0].time) out.shift();
  return out;
}

/** +1 higher-timeframe uptrend, −1 downtrend, 0 mixed, null when there is no higher timeframe or too little history. */
export function htfBias(c: Candle[], tf: Timeframe): 1 | -1 | 0 | null {
  const h = HTF[tf];
  if (!h) return null;
  const bars = aggregateTo(c, TF_SECONDS[tf], TF_SECONDS[h]);
  if (bars.length < CONFLUENCE.htfMinBars) return null;
  const cl = bars.map((b) => b.close);
  const e = ema(cl, CONFLUENCE.htfEma);
  const i = cl.length - 1;
  if (e[i] == null || e[i - 3] == null) return null;
  if (cl[i] > e[i]! && e[i]! > e[i - 3]!) return 1;
  if (cl[i] < e[i]! && e[i]! < e[i - 3]!) return -1;
  return 0;
}

export interface ConfluenceCheck {
  key: string;
  label: string;
  weight: number;
  pass: boolean;
}

export interface Confluence {
  /** 0–100: weight of the passing checks ÷ weight of all checks that could be computed. */
  score: number;
  passed: number;
  total: number;
  checks: ConfluenceCheck[];
  /** Direction-relative higher-timeframe trend: +1 with the trade, −1 against it, 0 mixed; null when unknown. */
  htf: number | null;
  /** Numbers stored with the trade (and used as lesson features). */
  readings: Record<string, number>;
  /** Why the signal is refused whatever its score, or null. */
  veto: string | null;
  summary: string;
}

/** Checks a strategy's own trigger already guarantees. They would always pass, so they are left out of its score. */
const IMPLIED: Record<string, string[]> = {
  ema_trend: ["trend200"],
  macd_adx: ["strength", "momentum"], // a MACD cross means the histogram has just turned the right way
  supertrend: ["supertrend"],
  donchian: ["volume"],
  bb_rsi: [],
};

export function confluence(a: { strategy: string; timeframe: Timeframe; side: Side; candles: Candle[]; entry: number; stop: number }): Confluence {
  const base = baseKey(a.strategy);
  const c = a.candles;
  const i = c.length - 1;
  const s = a.side === "long" ? 1 : -1;
  const cl = c.map((x) => x.close);
  const close = cl[i];
  const e21 = ema(cl, 21);
  const e50 = ema(cl, 50);
  const e200 = ema(cl, 200);
  const m = macd(cl, 12, 26, 9);
  const d = dmi(c, 14);
  const rs = rsi(cl, 14);
  const at = atr(c, 14);
  const st = supertrend(c, 3, 10);
  const vol = sma(c.map((x) => x.volume), 20);
  const htf = htfBias(c, a.timeframe);
  const reversion = base === "bb_rsi";
  const skip = new Set(IMPLIED[base] ?? []);

  const checks: ConfluenceCheck[] = [];
  const add = (key: string, label: string, weight: number, pass: boolean | null) => {
    if (pass == null || skip.has(key)) return;
    checks.push({ key, label, weight, pass });
  };
  const ok = (v: number | null | undefined): v is number => v != null && Number.isFinite(v);

  const stopAtr = ok(at[i]) && at[i]! > 0 ? Math.abs(a.entry - a.stop) / at[i]! : null;
  add("stopSane", reversion ? "stop is not inside normal noise (≥ 0.8 ATR)" : "stop is not inside normal noise (≥ 1 ATR)", 1, stopAtr == null ? null : stopAtr >= (reversion ? 0.8 : 1));

  if (!reversion) {
    add("trend200", "price is on the trade's side of EMA 200", 1, ok(e200[i]) ? s * (close - e200[i]!) > 0 : null);
    add("emaStack", "EMA 50 and price agree with the direction", 0, ok(e50[i]) && ok(e200[i]) ? s * (e50[i]! - e200[i]!) > 0 && s * (close - e50[i]!) > 0 : null);
    add("momentum", "MACD histogram points the trade's way", 3, ok(m.hist[i]) ? s * m.hist[i]! > 0 : null);
    add("strength", "ADX ≥ 20 with the DMI lead in the trade's direction", 0, ok(d.adx[i]) && ok(d.plusDI[i]) && ok(d.minusDI[i]) ? d.adx[i]! >= 20 && s * (d.plusDI[i]! - d.minusDI[i]!) > 0 : null);
    add(
      "notStretched",
      "entry is not a stretched chase (RSI not extreme, price within 3 ATR of EMA 21)",
      1,
      ok(rs[i]) && ok(e21[i]) && ok(at[i]) && at[i]! > 0 ? (s > 0 ? rs[i]! <= 70 : rs[i]! >= 30) && s * (close - e21[i]!) / at[i]! <= 3 : null,
    );
    add("volume", "volume is not drying up (≥ 0.9× its 20-bar average)", 2, ok(vol[i]) && vol[i]! > 0 ? c[i].volume >= 0.9 * vol[i]! : null);
    add("supertrend", "Supertrend points the trade's way", 1, st.dir[i] == null ? null : st.dir[i] === s);
    add("htf", "the next timeframe up trends the same way", 0, htf == null ? null : htf === s);
  } else {
    // A fade: the trigger is an extreme, so judge the regime and the turn instead of the trend.
    add("range", "ADX ≤ 25: a range, not a trend to be run over by", 2, ok(d.adx[i]) ? d.adx[i]! <= 25 : null);
    add("rsiTurn", "RSI is already turning back", 1, ok(rs[i]) && ok(rs[i - 1]) ? s * (rs[i]! - rs[i - 1]!) > 0 : null);
    add("htf", "the next timeframe up is not trending against the fade", 0, htf == null ? null : htf !== -s);
    add("trend200", "price is not far against EMA 200 (within 6%)", 0, ok(e200[i]) ? (s * (close - e200[i]!)) / e200[i]! > -0.06 : null);
    add("supertrend", "Supertrend has not just run away against the fade", 0, st.dir[i] == null ? null : st.dir[i] !== -s || (ok(at[i]) && at[i]! > 0 ? Math.abs(close - (st.line[i] ?? close)) / at[i]! < 4 : true));
  }

  // Weight-0 checks are recorded in `checks` but are not part of the vote.
  const voting = checks.filter((k) => k.weight > 0);
  const total = voting.reduce((x, k) => x + k.weight, 0);
  const got = voting.reduce((x, k) => x + (k.pass ? k.weight : 0), 0);
  const score = total ? Math.round((got / total) * 100) : 0;
  const failed = voting.filter((k) => !k.pass);
  const passed = voting.filter((k) => k.pass).length;
  const readings: Record<string, number> = { cfScore: score, cfPassed: passed, cfTotal: voting.length };
  // Every check's own result is persisted (1 pass / 0 fail), weight-0 ones included, so the
  // learner keeps testing them on live entries, not only in the offline backtest.
  for (const k of checks) readings[`cf_${k.key}`] = k.pass ? 1 : 0;
  const htfRel = htf == null ? null : htf === 0 ? 0 : htf === s ? 1 : -1;
  if (htfRel != null) readings.cfHtf = htfRel;
  // A trend entry with the long-term trend AND Supertrend both against it. A judgment call, not a measured
  // one: such entries are about 3% of all trades, and their result flips sign between the halves of the
  // year (−0.12R, then +0.15R), so the data neither supports nor refutes the rule. It costs almost nothing.
  const against200 = ok(e200[i]) && s * (close - e200[i]!) <= 0;
  const againstSt = st.dir[i] != null && st.dir[i] !== s;
  const veto = !reversion && against200 && againstSt ? "price is against both EMA 200 and Supertrend" : null;
  return {
    score,
    passed,
    total: voting.length,
    checks,
    htf: htfRel,
    readings,
    veto,
    summary: `Confluence ${score}/100: ${passed} of ${voting.length} checks agree.${failed.length ? ` Not met: ${failed.map((k) => k.label).join("; ")}.` : ""}${veto ? ` Refused: ${veto}.` : ""}`,
  };
}

/** True when the signal clears the gate. */
export const passesGate = (cf: Confluence, minScore = CONFLUENCE.minScore) => cf.total > 0 && cf.veto == null && cf.score >= minScore;
