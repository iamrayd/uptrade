# EMA Trend Cross (`ema_trend` v1)

> Generated from `supabase/functions/_shared/bot/strategies.ts`. Don't edit by hand; run `npm run docs:strategies`.

9/21 EMA crossover, only in the direction of the 200 EMA. 1.5×ATR stop, 2R target.

**Timeframes:** 5m, 15m, 30m, 1h, 4h, 1d. Each timeframe is its own $100 account trading BTC, ETH and SOL, at most one position per coin.

**Idea.** Ride short-term momentum only when it agrees with the long-term trend.

**Long entry** (all on the last closed bar)
- EMA 9 crosses above EMA 21
- Close is above EMA 200 (long-term uptrend)

**Short entry** is the mirror image: EMA 9 crosses below EMA 21 with the close below EMA 200.

**Risk**
- Stop: 1.5 × ATR(14) from the entry price
- Target: 2R (twice the stop distance)
- Early exit: the opposite EMA 9/21 cross closes the trade at market

## Parameters

| Name | Value |
|---|---|
| fast | 9 |
| slow | 21 |
| trend | 200 |
| atr | 14 |
| stopAtr | 1.5 |
| targetR | 2 |

Warm-up: 400 closed bars before the first signal.

## Shared rules (all strategies)

See [README.md](README.md#risk-management-shared-by-every-strategy).
