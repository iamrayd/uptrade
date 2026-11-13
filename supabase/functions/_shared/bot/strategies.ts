import type { Candle, ManageResult, Side, Signal, StrategyDef } from "./types.ts";
import { atr, bollinger, dmi, ema, highest, lowest, rsi, sma } from "./indicators.ts";
import { breaks, fvgAt, levels, orderBlockFor, rejectionCandle, rejects, swings, zoneState, type Zone } from "./structure.ts";

// Strategy v3. Every rule set looks only at CLOSED bars, so a signal can't repaint, and every
// signal it returns is traded: there is no score, gate or filter between a signal and an order
// (tick.ts). Position size is decided by the risk engine (risk.ts), never by the strategy.
//
// CANDIDATES are all the rule sets that were backtested (scripts/experiments/v3-select.ts).
// STRATEGIES are the five that trade: Fair Value Gap and Order Block by choice, the other three
// by their return on a year of history. docs/strategies/V3.md has the table.

const r = (n: number, d = 2) => +n.toFixed(d);
/** Rounds readings for the journal without losing meaning on low-priced coins. */
const px = (n: number) => +n.toPrecision(8);
const closes = (c: Candle[]) => c.map((x) => x.close);
const dirWord = (s: Side) => (s === "long" ? "Long" : "Short");

/** Shared by the structure rule sets. */
export const P = { atr: 14, targetR: 2, stopBufAtr: 0.25 };
const RISK_TEXT = `**Risk**
- Target: ${P.targetR}R (${P.targetR} × the stop distance)
- No early exit: the trade ends at its stop or its target`;

/** A signal with a fixed-R target measured from the signal bar's close. Null when the stop is not on the losing side. */
function signal(side: Side, close: number, stop: number, reason: string, indicators: Record<string, number>, targetR = P.targetR): Signal | null {
  const dist = side === "long" ? close - stop : stop - close;
  if (!(dist > 0)) return null;
  return { side, stop, takeProfit: side === "long" ? close + targetR * dist : close - targetR * dist, reason, indicators: { close: px(close), ...indicators } };
}

/** Stop beyond a zone and beyond the bar that tapped it, with an ATR buffer. */
function zoneStop(z: Zone, bar: Candle, a: number, buf = P.stopBufAtr) {
  return z.side === "long" ? Math.min(z.bottom, bar.low) - buf * a : Math.max(z.top, bar.high) + buf * a;
}

const noManage = (): ManageResult => ({});

// ───────────────────────── 1. Fair value gap ─────────────────────────

const FVG_P = { ...P, trend: 200, minBodyAtr: 1, maxAge: 30 };

export const fvg: StrategyDef = {
  key: "fvg",
  name: "Fair Value Gap",
  version: 1,
  summary: `First retrace into a displacement gap, in the direction of the 200 EMA. Stop beyond the gap, ${P.targetR}R target.`,
  params: FVG_P,
  warmup: 300,
  rules: `**Idea.** A fast move leaves a three-candle gap where price traded in one direction only (ICT's fair value gap). Price often returns to that gap once, finds the orders left behind and continues.

**The gap.** Three candles where the low of the third is above the high of the first (bullish), or the high of the third is below the low of the first (bearish). The middle candle's body must be at least ${FVG_P.minBodyAtr} × ATR(${P.atr}): a displacement, not drift.

**Long entry** (on the last closed bar)
- A bullish gap formed within the last ${FVG_P.maxAge} bars and no bar has traded into it since
- This bar trades into the gap and closes as a green bar above the gap's middle
- The close is above EMA ${FVG_P.trend}

**Short entry** is the mirror image: a bearish gap, a red bar closing below its middle, the close below EMA ${FVG_P.trend}.

**Stop.** Below the gap and below the entry bar's low, minus ${P.stopBufAtr} × ATR.

${RISK_TEXT}`,
  entry(c) {
    const i = c.length - 1;
    const a = atr(c, P.atr);
    const t = FVG_P.trend > 0 ? ema(closes(c), FVG_P.trend) : null;
    if (a[i] == null || (t && t[i] == null)) return null;
    const bar = c[i];
    for (let k = i - 1; k >= Math.max(2, i - FVG_P.maxAge); k--) {
      if (a[k - 1] == null) break;
      const z = fvgAt(c, k, a[k - 1]!, FVG_P.minBodyAtr);
      if (!z) continue;
      if (t && (z.side === "long" ? bar.close <= t[i]! : bar.close >= t[i]!)) continue;
      if (zoneState(c, z, i - 1) !== "fresh" || !rejects(c, z, i)) continue;
      const up = z.side === "long";
      return signal(
        z.side,
        bar.close,
        zoneStop(z, bar, a[i]!),
        `${dirWord(z.side)}: first retrace into the ${up ? "bullish" : "bearish"} fair value gap ${px(z.bottom)}–${px(z.top)} left ${i - k} bars ago. The bar traded into the gap and closed ${up ? "green above" : "red below"} its middle, with the close ${up ? "above" : "below"} EMA ${FVG_P.trend} (${px(t?.[i] ?? 0)}).`,
        { gapTop: px(z.top), gapBottom: px(z.bottom), gapAge: i - k, ema200: px(t?.[i] ?? 0), atr14: px(a[i]!) },
      );
    }
    return null;
  },
  manage: noManage,
};

