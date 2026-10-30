import type { Candle, ManageResult, Side, StrategyDef } from "./types.ts";
import { atr, bollinger, dmi, ema, highest, lowest, macd, rsi, sma, supertrend } from "./indicators.ts";

// Five widely used crypto strategies. Each one looks only at CLOSED bars, so a
// signal can't repaint. Stops are ATR- or structure-based; position size is
// decided by the risk engine (risk.ts), never by the strategy.
//
// Where a rule is my addition to the textbook version it is marked
// "Modification" in the rules text, with the reason.

const r = (n: number, d = 2) => +n.toFixed(d);
/** Rounds indicator readings for the journal without losing meaning on low-priced coins. */
const px = (n: number) => +n.toPrecision(8);

const closes = (c: Candle[]) => c.map((x) => x.close);

/** True if series a crossed above b on the last bar. */
function crossUp(a: (number | null)[], b: (number | null)[], i: number) {
  return a[i - 1] != null && b[i - 1] != null && a[i] != null && b[i] != null && a[i - 1]! <= b[i - 1]! && a[i]! > b[i]!;
}
function crossDown(a: (number | null)[], b: (number | null)[], i: number) {
  return a[i - 1] != null && b[i - 1] != null && a[i] != null && b[i] != null && a[i - 1]! >= b[i - 1]! && a[i]! < b[i]!;
}

const dirWord = (s: Side) => (s === "long" ? "Long" : "Short");

// ───────────────────────── 1. EMA trend cross ─────────────────────────

const EMA_P = { fast: 9, slow: 21, trend: 200, atr: 14, stopAtr: 1.5, targetR: 2 };

export const emaTrend: StrategyDef = {
  key: "ema_trend",
  name: "EMA Trend Cross",
  version: 1,
  summary: "9/21 EMA crossover, only in the direction of the 200 EMA. 1.5×ATR stop, 2R target.",
  params: EMA_P,
  warmup: 400,
  rules: `**Idea.** Ride short-term momentum only when it agrees with the long-term trend.

**Long entry** (all on the last closed bar)
- EMA 9 crosses above EMA 21
- Close is above EMA 200 (long-term uptrend)

**Short entry** is the mirror image: EMA 9 crosses below EMA 21 with the close below EMA 200.

**Risk**
- Stop: 1.5 × ATR(14) from the entry price
- Target: 2R (twice the stop distance)
- Early exit: the opposite EMA 9/21 cross closes the trade at market`,
  entry(c) {
    const i = c.length - 1;
    const cl = closes(c);
    const f = ema(cl, EMA_P.fast);
    const s = ema(cl, EMA_P.slow);
    const t = ema(cl, EMA_P.trend);
    const a = atr(c, EMA_P.atr);
    if (t[i] == null || a[i] == null) return null;
    const up = crossUp(f, s, i);
    const down = crossDown(f, s, i);
    if (!up && !down) return null;
    const side: Side = up ? "long" : "short";
    const close = c[i].close;
    const ind = { close: px(close), ema9: px(f[i]!), ema21: px(s[i]!), ema200: px(t[i]!), atr14: px(a[i]!) };
    if (side === "long" && close <= t[i]!)
      return { skip: `EMA 9 crossed above EMA 21, but the close ${px(close)} is below EMA 200 ${px(t[i]!)}: no longs against the trend.` };
    if (side === "short" && close >= t[i]!)
      return { skip: `EMA 9 crossed below EMA 21, but the close ${px(close)} is above EMA 200 ${px(t[i]!)}: no shorts against the trend.` };
    const dist = EMA_P.stopAtr * a[i]!;
    const sign = side === "long" ? 1 : -1;
    return {
      side,
      stop: close - sign * dist,
      takeProfit: close + sign * dist * EMA_P.targetR,
      reason: `${dirWord(side)}: EMA 9 (${px(f[i]!)}) crossed ${up ? "above" : "below"} EMA 21 (${px(s[i]!)}) with the close ${up ? "above" : "below"} EMA 200 (${px(t[i]!)}), so short-term momentum agrees with the long-term trend.`,
      indicators: ind,
    };
  },
  manage(c, tr) {
    const i = c.length - 1;
    const cl = closes(c);
    const f = ema(cl, EMA_P.fast);
    const s = ema(cl, EMA_P.slow);
    if (tr.side === "long" && crossDown(f, s, i))
      return { exit: { reason: "signal", note: `EMA 9 (${px(f[i]!)}) crossed back below EMA 21 (${px(s[i]!)}): momentum turned against the long.` } };
    if (tr.side === "short" && crossUp(f, s, i))
      return { exit: { reason: "signal", note: `EMA 9 (${px(f[i]!)}) crossed back above EMA 21 (${px(s[i]!)}): momentum turned against the short.` } };
    return {};
  },
};

