import type { Candle, Side } from "./types.ts";

// Market structure read from closed bars: swing points, breaks of structure, fair value gaps,
// order blocks, support/resistance levels and two candle patterns.
//
// Nothing here looks ahead. A swing point only exists once `right` bars have closed after it,
// and every function that takes an index `i` reads bars 0..i only. A strategy passes the last
// closed bar as `i`, so what it sees is what a trader saw at that close.

export interface Pivot {
  /** Index of the bar that made the swing. */
  i: number;
  price: number;
  kind: "high" | "low";
}

/**
 * Swing highs and lows among bars `from`..`upTo`. A swing high is a bar whose high is above the
 * highs of the `left` bars before it and not below the highs of the `right` bars after it. It is
 * only returned once those `right` bars exist at or before `upTo` (confirmed).
 */
export function swings(c: Candle[], left = 3, right = 3, upTo = c.length - 1, from = 0): Pivot[] {
  const out: Pivot[] = [];
  for (let j = Math.max(left, from); j + right <= upTo; j++) {
    let hi = true;
    let lo = true;
    for (let k = j - left; k < j && (hi || lo); k++) {
      if (c[k].high >= c[j].high) hi = false;
      if (c[k].low <= c[j].low) lo = false;
    }
    for (let k = j + 1; k <= j + right && (hi || lo); k++) {
      if (c[k].high > c[j].high) hi = false;
      if (c[k].low < c[j].low) lo = false;
    }
    if (hi) out.push({ i: j, price: c[j].high, kind: "high" });
    if (lo) out.push({ i: j, price: c[j].low, kind: "low" });
  }
  return out;
}

export interface Break {
  /** Bar whose close broke the swing. */
  i: number;
  side: Side;
  /** The broken swing price. */
  level: number;
  pivot: Pivot;
}

/**
 * Breaks of structure among `pivots`: for each swing, the first bar that CLOSES beyond it, if
 * that bar comes after the swing was confirmed (`right` bars later) and at or before `upTo`.
 * A close above a swing high is a bullish break ("long"), below a swing low a bearish one.
 */
export function breaks(c: Candle[], pivots: Pivot[], right = 3, upTo = c.length - 1): Break[] {
  const out: Break[] = [];
  for (const p of pivots) {
    for (let k = p.i + 1; k <= upTo; k++) {
      const broke = p.kind === "high" ? c[k].close > p.price : c[k].close < p.price;
      if (!broke) continue;
      if (k > p.i + right) out.push({ i: k, side: p.kind === "high" ? "long" : "short", level: p.price, pivot: p });
      break;
    }
  }
  return out.sort((a, b) => a.i - b.i);
}

export interface Zone {
  side: Side;
  top: number;
  bottom: number;
  /** Bar that completed the zone. It can be traded from the next bar on. */
  i: number;
}

/**
 * Fair value gap completed at bar `k`: a three-candle imbalance. Bullish when the low of bar k
 * is above the high of bar k−2, so the middle candle moved through that range without the
 * neighbours overlapping. The middle candle's body must be at least `minBodyAtr` × ATR
 * (a displacement, not drift). `atrAt` is ATR at the middle candle.
 */
export function fvgAt(c: Candle[], k: number, atrAt: number, minBodyAtr = 1): Zone | null {
  if (k < 2) return null;
  const a = c[k - 2];
  const m = c[k - 1];
  const b = c[k];
  if (Math.abs(m.close - m.open) < minBodyAtr * atrAt) return null;
  if (m.close > m.open && b.low > a.high) return { side: "long", top: b.low, bottom: a.high, i: k };
  if (m.close < m.open && b.high < a.low) return { side: "short", top: a.low, bottom: b.high, i: k };
  return null;
}

/**
 * Order block for a break of structure: the last candle against the move before the impulse
 * that broke the swing (the last down candle before a bullish break). The zone is that candle's
 * full range. The impulse, from the block's far edge to the breaking close, must be at least
 * `minMoveAtr` × ATR. Returns null when no such candle is found within `lookback` bars.
 */
