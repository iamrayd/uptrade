import type { Candle } from "./types.ts";

// Every function returns an array aligned with the input (null during warm-up).
// sma/ema/bollinger/rsi/macd are copied from src/lib/indicators.ts so the bot
// and the app's chart show the same values. atr/rma/dmi/supertrend follow
// TradingView's ta.* definitions (Wilder smoothing seeded with an SMA).

export type Series = (number | null)[];

export function sma(values: number[], period: number): Series {
  const out: Series = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function ema(values: number[], period: number): Series {
  const out: Series = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  // Seed with the SMA of the first `period` values.
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export function bollinger(values: number[], period: number, mult: number) {
  const mid = sma(values, period);
  const upper: Series = new Array(values.length).fill(null);
  const lower: Series = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    const m = mid[i]!;
    let v = 0;
    for (let j = i - period + 1; j <= i; j++) v += (values[j] - m) ** 2;
    const sd = Math.sqrt(v / period);
    upper[i] = m + mult * sd;
    lower[i] = m - mult * sd;
  }
  return { mid, upper, lower };
}

/** Wilder's RSI. */
export function rsi(values: number[], period: number): Series {
  const out: Series = new Array(values.length).fill(null);
  if (values.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  gain /= period;
  loss /= period;
  out[period] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

export function macd(values: number[], fast: number, slow: number, signal: number) {
  const f = ema(values, fast);
  const s = ema(values, slow);
  const line: Series = values.map((_, i) => (f[i] != null && s[i] != null ? f[i]! - s[i]! : null));
  // Signal = EMA of the MACD line over its defined part.
  const start = line.findIndex((v) => v != null);
  const sig: Series = new Array(values.length).fill(null);
  if (start >= 0) {
    const defined = line.slice(start) as number[];
    ema(defined, signal).forEach((v, i) => (sig[start + i] = v));
  }
  const hist: Series = line.map((v, i) => (v != null && sig[i] != null ? v - sig[i]! : null));
  return { line, signal: sig, hist };
}

/** Wilder's moving average (TradingView ta.rma) over the defined part of a series. */
export function rma(values: Series, period: number): Series {
  const out: Series = new Array(values.length).fill(null);
  const start = values.findIndex((v) => v != null);
  if (start < 0 || values.length - start < period) return out;
  let prev = 0;
  for (let i = start; i < start + period; i++) prev += values[i] ?? 0;
  prev /= period;
  out[start + period - 1] = prev;
  for (let i = start + period; i < values.length; i++) {
    prev = (prev * (period - 1) + (values[i] ?? 0)) / period;
    out[i] = prev;
  }
  return out;
}

export function trueRange(c: Candle[]): number[] {
  return c.map((x, i) =>
    i === 0 ? x.high - x.low : Math.max(x.high - x.low, Math.abs(x.high - c[i - 1].close), Math.abs(x.low - c[i - 1].close)),
  );
}

/** Average True Range (Wilder). */
export function atr(c: Candle[], period: number): Series {
  return rma(trueRange(c), period);
}

/** Directional Movement Index: +DI, −DI and ADX (Wilder), as TradingView ta.dmi. */
export function dmi(c: Candle[], period: number, adxSmoothing = period) {
  const n = c.length;
  const plusDM: Series = new Array(n).fill(null);
  const minusDM: Series = new Array(n).fill(null);
  const tr: Series = new Array(n).fill(null);
  for (let i = 1; i < n; i++) {
    const up = c[i].high - c[i - 1].high;
    const down = c[i - 1].low - c[i].low;
    plusDM[i] = up > down && up > 0 ? up : 0;
    minusDM[i] = down > up && down > 0 ? down : 0;
    tr[i] = Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i - 1].close), Math.abs(c[i].low - c[i - 1].close));
  }
  const trS = rma(tr, period);
  const pS = rma(plusDM, period);
  const mS = rma(minusDM, period);
  const plusDI: Series = new Array(n).fill(null);
  const minusDI: Series = new Array(n).fill(null);
  const dx: Series = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    if (trS[i] == null || pS[i] == null || mS[i] == null) continue;
    const p = trS[i]! === 0 ? 0 : (100 * pS[i]!) / trS[i]!;
    const m = trS[i]! === 0 ? 0 : (100 * mS[i]!) / trS[i]!;
    plusDI[i] = p;
    minusDI[i] = m;
    dx[i] = p + m === 0 ? 0 : (100 * Math.abs(p - m)) / (p + m);
  }
  return { plusDI, minusDI, adx: rma(dx, adxSmoothing) };
}

/**
 * Supertrend, as TradingView ta.supertrend(factor, atrPeriod).
 * dir is +1 in an uptrend (line = lower band, below price) and −1 in a downtrend.
 */
export function supertrend(c: Candle[], factor: number, atrPeriod: number) {
  const a = atr(c, atrPeriod);
  const n = c.length;
  const line: Series = new Array(n).fill(null);
  const dir: (1 | -1 | null)[] = new Array(n).fill(null);
  let prevUpper = NaN;
  let prevLower = NaN;
  for (let i = 0; i < n; i++) {
    if (a[i] == null) continue;
    const src = (c[i].high + c[i].low) / 2;
    let upper = src + factor * a[i]!;
    let lower = src - factor * a[i]!;
    const prevClose = i > 0 ? c[i - 1].close : c[i].close;
    if (!Number.isNaN(prevLower)) lower = lower > prevLower || prevClose < prevLower ? lower : prevLower;
    if (!Number.isNaN(prevUpper)) upper = upper < prevUpper || prevClose > prevUpper ? upper : prevUpper;
    let d: 1 | -1;
    if (i === 0 || a[i - 1] == null) d = -1;
    else if (dir[i - 1] === -1) d = c[i].close > upper ? 1 : -1; // was down: flips up above the upper band
    else d = c[i].close < lower ? -1 : 1; // was up: flips down below the lower band
    dir[i] = d;
    line[i] = d === 1 ? lower : upper;
    prevUpper = upper;
    prevLower = lower;
  }
  return { line, dir };
}

/** Highest high of the `period` bars ending at index i (inclusive). */
export function highest(c: Candle[], i: number, period: number) {
  let h = -Infinity;
  for (let j = Math.max(0, i - period + 1); j <= i; j++) h = Math.max(h, c[j].high);
  return h;
}

/** Lowest low of the `period` bars ending at index i (inclusive). */
export function lowest(c: Candle[], i: number, period: number) {
  let l = Infinity;
  for (let j = Math.max(0, i - period + 1); j <= i; j++) l = Math.min(l, c[j].low);
  return l;
}
