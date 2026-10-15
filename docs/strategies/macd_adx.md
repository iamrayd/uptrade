# MACD Momentum + ADX (`macd_adx` v1)

> Generated from `supabase/functions/_shared/bot/strategies.ts`. Don't edit by hand; run `npm run docs:strategies`.

MACD/signal cross when ADX > 25 and the DMI agrees. 1.5×ATR stop, 2R target.

**Timeframes:** 5m, 15m, 30m, 1h, 4h, 1d. Each timeframe is its own $100 account trading BTC, ETH and SOL, at most one position per coin.

**Idea.** Trade MACD momentum shifts only when a real trend is present.

**Long entry**
- MACD (12, 26) crosses above its 9-period signal line
- ADX(14) ≥ 25 (trending market)
- +DI > −DI (the trend is up)

**Short entry** is the mirror image: MACD crosses below the signal line, ADX ≥ 25, and −DI > +DI.

**Risk**
- Stop: 1.5 × ATR(14)
- Target: 2R
- Early exit: the opposite MACD/signal cross closes the trade at market

## Parameters

| Name | Value |
|---|---|
| fast | 12 |
| slow | 26 |
| signal | 9 |
| adx | 14 |
| minAdx | 25 |
| atr | 14 |
| stopAtr | 1.5 |
| targetR | 2 |

Warm-up: 300 closed bars before the first signal.

## Shared rules (all strategies)

See [README.md](README.md#risk-management-shared-by-every-strategy).
