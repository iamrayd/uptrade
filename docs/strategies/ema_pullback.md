# EMA Pullback (`ema_pullback` v1)

> Generated from `supabase/functions/_shared/bot/strategies.ts`. Don't edit by hand; run `npm run docs:strategies`.

In a 20/50 EMA trend, the first dip to the 20 EMA that closes back above it. 2R target.

**Timeframes:** 15m, 1h, 4h. Each timeframe is its own $100 account trading BTC, ETH and SOL, at most one position per coin.

**Idea.** In a trend, price keeps returning to its short moving average and bouncing. Buy the dip, not the breakout.

**Long entry** (on the last closed bar)
- EMA 20 is above EMA 50, and EMA 50 is higher than 5 bars ago
- The previous bar stayed above EMA 20
- This bar's low touches EMA 20 and it closes above it as a green bar

**Short entry** is the mirror image.

**Stop.** 0.5 × ATR(14) beyond the entry bar's wick.

**Risk**
- Target: 2R (2 × the stop distance)
- No early exit: the trade ends at its stop or its target

## Parameters

| Name | Value |
|---|---|
| atr | 14 |
| targetR | 2 |
| stopBufAtr | 0.25 |
| fast | 20 |
| slow | 50 |
| slope | 5 |
| stopAtr | 0.5 |

Warm-up: 200 closed bars before the first signal.

## Shared rules (all strategies)

See [README.md](README.md#risk-management-shared-by-every-strategy).
