# Bollinger + RSI Reversion (`bb_rsi` v1)

> Generated from `supabase/functions/_shared/bot/strategies.ts`. Don't edit by hand; run `npm run docs:strategies`.

Fade a close outside the 2σ band at an RSI extreme once price closes back inside. Target the middle band.

**Timeframes:** 5m, 15m, 30m, 1h, 4h, 1d. Each timeframe is its own $100 account trading BTC, ETH and SOL, at most one position per coin.

**Idea.** After an overstretched move, price tends to snap back toward its 20-bar mean.

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
- Time stop: close at market after 24 bars if neither stop nor target was hit

## Parameters

| Name | Value |
|---|---|
| bbPeriod | 20 |
| bbMult | 2 |
| rsi | 14 |
| rsiLow | 30 |
| rsiHigh | 70 |
| atr | 14 |
| adx | 14 |
| maxAdx | 35 |
| minRewardRisk | 1 |
| maxBars | 24 |

Warm-up: 200 closed bars before the first signal.

## Shared rules (all strategies)

See [README.md](README.md#risk-management-shared-by-every-strategy).