// ───────────────────────── 2. Order block ─────────────────────────

const OB_P = { ...P, trend: 0, swing: 3, lookback: 10, minMoveAtr: 1.5, maxAge: 40, window: 200 };

export const orderBlock: StrategyDef = {
  key: "order_block",
  name: "Order Block",
  version: 1,
  summary: `First retest of the last opposite candle before a break of structure. Stop beyond the block, ${P.targetR}R target.`,
  params: OB_P,
  warmup: 300,
  rules: `**Idea.** The last down candle before a rally that breaks a swing high is where the buying started (ICT's order block). When price comes back to it for the first time, the same buyers tend to defend it.

**Break of structure.** A close above a confirmed swing high (a high with ${OB_P.swing} lower highs on each side), or below a confirmed swing low.

**The block.** The last candle against the move within ${OB_P.lookback} bars before the breaking bar. The move from the block's far edge to the breaking close must be at least ${OB_P.minMoveAtr} × ATR(${P.atr}). The zone is the block candle's full range.

**Long entry** (on the last closed bar)
- A bullish block formed within the last ${OB_P.maxAge} bars and no bar has traded into it since
- This bar trades into the block and closes as a green bar above the block's middle

**Short entry** is the mirror image.

**Stop.** Below the block and below the entry bar's low, minus ${P.stopBufAtr} × ATR.

${RISK_TEXT}`,
  entry(c) {
    const i = c.length - 1;
    const a = atr(c, P.atr);
    if (a[i] == null) return null;
    const bar = c[i];
    const from = Math.max(0, i - OB_P.window);
    const t = OB_P.trend > 0 ? ema(closes(c), OB_P.trend) : null;
    if (t && t[i] == null) return null;
    const bs = breaks(c, swings(c, OB_P.swing, OB_P.swing, i - 1, from), OB_P.swing, i - 1);
    for (let n = bs.length - 1; n >= 0; n--) {
      const b = bs[n];
      if (b.i < i - OB_P.maxAge) break;
      if (a[b.i] == null) continue;
      if (t && (b.side === "long" ? bar.close <= t[i]! : bar.close >= t[i]!)) continue;
      const z = orderBlockFor(c, b, a[b.i]!, OB_P.lookback, OB_P.minMoveAtr);
      if (!z || zoneState(c, z, i - 1) !== "fresh" || !rejects(c, z, i)) continue;
      const up = z.side === "long";
      return signal(
        z.side,
        bar.close,
        zoneStop(z, bar, a[i]!),
        `${dirWord(z.side)}: first retest of the ${up ? "bullish" : "bearish"} order block ${px(z.bottom)}–${px(z.top)}, the last ${up ? "down" : "up"} candle before the close ${up ? "above the swing high" : "below the swing low"} ${px(b.level)} ${i - b.i} bars ago. The bar traded into the block and closed ${up ? "green above" : "red below"} its middle.`,
        { blockTop: px(z.top), blockBottom: px(z.bottom), brokenSwing: px(b.level), blockAge: i - b.i, atr14: px(a[i]!) },
      );
    }
    return null;
  },
  manage: noManage,
};

// ───────────────────────── 3. Liquidity sweep ─────────────────────────

const SW_P = { ...P, swingLeft: 5, swingRight: 3, maxAge: 60 };

