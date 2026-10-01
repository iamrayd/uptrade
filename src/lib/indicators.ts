import type { Candle } from "./types";

// ───────────────────────── Config ─────────────────────────

export interface IndicatorConfig {
  volume: boolean;
  ma1: { on: boolean; type: "EMA" | "SMA"; period: number };
  ma2: { on: boolean; type: "EMA" | "SMA"; period: number };
  ma3: { on: boolean; type: "EMA" | "SMA"; period: number };
  bb: { on: boolean; period: number; mult: number };
  vwap: boolean;
  rsi: { on: boolean; period: number };
  macd: { on: boolean; fast: number; slow: number; signal: number };
}

export const DEFAULT_INDICATORS: IndicatorConfig = {
  volume: true,
  ma1: { on: true, type: "EMA", period: 20 },
  ma2: { on: false, type: "EMA", period: 50 },
  ma3: { on: false, type: "SMA", period: 200 },
  bb: { on: false, period: 20, mult: 2 },
  vwap: false,
  rsi: { on: false, period: 14 },
  macd: { on: false, fast: 12, slow: 26, signal: 9 },
};

export const IND_COLORS = {
  ma1: "#f5c542",
  ma2: "#6d8cff",
  ma3: "#e879f9",
  bb: "#38bdf8",
  vwap: "#fb923c",
  rsi: "#a78bfa",
  macd: "#38bdf8",
  signal: "#fb923c",
};

// ───────────────────────── Math ─────────────────────────
// Every function returns an array aligned with the input (null during warm-up).

type Series = (number | null)[];

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

export function movingAverage(values: number[], type: "EMA" | "SMA", period: number) {
  return type === "EMA" ? ema(values, period) : sma(values, period);
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

/** VWAP that resets at 00:00 UTC each day. */
export function vwap(candles: Candle[]): Series {
  const out: Series = new Array(candles.length).fill(null);
  let day = -1;
  let pv = 0;
  let vol = 0;
  candles.forEach((c, i) => {
    const d = Math.floor(c.time / 86400);
    if (d !== day) {
      day = d;
      pv = 0;
      vol = 0;
    }
    const typical = (c.high + c.low + c.close) / 3;
    pv += typical * c.volume;
    vol += c.volume;
    out[i] = vol ? pv / vol : null;
  });
  return out;
}
