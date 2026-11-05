# EMA Trend Cross v2 (`ema_trend_v2` v2)

> Generated from `supabase/functions/_shared/bot/strategies.ts`. Don't edit by hand; run `npm run docs:strategies`.

9/21 EMA crossover in the direction of the 200 EMA. 1.5×ATR stop, then a 3×ATR chandelier trail. No fixed target, no exit on the opposite cross.

**Timeframes:** 5m, 15m, 30m, 1h, 4h, 1d. Each timeframe is its own $100 account trading BTC, ETH and SOL, at most one position per coin.

**Idea.** The same entry as `ema_trend`, with the exit changed: let the trend run and leave on a trailing stop, not on the opposite cross.

**Long entry** (all on the last closed bar)
- EMA 9 crosses above EMA 21
- Close is above EMA 200 (long-term uptrend)

**Short entry** is the mirror image: EMA 9 crosses below EMA 21 with the close below EMA 200.

**Risk**
- Initial stop: 1.5 × ATR(14) from the entry price
- Trailing stop: the highest high since entry minus 3 × ATR(14) for a long (the lowest low plus 3 × ATR for a short), moved only in the trade's favour at each bar close
- *Modification (v2):* no fixed 2R target and no exit on the opposite EMA cross. On a year of history with slippage, trades closed by the opposite cross averaged −0.37R, trades closed by a trailing stop +0.34R.

## Parameters

| Name | Value |
|---|---|
| fast | 9 |
| slow | 21 |
| trend | 200 |
| atr | 14 |
| stopAtr | 1.5 |
| trailAtr | 3 |

Warm-up: 400 closed bars before the first signal.

## Shared rules (all strategies)

See [README.md](README.md#risk-management-shared-by-every-strategy).