export const liquiditySweep: StrategyDef = {
  key: "liquidity_sweep",
  name: "Liquidity Sweep",
  version: 1,
  summary: `A wick takes out an untouched swing high or low and the bar closes back inside. Stop beyond the wick, ${P.targetR}R target.`,
  params: SW_P,
  warmup: 200,
  rules: `**Idea.** Stops collect beyond obvious swing highs and lows. A quick push through one that fails to hold has used that liquidity up, and price often reverses (ICT's liquidity grab, the old "turtle soup").

**Long entry** (on the last closed bar)
- A confirmed swing low (${SW_P.swingLeft} higher lows before it, ${SW_P.swingRight} after) from the last ${SW_P.maxAge} bars that no bar has traded below since
- This bar trades below it and closes back above it

**Short entry** is the mirror image: a wick above an untouched swing high, and a close back below it.

**Stop.** Beyond the sweeping bar's wick, plus ${P.stopBufAtr} × ATR(${P.atr}).

${RISK_TEXT}`,
  entry(c) {
    const i = c.length - 1;
    const a = atr(c, P.atr);
    if (a[i] == null) return null;
    const bar = c[i];
    const pivots = swings(c, SW_P.swingLeft, SW_P.swingRight, i - 1, Math.max(0, i - SW_P.maxAge));
    for (let n = pivots.length - 1; n >= 0; n--) {
      const p = pivots[n];
      const up = p.kind === "low";
      if (up ? !(bar.low < p.price && bar.close > p.price) : !(bar.high > p.price && bar.close < p.price)) continue;
      let untouched = true;
      for (let k = p.i + 1; k < i && untouched; k++) if (up ? c[k].low <= p.price : c[k].high >= p.price) untouched = false;
      if (!untouched) continue;
      const side: Side = up ? "long" : "short";
      return signal(
        side,
        bar.close,
        up ? bar.low - P.stopBufAtr * a[i]! : bar.high + P.stopBufAtr * a[i]!,
        `${dirWord(side)}: the bar swept the swing ${up ? "low" : "high"} ${px(p.price)} from ${i - p.i} bars ago (${up ? "low" : "high"} ${px(up ? bar.low : bar.high)}) and closed back ${up ? "above" : "below"} it at ${px(bar.close)}. The stops beyond that swing are used up.`,
        { sweptLevel: px(p.price), wick: px(up ? bar.low : bar.high), swingAge: i - p.i, atr14: px(a[i]!) },
      );
    }
    return null;
  },
  manage: noManage,
};

// ───────────────────────── 4. Break of structure pullback ─────────────────────────

const BOS_P = { ...P, swing: 3, maxAge: 20, tolAtr: 0.1, stopAtr: 0.5, window: 200 };

export const bosPullback: StrategyDef = {
  key: "bos_pullback",
  name: "Break of Structure Pullback",
  version: 1,
  summary: `Close through a swing point, then the first pullback that holds the broken level. ${P.targetR}R target.`,
  params: BOS_P,
  warmup: 300,
  rules: `**Idea.** A close through a swing high shows buyers in control. The first pullback to that broken high is the low-risk place to join them.

**Long entry** (on the last closed bar)
- Within the last ${BOS_P.maxAge} bars a bar closed above a confirmed swing high (${BOS_P.swing} lower highs on each side)
- No bar has come back to that level since
- This bar's low reaches the level (within ${BOS_P.tolAtr} × ATR(${P.atr})) and it closes above the level as a green bar

**Short entry** is the mirror image at a broken swing low.

**Stop.** ${BOS_P.stopAtr} × ATR beyond the entry bar's wick.

${RISK_TEXT}`,
  entry(c) {
    const i = c.length - 1;
    const a = atr(c, P.atr);
    if (a[i] == null) return null;
    const bar = c[i];
    const bs = breaks(c, swings(c, BOS_P.swing, BOS_P.swing, i - 1, Math.max(0, i - BOS_P.window)), BOS_P.swing, i - 1);
    for (let n = bs.length - 1; n >= 0; n--) {
      const b = bs[n];
      if (b.i < i - BOS_P.maxAge) break;
      const up = b.side === "long";
      const z: Zone = { side: b.side, top: b.level + (up ? BOS_P.tolAtr : BOS_P.stopAtr) * a[i]!, bottom: b.level - (up ? BOS_P.stopAtr : BOS_P.tolAtr) * a[i]!, i: b.i };
      if (zoneState(c, z, i - 1) !== "fresh") continue;
      const holds = up ? bar.low <= z.top && bar.close > b.level && bar.close > bar.open : bar.high >= z.bottom && bar.close < b.level && bar.close < bar.open;
      if (!holds) continue;
      return signal(
        b.side,
        bar.close,
        up ? bar.low - BOS_P.stopAtr * a[i]! : bar.high + BOS_P.stopAtr * a[i]!,
        `${dirWord(b.side)}: price closed ${up ? "above the swing high" : "below the swing low"} ${px(b.level)} ${i - b.i} bars ago. This is the first pullback to that level, and the bar closed ${up ? "green above" : "red below"} it.`,
        { brokenLevel: px(b.level), breakAge: i - b.i, atr14: px(a[i]!) },
      );
    }
    return null;
  },
  manage: noManage,
};

