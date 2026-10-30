# Supertrend Flip + News (`supertrend_news` v1)

> Generated from `supabase/functions/_shared/bot/strategies.ts`. Don't edit by hand; run `npm run docs:strategies`.

Enter when Supertrend(10, 3) flips, if ADX ≥ 20. The Supertrend line is the trailing stop. Also waits out fresh high-impact crypto news and does not trade against one-sided news.

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

**News filter** (this variant only; everything above is unchanged)
- Headlines from CoinDesk, Cointelegraph and Decrypt are scored (bullish/bearish keywords, fading with a 6-hour half-life) for the coin, plus half of the market-wide news. The Fear & Greed index is recorded too.
- *Wait out events:* no entry in either direction while the event risk is ≥ 0.55. A fresh hack, exploit, ban, lawsuit, depeg, delisting or trading halt keeps it above that for about two hours.
- *Not against the news:* no long when the coin's news sentiment is ≤ −0.35, no short when it is ≥ +0.35.
- If the news feed is down or older than 45 minutes, the bot trades on the indicators alone and says so in the journal.
- *Forward test only:* there is no news history to backtest, so this variant is judged live, next to `supertrend`.

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
