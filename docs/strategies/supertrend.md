# Supertrend Flip (`supertrend` v1)

> Generated from `supabase/functions/_shared/bot/strategies.ts`. Don't edit by hand; run `npm run docs:strategies`.

Enter when Supertrend(10, 3) flips, if ADX ≥ 20. The Supertrend line is the trailing stop.

**Timeframes:** 5m, 15m, 30m, 1h, 4h, 1d. Each timeframe is its own $100 account trading BTC, ETH and SOL, at most one position per coin.

**Idea.** Supertrend is an ATR-based trailing line. A flip marks a change of trend, and the line then trails price.

**Long entry**
- Supertrend (ATR 10, factor 3) flips from down to up on the last closed bar
- *Modification:* ADX(14) ≥ 20. Supertrend whipsaws in flat markets, and this filter skips the worst of them.

**Short entry** is the mirror image (a flip from up to down).

**Risk**
- Stop: the Supertrend line at entry, about 3 × ATR away
- Trailing stop: the Supertrend line, moved at each bar close (only in the trade's favour)
- No fixed target. A flip the other way closes the trade at market.

## Parameters

| Name | Value |
|---|---|
| atrPeriod | 10 |
| factor | 3 |
| adx | 14 |
| minAdx | 20 |

Warm-up: 200 closed bars before the first signal.

## Shared rules (all strategies)

See [README.md](README.md#risk-management-shared-by-every-strategy).