// ───────────────────────── 5 & 6. Support / resistance ─────────────────────────

const SR_P = { ...P, swing: 5, window: 300, clusterAtr: 0.5, minTouches: 2, tolAtr: 0.2 };

/** Swing points of the last `window` bars that were confirmed at or before `upTo`. */
const srPivots = (c: Candle[], i: number, upTo: number) => swings(c, SR_P.swing, SR_P.swing, upTo, Math.max(0, i - SR_P.window));

export const srBounce: StrategyDef = {
  key: "sr_bounce",
  name: "Support / Resistance Bounce",
  version: 1,
  summary: `Pin bar or engulfing candle at a level with ${SR_P.minTouches}+ swing touches. Stop beyond the level, ${P.targetR}R target.`,
  params: SR_P,
  warmup: 320,
  rules: `**Idea.** Price turns where it turned before. A rejection candle at such a level is the classic price-action entry.

**Levels.** Swing highs and lows of the last ${SR_P.window} bars (${SR_P.swing} bars on each side) that sit within ${SR_P.clusterAtr} × ATR(${P.atr}) of each other form one level, priced at their average. A level needs ${SR_P.minTouches} or more swings.

**Long entry** (on the last closed bar)
- The previous bar closed above a level (it is support)
- This bar's low reaches the level (within ${SR_P.tolAtr} × ATR) and it closes above it
- The bar is a bullish pin bar (lower wick at least 60% of its range) or a bullish engulfing candle

**Short entry** is the mirror image at resistance.

**Stop.** Beyond the level and the entry bar's wick, plus ${P.stopBufAtr} × ATR.

${RISK_TEXT}`,
  entry(c) {
    const i = c.length - 1;
    const a = atr(c, P.atr);
    if (i < 1 || a[i] == null) return null;
    const side = rejectionCandle(c, i);
    if (!side) return null;
    const bar = c[i];
    const prev = c[i - 1];
    const up = side === "long";
    const tol = SR_P.tolAtr * a[i]!;
    const lv = levels(srPivots(c, i, i - 1), SR_P.clusterAtr * a[i]!, SR_P.minTouches)
      .filter((l) => (up ? prev.close > l.price && bar.low <= l.price + tol && bar.close > l.price : prev.close < l.price && bar.high >= l.price - tol && bar.close < l.price))
      .sort((x, y) => y.touches - x.touches)[0];
    if (!lv) return null;
    return signal(
      side,
      bar.close,
      up ? Math.min(bar.low, lv.price) - P.stopBufAtr * a[i]! : Math.max(bar.high, lv.price) + P.stopBufAtr * a[i]!,
      `${dirWord(side)}: a ${pinOrEngulf(c, i)} at ${up ? "support" : "resistance"} ${px(lv.price)}, a level with ${lv.touches} swing touches. The bar reached the level and closed ${up ? "above" : "below"} it.`,
      { level: px(lv.price), touches: lv.touches, atr14: px(a[i]!) },
    );
  },
  manage: noManage,
};

function pinOrEngulf(c: Candle[], i: number) {
  const x = c[i];
  const range = x.high - x.low;
  const wick = Math.max(Math.min(x.open, x.close) - x.low, x.high - Math.max(x.open, x.close));
  return range > 0 && wick / range >= 0.6 ? "pin bar" : "engulfing candle";
}

