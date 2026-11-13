# Donchian Breakout (`donchian_breakout` v1)

> Generated from `supabase/functions/_shared/bot/strategies.ts`. Don't edit by hand; run `npm run docs:strategies`.

Turtle-style 20-bar breakout confirmed by volume. 2×ATR stop, trails the 10-bar channel. No fixed target.

**Timeframes:** 15m, 1h, 4h. Each timeframe is its own $100 account trading BTC, ETH and SOL, at most one position per coin.

**Idea.** New 20-bar highs and lows tend to start trends. Cut losers fast and let winners run.

**Long entry** (on the last closed bar)
- The close breaks above the highest high of the previous 20 bars
- Volume on the breakout bar is at least 1.5× its 20-bar average

**Short entry** is the mirror image (a close below the lowest low of the previous 20 bars).

**Risk**
- Initial stop: 2 × ATR(14)
- Trailing stop: the opposite 10-bar channel, moved only in the trade's favour at each bar close
- No fixed target. The trailing stop takes the exit.

## Parameters

| Name | Value |
|---|---|
| entryLen | 20 |
| exitLen | 10 |
| volLen | 20 |
| volMult | 1.5 |
| atr | 14 |
| stopAtr | 2 |

Warm-up: 100 closed bars before the first signal.

## Shared rules (all strategies)

See [README.md](README.md#risk-management-shared-by-every-strategy).