// ───────────────────────── 2. Bollinger + RSI mean reversion ─────────────────────────

const BB_P = { bbPeriod: 20, bbMult: 2, rsi: 14, rsiLow: 30, rsiHigh: 70, atr: 14, adx: 14, maxAdx: 35, minRewardRisk: 1, maxBars: 24 };

export const bbRsi: StrategyDef = {
  key: "bb_rsi",
  name: "Bollinger + RSI Reversion",
  version: 1,
  summary: "Fade a close outside the 2σ band at an RSI extreme once price closes back inside. Target the middle band.",
  params: BB_P,
  warmup: 200,
  rules: `**Idea.** After an overstretched move, price tends to snap back toward its 20-bar mean.

**Long entry**
- The previous bar closed **below** the lower Bollinger Band (20, 2) with RSI(14) **below 30**
- The last bar closed back **inside** the band, and it's a green bar (close > open)

**Short entry** is the mirror image: a close above the upper band with RSI above 70, then a red close back inside.

**Filters**
- *Modification:* skip when ADX(14) > 35. Fading a strong trend is the main way this strategy loses, and ADX measures trend strength.
- *Modification:* skip when the reward to the middle band is less than 1× the risk.

**Risk**
- Stop: beyond the extreme of the last 3 bars, plus 0.25 × ATR(14) buffer
- Target: the middle band (SMA 20) at entry
- Time stop: close at market after 24 bars if neither stop nor target was hit`,
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
    const last = c[i];
    let side: Side | null = null;
    if (prev.close < bb.lower[i - 1]! && rs[i - 1]! < BB_P.rsiLow && last.close > bb.lower[i]! && last.close > last.open) side = "long";
    if (prev.close > bb.upper[i - 1]! && rs[i - 1]! > BB_P.rsiHigh && last.close < bb.upper[i]! && last.close < last.open) side = "short";
    if (!side) return null;
    const ind = {
      close: px(last.close),
      bbUpper: px(bb.upper[i]!),
      bbMid: px(bb.mid[i]!),
      bbLower: px(bb.lower[i]!),
      prevClose: px(prev.close),
      rsiPrev: r(rs[i - 1]!),
      rsi: r(rs[i]!),
      adx14: r(adx[i]!),
      atr14: px(a[i]!),
    };
    if (adx[i]! > BB_P.maxAdx)
      return { skip: `Reversion setup, but ADX ${r(adx[i]!)} > ${BB_P.maxAdx} says the trend is too strong to fade.` };
    const buf = 0.25 * a[i]!;
    const stop = side === "long" ? lowest(c, i, 3) - buf : highest(c, i, 3) + buf;
    const target = bb.mid[i]!;
    const risk = Math.abs(last.close - stop);
    const reward = side === "long" ? target - last.close : last.close - target;
    if (risk <= 0 || reward / risk < BB_P.minRewardRisk)
      return { skip: `Reversion setup, but the middle band is only ${r(reward / (risk || 1))}R away (need ${BB_P.minRewardRisk}R).` };
    return {
      side,
      stop,
      takeProfit: target,
      reason:
        side === "long"
          ? `Long: the previous bar closed below the lower band (${px(prev.close)} < ${px(bb.lower[i - 1]!)}) with RSI ${r(rs[i - 1]!)} (oversold). This bar closed back inside the band as a green bar. Target is the middle band ${px(target)}, ${r(reward / risk)}R away.`
          : `Short: the previous bar closed above the upper band (${px(prev.close)} > ${px(bb.upper[i - 1]!)}) with RSI ${r(rs[i - 1]!)} (overbought). This bar closed back inside the band as a red bar. Target is the middle band ${px(target)}, ${r(reward / risk)}R away.`,
      indicators: ind,
    };
  },
  manage(_c, tr) {
    if (tr.barsHeld >= BB_P.maxBars)
      return { exit: { reason: "time_exit", note: `No snap-back within ${BB_P.maxBars} bars, so the reversion idea is stale. Closed at market.` } };
    return {};
  },
};