const BR_P = { ...SR_P, maxAge: 12, breakAtr: 0.1, retestAtr: 0.25, stopAtr: 0.5 };

export const srBreakRetest: StrategyDef = {
  key: "sr_break_retest",
  name: "Break and Retest",
  version: 1,
  summary: `Close through a level with ${SR_P.minTouches}+ swing touches, then the first retest that holds. ${P.targetR}R target.`,
  params: BR_P,
  warmup: 320,
  rules: `**Idea.** Resistance that breaks tends to act as support on the way back. The retest confirms the breakout is real before the entry.

**Levels.** As in Support / Resistance Bounce: clusters of ${SR_P.minTouches}+ swing points within ${SR_P.clusterAtr} × ATR(${P.atr}).

**Long entry** (on the last closed bar)
- Within the last ${BR_P.maxAge} bars a bar closed more than ${BR_P.breakAtr} × ATR above a level, after a close at or below it
- No bar has come back to the level since
- This bar's low comes within ${BR_P.retestAtr} × ATR of the level and it closes above the level as a green bar

**Short entry** is the mirror image.

**Stop.** ${BR_P.stopAtr} × ATR beyond the level and the entry bar's wick.

${RISK_TEXT}`,
  entry(c) {
    const i = c.length - 1;
    const a = atr(c, P.atr);
    if (a[i] == null) return null;
    const bar = c[i];
    const at = a[i]!;
    const pivots = srPivots(c, i, i - 1);
    for (let k = i - 1; k >= Math.max(1, i - BR_P.maxAge); k--) {
      // Only swings confirmed by the breaking bar count: the level existed when it broke.
      const known = pivots.filter((p) => p.i + SR_P.swing <= k);
      for (const lv of levels(known, SR_P.clusterAtr * at, SR_P.minTouches)) {
        const up = c[k].close > lv.price + BR_P.breakAtr * at && c[k - 1].close <= lv.price;
        const down = c[k].close < lv.price - BR_P.breakAtr * at && c[k - 1].close >= lv.price;
        if (!up && !down) continue;
        const side: Side = up ? "long" : "short";
        const z: Zone = { side, top: lv.price + (up ? BR_P.retestAtr : BR_P.stopAtr) * at, bottom: lv.price - (up ? BR_P.stopAtr : BR_P.retestAtr) * at, i: k };
        if (zoneState(c, z, i - 1) !== "fresh") continue;
        const holds = up ? bar.low <= z.top && bar.close > lv.price && bar.close > bar.open : bar.high >= z.bottom && bar.close < lv.price && bar.close < bar.open;
        if (!holds) continue;
        return signal(
          side,
          bar.close,
          up ? Math.min(bar.low, lv.price) - BR_P.stopAtr * at : Math.max(bar.high, lv.price) + BR_P.stopAtr * at,
          `${dirWord(side)}: price closed ${up ? "above" : "below"} the level ${px(lv.price)} (${lv.touches} swing touches) ${i - k} bars ago. This is the first retest, and the bar closed ${up ? "green above" : "red below"} the level.`,
          { level: px(lv.price), touches: lv.touches, breakAge: i - k, atr14: px(at) },
        );
      }
    }
    return null;
  },
  manage: noManage,
};

// ───────────────────────── 7. EMA pullback ─────────────────────────

const EP_P = { ...P, fast: 20, slow: 50, slope: 5, stopAtr: 0.5 };

