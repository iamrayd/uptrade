# Setting up the strategy bots (one time, about 10 minutes)

The bots run inside your existing Supabase project, on the free tier: a cron job calls an edge function every minute, about 43k calls a month against a 500k free quota. They keep trading when the app is closed and your computer is off.

## 1. Database

In **Supabase → SQL Editor**, run [`supabase/schema.sql`](../../supabase/schema.sql) again (it's safe to re-run), then run [`supabase/bot.sql`](../../supabase/bot.sql).

## 2. Edge function

From the repo folder on your computer (you'll need Node and a Supabase access token from https://supabase.com/dashboard/account/tokens):

```bash
npx supabase login
npx supabase link --project-ref <PROJECT_REF>          # the xxxx in https://xxxx.supabase.co
npx supabase secrets set BOT_CRON_SECRET=<a long random string>
npx supabase functions deploy bot-tick --no-verify-jwt
```

`--no-verify-jwt` is needed because pg_cron calls the function without a user login. The function rejects any call without the `x-bot-secret` header, so nobody else can trigger it.

To generate a secret, run `openssl rand -hex 32` or use any password generator.

## 3. Schedule it

Open [`supabase/bot_cron.sql`](../../supabase/bot_cron.sql) and replace `<PROJECT_REF>` and `<BOT_CRON_SECRET>` (the same secret as step 2). Then run it in the SQL Editor. This enables `pg_cron` and `pg_net` if they're off.

## 4. Start

Open UpTrade → **Bots** → **Start bots**. Within a minute the accounts appear (one per strategy and timeframe, 48 with the news twins), and the status pill turns green (**Running**).

## 5. AI analysis and learning (optional, recommended)

Deploy `bot-analyze` and re-run `bot_cron.sql`. This reviews every trade, ranks the setups, writes hourly to monthly reports and lets the bots learn from their losers. See [ANALYSIS.md](ANALYSIS.md).

## 6. Crypto news (optional, for the "+ News" bots)

Deploy `bot-news` and re-run `bot_cron.sql`. It reads public RSS headlines and the Fear & Greed index every 10 minutes; no key is needed. Without it, the "+ News" bots trade on the indicators alone. See [NEWS.md](NEWS.md).

## Upgrading an existing install

After pulling this version, do all of these, in this order:

1. Re-run [`supabase/bot.sql`](../../supabase/bot.sql) in the SQL Editor (safe to re-run; it only adds columns and a table).
2. Redeploy all three functions:
   ```bash
   npx supabase functions deploy bot-tick --no-verify-jwt
   npx supabase functions deploy bot-analyze --no-verify-jwt
   npx supabase functions deploy bot-news --no-verify-jwt
   ```
3. Re-run [`supabase/bot_cron.sql`](../../supabase/bot_cron.sql) with your project ref and secret (it adds the news job).

Don't delete the old trades: they are what the bots learn from. The next `bot-tick` run creates the accounts for the new "+ News" strategies. Existing lessons keep working; any that were waiting only because the old limit was 3 per setup go live if they still hold on today's data.

## Checking it's healthy

- The Bots page shows **Running** with a green dot when the last run was under 5 minutes ago. Amber means the last run hit an error, which is shown on the page. Red means it hasn't run.
- In the SQL Editor:
  ```sql
  select * from bot_runtime;                                              -- last run, last error, run count
  select status_code, content from net._http_response order by created desc limit 5;  -- the function's replies
  ```

**Market data region.** The function fetches candles from `data-api.binance.vision`, and falls back to `api.binance.com`. If your Supabase project's region can't reach either, every run reports `Binance unreachable` on the Bots page. Tell me and I'll add another data source.

## Pause, resume, reset

- **Pause new entries:** the button on the Bots page. Open trades are still managed until they exit.
- **Stop everything:** `select cron.unschedule('uptrade-bot-tick');`
- **Start the test over** (deletes every bot trade):
  ```sql
  delete from bot_accounts; delete from bot_cursors; delete from bot_events;
  ```
  The next run recreates the accounts with $100 each.

## Backtest

The last results, before and after the entry gate, are in [docs/backtests](../backtests/) and explained in [EVIDENCE.md](EVIDENCE.md).

On a computer that can reach Binance:

```bash
npm install
npm run backtest              # the last 365 days; or: npm run backtest -- --days 180
```

This writes `docs/backtests/latest.md` with return, win rate, profit factor, average R, max drawdown and monthly consistency for all 30 setups (the news twins are skipped: there is no news history). Add `--gate 65 --discipline` to trade the way the live bots do now (confluence gate, cooldown after losses, smaller risk while down); `npm run backtest` alone trades every signal, as before. `node scripts/gate-sweep.ts` compares thresholds on an older and a newer half of the year.