// ───────────────────────── 3. Donchian breakout ─────────────────────────

const DC_P = { entryLen: 20, exitLen: 10, volLen: 20, volMult: 1.5, atr: 14, stopAtr: 2 };

export const donchian: StrategyDef = {
  key: "donchian",
  name: "Donchian Breakout",
  version: 1,
  summary: "Turtle-style 20-bar breakout confirmed by volume. 2×ATR stop, trails the 10-bar channel. No fixed target.",
  params: DC_P,
  warmup: 100,
  rules: `**Idea.** New 20-bar highs/lows tend to start trends. Cut losers fast and let winners run.

**Long entry**
- Close breaks **above** the highest high of the previous 20 bars
- *Modification:* volume on the breakout bar is at least 1.5× its 20-bar average. Breakouts without volume fail more often.

**Short entry** is the mirror image (close below the lowest low of the previous 20 bars).

**Risk**
- Initial stop: 2 × ATR(14)
- Trailing stop: the opposite 10-bar channel (the lowest low of the last 10 bars for a long), moved only in the trade's favour at each bar close
- No fixed target. The trailing stop takes the exit.`,
  entry(c) {
    const i = c.length - 1;
    if (i < DC_P.entryLen + 1) return null;
    const a = atr(c, DC_P.atr);
    if (a[i] == null) return null;
    const hi = highest(c, i - 1, DC_P.entryLen);
    const lo = lowest(c, i - 1, DC_P.entryLen);
    const last = c[i];
    let side: Side | null = null;
    if (last.close > hi) side = "long";
    else if (last.close < lo) side = "short";
    if (!side) return null;
    const vols = c.map((x) => x.volume);
    const avgVol = sma(vols, DC_P.volLen)[i - 1];
    if (avgVol == null) return null;
    const volX = avgVol ? last.volume / avgVol : 0;
    const ind = { close: px(last.close), channelHigh20: px(hi), channelLow20: px(lo), volume: px(last.volume), avgVolume20: px(avgVol), volumeX: r(volX), atr14: px(a[i]!) };
    if (volX < DC_P.volMult)
      return { skip: `${side === "long" ? "Upside" : "Downside"} breakout on only ${r(volX)}× average volume (need ${DC_P.volMult}×).` };
    const dist = DC_P.stopAtr * a[i]!;
    return {
      side,
      stop: side === "long" ? last.close - dist : last.close + dist,
      takeProfit: null,
      reason:
        side === "long"
          ? `Long: the close ${px(last.close)} broke above the 20-bar high ${px(hi)} on ${r(volX)}× average volume. A new range high with participation often starts a trend.`
          : `Short: the close ${px(last.close)} broke below the 20-bar low ${px(lo)} on ${r(volX)}× average volume. A new range low with participation often starts a downtrend.`,
      indicators: ind,
    };
  },
  manage(c, tr): ManageResult {
    const i = c.length - 1;
    const stop = tr.side === "long" ? lowest(c, i, DC_P.exitLen) : highest(c, i, DC_P.exitLen);
    return { stop, stopNote: `trail to the 10-bar ${tr.side === "long" ? "low" : "high"} ${px(stop)}` };
  },
};

// ───────────────────────── 4. MACD + ADX momentum ─────────────────────────

const MA_P = { fast: 12, slow: 26, signal: 9, adx: 14, minAdx: 25, atr: 14, stopAtr: 1.5, targetR: 2 };

