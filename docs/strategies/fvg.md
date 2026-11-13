# Fair Value Gap (`fvg` v1)

> Generated from `supabase/functions/_shared/bot/strategies.ts`. Don't edit by hand; run `npm run docs:strategies`.

First retrace into a displacement gap, in the direction of the 200 EMA. Stop beyond the gap, 2R target.

**Timeframes:** 15m, 1h, 4h. Each timeframe is its own $100 account trading BTC, ETH and SOL, at most one position per coin.

**Idea.** A fast move leaves a three-candle gap where price traded in one direction only (ICT's fair value gap). Price often returns to that gap once, finds the orders left behind and continues.

**The gap.** Three candles where the low of the third is above the high of the first (bullish), or the high of the third is below the low of the first (bearish). The middle candle's body must be at least 1 × ATR(14): a displacement, not drift.

**Long entry** (on the last closed bar)
- A bullish gap formed within the last 30 bars and no bar has traded into it since
- This bar trades into the gap and closes as a green bar above the gap's middle
- The close is above EMA 200

**Short entry** is the mirror image: a bearish gap, a red bar closing below its middle, the close below EMA 200.

**Stop.** Below the gap and below the entry bar's low, minus 0.25 × ATR.

**Risk**
- Target: 2R (2 × the stop distance)
- No early exit: the trade ends at its stop or its target

## Parameters

| Name | Value |
|---|---|
| atr | 14 |
| targetR | 2 |
| stopBufAtr | 0.25 |
| trend | 200 |
| minBodyAtr | 1 |
| maxAge | 30 |

Warm-up: 300 closed bars before the first signal.

## Shared rules (all strategies)

See [README.md](README.md#risk-management-shared-by-every-strategy).
