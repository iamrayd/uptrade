# Bollinger + RSI Reversion (`bb_rsi_reversion` v1)

> Generated from `supabase/functions/_shared/bot/strategies.ts`. Don't edit by hand; run `npm run docs:strategies`.

Fade a close outside the 2σ band at an RSI extreme once price closes back inside. Target the middle band.

**Timeframes:** 15m, 1h, 4h. Each timeframe is its own $100 account trading BTC, ETH and SOL, at most one position per coin.

**Idea.** After an overstretched move, price tends to snap back toward its 20-bar average.

**Long entry**
- The previous bar closed below the lower Bollinger Band (20, 2) with RSI(14) below 30
- The last bar closed back inside the band as a green bar
- ADX(14) is at most 35 (a strong trend is not faded)
- The middle band is at least 1× the stop distance away

**Short entry** is the mirror image: a close above the upper band with RSI above 70, then a red close back inside.

**Risk**
- Stop: beyond the extreme of the last 3 bars, plus 0.25 × ATR(14)
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
