# Crypto news and the "+ News" bots

Three strategies have a **news twin**: `macd_adx_news`, `donchian_news` and `supertrend_news`. A twin uses exactly the same trigger, stops and exits as its original. The only difference is a news filter in front of the entry, so the two tracks can be compared head to head on the same timeframe.

These three were picked from the 365-day backtest of all 30 setups: MACD + ADX and Donchian have the most profitable timeframes, and Supertrend 1d has the best profit factor. To give another strategy a twin, add its key to `NEWS_TWINS` in `strategies.ts` and deploy; the next run creates its six accounts.

## Where the news comes from

The `bot-news` edge function runs every 10 minutes and reads:

- **Headlines** from the public RSS feeds of CoinDesk, Cointelegraph and Decrypt. No account or API key is needed.
- **The Fear & Greed index** from alternative.me.

Each headline is scored with a keyword list (bullish and bearish words, in three strengths) and tagged with the coin it is about (Bitcoin, Ethereum, Solana) or the whole market (SEC, Fed, ETF, exchanges, …). Headlines fade with a 6-hour half-life and are dropped after 24 hours. The same story from two feeds counts once.

Two numbers come out for each coin:

| Number | Meaning |
| --- | --- |
| **Sentiment** (−1 … +1) | The coin's own news plus half of the market-wide news |
| **Event risk** (0 … 1) | How much a fresh headline looks like a market-moving event: a hack, exploit, ban, lawsuit, depeg, delisting, trading halt. A hawkish Fed or a liquidation cascade counts a little. |

## What the "+ News" bots do with it

1. **Wait out events.** No entry in either direction while the event risk is at least **0.55**. One fresh hack headline stays above that for about two hours.
2. **Do not trade against the news.** No long when sentiment is at or below **−0.35**, no short when it is at or above **+0.35**.
3. **If the feed is down** or its last read is older than 45 minutes, the bot trades on the indicators alone and says so in the trade's journal. It never blocks on missing data.

A signal held back by the news is not lost. It is stored with the reason `news`, replayed later, and used as learning data. After a few weeks, the analysis shows whether the signals the news gate held back would have made or lost money.

## News helps every bot learn

All bots, not only the twins, store the news reading (`newsScore`, `newsRisk`, `fng`) with each trade and skipped signal. Two mistakes are tracked from it: *news was against the trade* and *entered into a news event*. If either one costs the plain bots money, the learner can turn it into a lesson for them too.

## Honest limits

- **There is no news history to backtest.** The twins can only be judged live, forward in time. Give them weeks of trades before concluding anything, and compare each twin with its original on the same timeframe.
- **A keyword list is blunt.** It misses sarcasm, negation ("no hack found") and context. It is cheap, free and predictable, which is why it is the first version. A language model could score headlines better; it would cost money on every read and could not be tested against fixed expectations the way this can.
- **Headlines lag the market** on fast moves. The filter is for avoiding trading into a known event, not for predicting the move.
- Feeds can change address or block a region. The function reports which feeds answered and which failed (`curl` it, or check the cron response), and the bots keep working without it.

## Setup

1. Re-run [`supabase/bot.sql`](../../supabase/bot.sql) in the SQL Editor. It adds the `bot_news` table and is safe to re-run.
2. Deploy the function:
   ```bash
   npx supabase functions deploy bot-news --no-verify-jwt
   ```
3. Re-run [`supabase/bot_cron.sql`](../../supabase/bot_cron.sql) with your project ref and secret filled in. It adds the 10-minute `uptrade-bot-news` job.
4. Check it: `select updated_at, data->'sources', data->'fng', data->'scopes'->'BTC' from bot_news;`

The `bot-tick` function must be redeployed too (`npx supabase functions deploy bot-tick --no-verify-jwt`), because it reads the news.