export const macdAdx: StrategyDef = {
  key: "macd_adx",
  name: "MACD Momentum + ADX",
  version: 1,
  summary: "MACD/signal cross when ADX > 25 and the DMI agrees. 1.5×ATR stop, 2R target.",
  params: MA_P,
  warmup: 300,
  rules: `**Idea.** Trade MACD momentum shifts only when a real trend is present.

**Long entry**
- MACD (12, 26) crosses above its 9-period signal line
- ADX(14) ≥ 25 (trending market)
- +DI > −DI (the trend is up)

**Short entry** is the mirror image: MACD crosses below the signal line, ADX ≥ 25, and −DI > +DI.

**Risk**
- Stop: 1.5 × ATR(14)
- Target: 2R
- Early exit: the opposite MACD/signal cross closes the trade at market`,
  entry(c) {
    const i = c.length - 1;
    const cl = closes(c);
    const m = macd(cl, MA_P.fast, MA_P.slow, MA_P.signal);
    const d = dmi(c, MA_P.adx);
    const a = atr(c, MA_P.atr);
    if (m.signal[i - 1] == null || d.adx[i] == null || a[i] == null) return null;
    const up = crossUp(m.line, m.signal, i);
    const down = crossDown(m.line, m.signal, i);
    if (!up && !down) return null;
    const side: Side = up ? "long" : "short";
    const ind = {
      close: px(c[i].close),
      macd: px(m.line[i]!),
      signal: px(m.signal[i]!),
      hist: px(m.hist[i]!),
      adx14: r(d.adx[i]!),
      plusDI: r(d.plusDI[i]!),
      minusDI: r(d.minusDI[i]!),
      atr14: px(a[i]!),
    };
    if (d.adx[i]! < MA_P.minAdx) return { skip: `MACD crossed ${up ? "up" : "down"}, but ADX ${r(d.adx[i]!)} < ${MA_P.minAdx}: no trend to ride.` };
    if (side === "long" && d.plusDI[i]! <= d.minusDI[i]!)
      return { skip: `MACD crossed up with ADX ${r(d.adx[i]!)}, but −DI ${r(d.minusDI[i]!)} ≥ +DI ${r(d.plusDI[i]!)}: the trend is down.` };
    if (side === "short" && d.minusDI[i]! <= d.plusDI[i]!)
      return { skip: `MACD crossed down with ADX ${r(d.adx[i]!)}, but +DI ${r(d.plusDI[i]!)} ≥ −DI ${r(d.minusDI[i]!)}: the trend is up.` };
    const close = c[i].close;
    const dist = MA_P.stopAtr * a[i]!;
    const sign = side === "long" ? 1 : -1;
    return {
      side,
      stop: close - sign * dist,
      takeProfit: close + sign * dist * MA_P.targetR,
      reason: `${dirWord(side)}: MACD (${px(m.line[i]!)}) crossed ${up ? "above" : "below"} its signal (${px(m.signal[i]!)}) while ADX is ${r(d.adx[i]!)} and ${up ? "+DI" : "−DI"} leads (${r(up ? d.plusDI[i]! : d.minusDI[i]!)} vs ${r(up ? d.minusDI[i]! : d.plusDI[i]!)}), so momentum is turning in the direction of an established trend.`,
      indicators: ind,
    };
  },
  manage(c, tr) {
    const i = c.length - 1;
    const m = macd(closes(c), MA_P.fast, MA_P.slow, MA_P.signal);
    if (tr.side === "long" && crossDown(m.line, m.signal, i))
      return { exit: { reason: "signal", note: `MACD crossed back below its signal (${px(m.line[i]!)} < ${px(m.signal[i]!)}): momentum faded.` } };
    if (tr.side === "short" && crossUp(m.line, m.signal, i))
      return { exit: { reason: "signal", note: `MACD crossed back above its signal (${px(m.line[i]!)} > ${px(m.signal[i]!)}): momentum faded.` } };
    return {};
  },
};

// ───────────────────────── 5. Supertrend ─────────────────────────

const ST_P = { atrPeriod: 10, factor: 3, adx: 14, minAdx: 20 };

