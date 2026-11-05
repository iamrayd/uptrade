# MACD Momentum + ADX v2 (`macd_adx_v2` v2)

> Generated from `supabase/functions/_shared/bot/strategies.ts`. Don't edit by hand; run `npm run docs:strategies`.

MACD/signal cross when ADX > 25 and the DMI agrees. 1.5×ATR stop, then a 3×ATR chandelier trail. No fixed target, no exit on the opposite cross.

**Timeframes:** 5m, 15m, 30m, 1h, 4h, 1d. Each timeframe is its own $100 account trading BTC, ETH and SOL, at most one position per coin.

**Idea.** The same entry as `macd_adx`, with the exit changed: let the trend run and leave on a trailing stop, not on the opposite cross.

**Long entry**
- MACD (12, 26) crosses above its 9-period signal line
- ADX(14) ≥ 25 (trending market)
- +DI > −DI (the trend is up)

**Short entry** is the mirror image: MACD crosses below the signal line, ADX ≥ 25, and −DI > +DI.

**Risk**
- Initial stop: 1.5 × ATR(14)
- Trailing stop: the highest high since entry minus 3 × ATR(14) for a long (the lowest low plus 3 × ATR for a short), moved only in the trade's favour at each bar close
- *Modification (v2):* no fixed 2R target and no exit on the opposite MACD cross. On a year of history with slippage, trades closed by the opposite cross averaged −0.37R, trades closed by a trailing stop +0.34R.

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
| trailAtr | 3 |

Warm-up: 300 closed bars before the first signal.

## Shared rules (all strategies)

See [README.md](README.md#risk-management-shared-by-every-strategy).