export const emaPullback: StrategyDef = {
  key: "ema_pullback",
  name: "EMA Pullback",
  version: 1,
  summary: `In a 20/50 EMA trend, the first dip to the 20 EMA that closes back above it. ${P.targetR}R target.`,
  params: EP_P,
  warmup: 200,
  rules: `**Idea.** In a trend, price keeps returning to its short moving average and bouncing. Buy the dip, not the breakout.

**Long entry** (on the last closed bar)
- EMA ${EP_P.fast} is above EMA ${EP_P.slow}, and EMA ${EP_P.slow} is higher than ${EP_P.slope} bars ago
- The previous bar stayed above EMA ${EP_P.fast}
- This bar's low touches EMA ${EP_P.fast} and it closes above it as a green bar

**Short entry** is the mirror image.

**Stop.** ${EP_P.stopAtr} × ATR(${P.atr}) beyond the entry bar's wick.

${RISK_TEXT}`,
  entry(c) {
    const i = c.length - 1;
    if (i < EP_P.slope + 1) return null;
    const cl = closes(c);
    const f = ema(cl, EP_P.fast);
    const s = ema(cl, EP_P.slow);
    const a = atr(c, P.atr);
    if (f[i - 1] == null || s[i - EP_P.slope] == null || a[i] == null) return null;
    const bar = c[i];
    const prev = c[i - 1];
    let side: Side | null = null;
    if (f[i]! > s[i]! && s[i]! > s[i - EP_P.slope]! && prev.low > f[i - 1]! && bar.low <= f[i]! && bar.close > f[i]! && bar.close > bar.open) side = "long";
    else if (f[i]! < s[i]! && s[i]! < s[i - EP_P.slope]! && prev.high < f[i - 1]! && bar.high >= f[i]! && bar.close < f[i]! && bar.close < bar.open) side = "short";
    if (!side) return null;
    const up = side === "long";
    return signal(
      side,
      bar.close,
      up ? bar.low - EP_P.stopAtr * a[i]! : bar.high + EP_P.stopAtr * a[i]!,
      `${dirWord(side)}: EMA ${EP_P.fast} (${px(f[i]!)}) is ${up ? "above" : "below"} a ${up ? "rising" : "falling"} EMA ${EP_P.slow} (${px(s[i]!)}). The bar ${up ? "dipped" : "rallied"} to EMA ${EP_P.fast} for the first time and closed back ${up ? "above" : "below"} it.`,
      { ema20: px(f[i]!), ema50: px(s[i]!), atr14: px(a[i]!) },
    );
  },
  manage: noManage,
};

// ───────────────────────── 8. Donchian breakout ─────────────────────────

const DC_P = { entryLen: 20, exitLen: 10, volLen: 20, volMult: 1.5, atr: 14, stopAtr: 2 };

export const donchianBreakout: StrategyDef = {
  key: "donchian_breakout",
  name: "Donchian Breakout",
  version: 1,
  summary: "Turtle-style 20-bar breakout confirmed by volume. 2×ATR stop, trails the 10-bar channel. No fixed target.",
  params: DC_P,
  warmup: 100,
  rules: `**Idea.** New 20-bar highs and lows tend to start trends. Cut losers fast and let winners run.

**Long entry** (on the last closed bar)
- The close breaks above the highest high of the previous ${DC_P.entryLen} bars
- Volume on the breakout bar is at least ${DC_P.volMult}× its ${DC_P.volLen}-bar average

**Short entry** is the mirror image (a close below the lowest low of the previous ${DC_P.entryLen} bars).

**Risk**
- Initial stop: ${DC_P.stopAtr} × ATR(${DC_P.atr})
- Trailing stop: the opposite ${DC_P.exitLen}-bar channel, moved only in the trade's favour at each bar close
- No fixed target. The trailing stop takes the exit.`,
  entry(c) {
    const i = c.length - 1;
    if (i < DC_P.entryLen + 1) return null;
    const a = atr(c, DC_P.atr);
    if (a[i] == null) return null;
    const hi = highest(c, i - 1, DC_P.entryLen);
    const lo = lowest(c, i - 1, DC_P.entryLen);
    const bar = c[i];
    const side: Side | null = bar.close > hi ? "long" : bar.close < lo ? "short" : null;
    if (!side) return null;
    const avgVol = sma(c.map((x) => x.volume), DC_P.volLen)[i - 1];
    if (avgVol == null || !(avgVol > 0) || bar.volume / avgVol < DC_P.volMult) return null;
    const volX = bar.volume / avgVol;
    const up = side === "long";
    const dist = DC_P.stopAtr * a[i]!;
    return {
      side,
      stop: up ? bar.close - dist : bar.close + dist,
      takeProfit: null,
      reason: `${dirWord(side)}: the close ${px(bar.close)} broke ${up ? "above the 20-bar high" : "below the 20-bar low"} ${px(up ? hi : lo)} on ${r(volX)}× average volume. No fixed target: the stop trails the 10-bar channel.`,
      indicators: { close: px(bar.close), channelHigh20: px(hi), channelLow20: px(lo), volumeX: r(volX), atr14: px(a[i]!) },
    };
  },
  manage(c, tr): ManageResult {
    const i = c.length - 1;
    const stop = tr.side === "long" ? lowest(c, i, DC_P.exitLen) : highest(c, i, DC_P.exitLen);
    return { stop, stopNote: `trail to the ${DC_P.exitLen}-bar ${tr.side === "long" ? "low" : "high"} ${px(stop)}` };
  },
};

