# MACD Momentum + ADX + News (`macd_adx_news` v1)

> Generated from `supabase/functions/_shared/bot/strategies.ts`. Don't edit by hand; run `npm run docs:strategies`.

MACD/signal cross when ADX > 25 and the DMI agrees. 1.5×ATR stop, 2R target. Also waits out fresh high-impact crypto news and does not trade against one-sided news.

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

**News filter** (this variant only; everything above is unchanged)
- Headlines from CoinDesk, Cointelegraph and Decrypt are scored (bullish/bearish keywords, fading with a 6-hour half-life) for the coin, plus half of the market-wide news. The Fear & Greed index is recorded too.
- *Wait out events:* no entry in either direction while the event risk is ≥ 0.55. A fresh hack, exploit, ban, lawsuit, depeg, delisting or trading halt keeps it above that for about two hours.
- *Not against the news:* no long when the coin's news sentiment is ≤ −0.35, no short when it is ≥ +0.35.
- If the news feed is down or older than 45 minutes, the bot trades on the indicators alone and says so in the journal.
- *Forward test only:* there is no news history to backtest, so this variant is judged live, next to `macd_adx`.

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