export const supertrendStrat: StrategyDef = {
  key: "supertrend",
  name: "Supertrend Flip",
  version: 1,
  summary: "Enter when Supertrend(10, 3) flips, if ADX ≥ 20. The Supertrend line is the trailing stop.",
  params: ST_P,
  warmup: 200,
  rules: `**Idea.** Supertrend is an ATR-based trailing line. A flip marks a change of trend, and the line then trails price.

**Long entry**
- Supertrend (ATR 10, factor 3) flips from down to up on the last closed bar
- *Modification:* ADX(14) ≥ 20. Supertrend whipsaws in flat markets, and this filter skips the worst of them.

**Short entry** is the mirror image (a flip from up to down).

**Risk**
- Stop: the Supertrend line at entry, about 3 × ATR away
- Trailing stop: the Supertrend line, moved at each bar close (only in the trade's favour)
- No fixed target. A flip the other way closes the trade at market.`,
  entry(c) {
    const i = c.length - 1;
    const st = supertrend(c, ST_P.factor, ST_P.atrPeriod);
    const d = dmi(c, ST_P.adx);
    if (st.dir[i - 1] == null || st.dir[i] == null || d.adx[i] == null) return null;
    if (st.dir[i] === st.dir[i - 1]) return null;
    const side: Side = st.dir[i] === 1 ? "long" : "short";
    const close = c[i].close;
    const ind = { close: px(close), supertrend: px(st.line[i]!), adx14: r(d.adx[i]!), plusDI: r(d.plusDI[i]!), minusDI: r(d.minusDI[i]!) };
    if (d.adx[i]! < ST_P.minAdx) return { skip: `Supertrend flipped ${side === "long" ? "up" : "down"}, but ADX ${r(d.adx[i]!)} < ${ST_P.minAdx}: a choppy market.` };
    return {
      side,
      stop: st.line[i]!,
      takeProfit: null,
      reason: `${dirWord(side)}: Supertrend(10, 3) flipped ${side === "long" ? "up (close above the upper band)" : "down (close below the lower band)"} with ADX ${r(d.adx[i]!)} confirming a trend. The stop is the Supertrend line at ${px(st.line[i]!)} and it will trail.`,
      indicators: ind,
    };
  },
  manage(c, tr) {
    const i = c.length - 1;
    const st = supertrend(c, ST_P.factor, ST_P.atrPeriod);
    if (st.dir[i] == null) return {};
    const flippedAgainst = (tr.side === "long" && st.dir[i] === -1) || (tr.side === "short" && st.dir[i] === 1);
    if (flippedAgainst) return { exit: { reason: "signal", note: `Supertrend flipped ${tr.side === "long" ? "down" : "up"} at the bar close: the trend is over.` } };
    return { stop: st.line[i]!, stopNote: `trail to the Supertrend line ${px(st.line[i]!)}` };
  },
};

// ───────────────────────── "+ News" twins ─────────────────────────

/**
 * The strategies that get a news twin: same trigger, stops and exits, plus the news gate
 * (news.ts). Chosen from a 365-day backtest of all 30 setups: MACD+ADX and Donchian have the
 * most profitable timeframes, and Supertrend 1d has the best profit factor. A twin is a new
 * track record next to its original, so the two can be compared head to head.
 */
export const NEWS_TWINS = ["macd_adx", "donchian", "supertrend"];

function withNews(base: StrategyDef): StrategyDef {
  return {
    ...base,
    key: `${base.key}_news`,
    name: `${base.name} + News`,
    baseKey: base.key,
    newsAware: true,
    summary: `${base.summary} Also waits out fresh high-impact crypto news and does not trade against one-sided news.`,
    rules: `${base.rules}

**News filter** (this variant only; everything above is unchanged)
- Headlines from CoinDesk, Cointelegraph and Decrypt are scored (bullish/bearish keywords, fading with a 6-hour half-life) for the coin, plus half of the market-wide news. The Fear & Greed index is recorded too.
- *Wait out events:* no entry in either direction while the event risk is ≥ 0.55. A fresh hack, exploit, ban, lawsuit, depeg, delisting or trading halt keeps it above that for about two hours.
- *Not against the news:* no long when the coin's news sentiment is ≤ −0.35, no short when it is ≥ +0.35.
- If the news feed is down or older than 45 minutes, the bot trades on the indicators alone and says so in the journal.
- *Forward test only:* there is no news history to backtest, so this variant is judged live, next to \`${base.key}\`.`,
  };
}

export const STRATEGIES: StrategyDef[] = [
  emaTrend,
  bbRsi,
  donchian,
  macdAdx,
  supertrendStrat,
  ...[emaTrend, bbRsi, donchian, macdAdx, supertrendStrat].filter((s) => NEWS_TWINS.includes(s.key)).map(withNews),
];
export const STRATEGY_BY_KEY: Record<string, StrategyDef> = Object.fromEntries(STRATEGIES.map((s) => [s.key, s]));