// ───────────────────────── 9. Bollinger + RSI reversion ─────────────────────────

const BB_P = { bbPeriod: 20, bbMult: 2, rsi: 14, rsiLow: 30, rsiHigh: 70, atr: 14, adx: 14, maxAdx: 35, minRewardRisk: 1, maxBars: 24 };

export const bbRsiReversion: StrategyDef = {
  key: "bb_rsi_reversion",
  name: "Bollinger + RSI Reversion",
  version: 1,
  summary: "Fade a close outside the 2σ band at an RSI extreme once price closes back inside. Target the middle band.",
  params: BB_P,
  warmup: 200,
  rules: `**Idea.** After an overstretched move, price tends to snap back toward its 20-bar average.

**Long entry**
- The previous bar closed below the lower Bollinger Band (${BB_P.bbPeriod}, ${BB_P.bbMult}) with RSI(${BB_P.rsi}) below ${BB_P.rsiLow}
- The last bar closed back inside the band as a green bar
- ADX(${BB_P.adx}) is at most ${BB_P.maxAdx} (a strong trend is not faded)
- The middle band is at least ${BB_P.minRewardRisk}× the stop distance away

**Short entry** is the mirror image: a close above the upper band with RSI above ${BB_P.rsiHigh}, then a red close back inside.

**Risk**
- Stop: beyond the extreme of the last 3 bars, plus 0.25 × ATR(${BB_P.atr})
- Target: the middle band (SMA ${BB_P.bbPeriod}) at entry
- Time stop: close at market after ${BB_P.maxBars} bars if neither stop nor target was hit`,
  entry(c) {
    const i = c.length - 1;
    if (i < 3) return null;
    const cl = closes(c);
    const bb = bollinger(cl, BB_P.bbPeriod, BB_P.bbMult);
    const rs = rsi(cl, BB_P.rsi);
    const a = atr(c, BB_P.atr);
    const { adx } = dmi(c, BB_P.adx);
    if (bb.lower[i - 1] == null || rs[i - 1] == null || a[i] == null || adx[i] == null) return null;
    const prev = c[i - 1];
    const bar = c[i];
    let side: Side | null = null;
    if (prev.close < bb.lower[i - 1]! && rs[i - 1]! < BB_P.rsiLow && bar.close > bb.lower[i]! && bar.close > bar.open) side = "long";
    if (prev.close > bb.upper[i - 1]! && rs[i - 1]! > BB_P.rsiHigh && bar.close < bb.upper[i]! && bar.close < bar.open) side = "short";
    if (!side || adx[i]! > BB_P.maxAdx) return null;
    const up = side === "long";
    const buf = 0.25 * a[i]!;
    const stop = up ? lowest(c, i, 3) - buf : highest(c, i, 3) + buf;
    const target = bb.mid[i]!;
    const risk = Math.abs(bar.close - stop);
    const reward = up ? target - bar.close : bar.close - target;
    if (!(risk > 0) || reward / risk < BB_P.minRewardRisk) return null;
    return {
      side,
      stop,
      takeProfit: target,
      reason: `${dirWord(side)}: the previous bar closed ${up ? "below the lower" : "above the upper"} band (${px(prev.close)}) with RSI ${r(rs[i - 1]!)}. This bar closed back inside the band as a ${up ? "green" : "red"} bar. Target is the middle band ${px(target)}, ${r(reward / risk)}R away.`,
      indicators: { close: px(bar.close), bbUpper: px(bb.upper[i]!), bbMid: px(bb.mid[i]!), bbLower: px(bb.lower[i]!), rsiPrev: r(rs[i - 1]!), rsi: r(rs[i]!), adx14: r(adx[i]!), atr14: px(a[i]!) },
    };
  },
  manage(_c, tr) {
    if (tr.barsHeld >= BB_P.maxBars)
      return { exit: { reason: "time_exit", note: `No snap-back within ${BB_P.maxBars} bars, so the reversion idea is stale. Closed at market.` } };
    return {};
  },
};