export function orderBlockFor(c: Candle[], b: Break, atrAt: number, lookback = 10, minMoveAtr = 1.5): Zone | null {
  for (let j = b.i - 1; j >= Math.max(0, b.i - lookback); j--) {
    const x = c[j];
    const against = b.side === "long" ? x.close < x.open : x.close > x.open;
    if (!against) continue;
    const move = b.side === "long" ? c[b.i].close - x.low : x.high - c[b.i].close;
    if (move < minMoveAtr * atrAt) return null;
    return { side: b.side, top: x.high, bottom: x.low, i: b.i };
  }
  return null;
}

export type ZoneState = "fresh" | "tapped" | "broken";

/**
 * What happened to a zone on bars z.i+1 .. upTo: "broken" once a bar closed beyond its far
 * edge, "tapped" once a bar traded into it, otherwise "fresh".
 */
export function zoneState(c: Candle[], z: Zone, upTo: number): ZoneState {
  let tapped = false;
  for (let k = z.i + 1; k <= upTo; k++) {
    if (z.side === "long" ? c[k].close < z.bottom : c[k].close > z.top) return "broken";
    if (z.side === "long" ? c[k].low <= z.top : c[k].high >= z.bottom) tapped = true;
  }
  return tapped ? "tapped" : "fresh";
}

/**
 * True when bar `i` trades into the zone and rejects it: a candle in the zone's direction that
 * closes beyond the zone's middle, on the zone's own side.
 */
export function rejects(c: Candle[], z: Zone, i: number) {
  const x = c[i];
  const mid = (z.top + z.bottom) / 2;
  return z.side === "long" ? x.low <= z.top && x.close > mid && x.close > x.open : x.high >= z.bottom && x.close < mid && x.close < x.open;
}

export interface Level {
  price: number;
  /** Number of swing points in the cluster. */
  touches: number;
  /** Index of the latest swing in the cluster. */
  last: number;
}

/**
 * Support/resistance levels: swing points (highs and lows together, since old resistance turns
 * into support) that sit within `width` of each other are one level, priced at their mean.
 * Only clusters of `minTouches` or more swings are returned.
 */
export function levels(pivots: Pivot[], width: number, minTouches = 2): Level[] {
  const sorted = [...pivots].sort((a, b) => a.price - b.price);
  const out: Level[] = [];
  let group: Pivot[] = [];
  const close = () => {
    if (group.length >= minTouches)
      out.push({ price: group.reduce((s, p) => s + p.price, 0) / group.length, touches: group.length, last: Math.max(...group.map((p) => p.i)) });
    group = [];
  };
  for (const p of sorted) {
    if (group.length && p.price - group[0].price > width) close();
    group.push(p);
  }
  close();
  return out;
}

/** A candle whose body covers the previous candle's body, in the opposite direction. */
export function engulfing(c: Candle[], i: number): Side | null {
  if (i < 1) return null;
  const p = c[i - 1];
  const x = c[i];
  if (p.close < p.open && x.close > x.open && x.close >= p.open && x.open <= p.close) return "long";
  if (p.close > p.open && x.close < x.open && x.close <= p.open && x.open >= p.close) return "short";
  return null;
}

/** A candle with a long wick on one side: the wick is at least `wickShare` of the whole range. */
export function pinBar(c: Candle[], i: number, wickShare = 0.6): Side | null {
  const x = c[i];
  const range = x.high - x.low;
  if (!(range > 0)) return null;
  const lower = Math.min(x.open, x.close) - x.low;
  const upper = x.high - Math.max(x.open, x.close);
  if (lower / range >= wickShare) return "long";
  if (upper / range >= wickShare) return "short";
  return null;
}

/** A rejection candle in either form. */
export function rejectionCandle(c: Candle[], i: number): Side | null {
  return pinBar(c, i) ?? engulfing(c, i);
}
