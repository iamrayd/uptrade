# Order Block (`order_block` v1)

> Generated from `supabase/functions/_shared/bot/strategies.ts`. Don't edit by hand; run `npm run docs:strategies`.

First retest of the last opposite candle before a break of structure. Stop beyond the block, 2R target.

**Timeframes:** 15m, 1h, 4h. Each timeframe is its own $100 account trading BTC, ETH and SOL, at most one position per coin.

**Idea.** The last down candle before a rally that breaks a swing high is where the buying started (ICT's order block). When price comes back to it for the first time, the same buyers tend to defend it.

**Break of structure.** A close above a confirmed swing high (a high with 3 lower highs on each side), or below a confirmed swing low.

**The block.** The last candle against the move within 10 bars before the breaking bar. The move from the block's far edge to the breaking close must be at least 1.5 × ATR(14). The zone is the block candle's full range.

**Long entry** (on the last closed bar)
- A bullish block formed within the last 40 bars and no bar has traded into it since
- This bar trades into the block and closes as a green bar above the block's middle

**Short entry** is the mirror image.

**Stop.** Below the block and below the entry bar's low, minus 0.25 × ATR.

**Risk**
- Target: 2R (2 × the stop distance)
- No early exit: the trade ends at its stop or its target

## Parameters

| Name | Value |
|---|---|
| atr | 14 |
| targetR | 2 |
| stopBufAtr | 0.25 |
| trend | 0 |
| swing | 3 |
| lookback | 10 |
| minMoveAtr | 1.5 |
| maxAge | 40 |
| window | 200 |

Warm-up: 300 closed bars before the first signal.

## Shared rules (all strategies)

See [README.md](README.md#risk-management-shared-by-every-strategy).