// ───────────────────────── 10. Double top / bottom ─────────────────────────

const DT_P = { ...P, swingLeft: 5, swingRight: 3, window: 120, tolAtr: 0.5, minGap: 8, minHeightAtr: 2, maxAge: 30 };

export const doubleTopBottom: StrategyDef = {
  key: "double_top_bottom",
  name: "Double Top / Bottom",
  version: 1,
  summary: `Two swing highs (or lows) at the same price, entered on the close through the neckline. ${P.targetR}R target.`,
  params: DT_P,
  warmup: 200,
  rules: `**Idea.** Two failed attempts at the same price show the move is exhausted. The pattern completes when price closes through the low between the two tops (the neckline).

**Short entry: double top** (on the last closed bar)
- Two confirmed swing highs within the last ${DT_P.window} bars, at least ${DT_P.minGap} bars apart, within ${DT_P.tolAtr} × ATR(${P.atr}) of each other
- The pattern is at least ${DT_P.minHeightAtr} × ATR tall (tops to neckline)
- Since the second top, no bar closed above the tops, and this is the first close below the neckline, at most ${DT_P.maxAge} bars after the second top

**Long entry: double bottom** is the mirror image.

**Stop.** The middle of the pattern (halfway between the neckline and the tops), plus ${P.stopBufAtr} × ATR.

${RISK_TEXT}`,
  entry(c) {
    const i = c.length - 1;
    const a = atr(c, P.atr);
    if (a[i] == null) return null;
    const at = a[i]!;
    const bar = c[i];
    const pivots = swings(c, DT_P.swingLeft, DT_P.swingRight, i - 1, Math.max(0, i - DT_P.window));
    for (const kind of ["high", "low"] as const) {
      const top = kind === "high";
      const ps = pivots.filter((p) => p.kind === kind);
      for (let n = ps.length - 1; n >= 1; n--) {
        const p2 = ps[n];
        if (i - p2.i > DT_P.maxAge) break;
        for (let m = n - 1; m >= 0; m--) {
          const p1 = ps[m];
          if (p2.i - p1.i < DT_P.minGap || Math.abs(p1.price - p2.price) > DT_P.tolAtr * at) continue;
          const edge = top ? Math.max(p1.price, p2.price) : Math.min(p1.price, p2.price);
          let neck = top ? Infinity : -Infinity;
          for (let k = p1.i; k <= p2.i; k++) neck = top ? Math.min(neck, c[k].low) : Math.max(neck, c[k].high);
          const height = Math.abs(edge - neck);
          if (height < DT_P.minHeightAtr * at) continue;
          if (top ? bar.close >= neck : bar.close <= neck) continue;
          let clean = true;
          for (let k = p2.i + 1; k < i && clean; k++) if (top ? c[k].close > edge || c[k].close < neck : c[k].close < edge || c[k].close > neck) clean = false;
          if (!clean) continue;
          const side: Side = top ? "short" : "long";
          const mid = (edge + neck) / 2;
          return signal(
            side,
            bar.close,
            top ? mid + P.stopBufAtr * at : mid - P.stopBufAtr * at,
            `${dirWord(side)}: double ${top ? "top" : "bottom"} at ${px(p1.price)} and ${px(p2.price)} (${p2.i - p1.i} bars apart). The bar closed ${top ? "below" : "above"} the neckline ${px(neck)}, which completes the pattern.`,
            { first: px(p1.price), second: px(p2.price), neckline: px(neck), atr14: px(at) },
          );
        }
      }
    }
    return null;
  },
  manage: noManage,
};

// ───────────────────────── Registry ─────────────────────────

/** Every rule set that was backtested. */
export const CANDIDATES: StrategyDef[] = [fvg, orderBlock, liquiditySweep, bosPullback, srBounce, srBreakRetest, emaPullback, donchianBreakout, bbRsiReversion, doubleTopBottom];

/** The five that trade. */
export const STRATEGIES: StrategyDef[] = [fvg, orderBlock, bbRsiReversion, emaPullback, donchianBreakout];
export const STRATEGY_BY_KEY: Record<string, StrategyDef> = Object.fromEntries(STRATEGIES.map((s) => [s.key, s]));
