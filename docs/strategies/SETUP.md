# Setting up the strategy bots (one time, about 10 minutes)

The bots run inside your existing Supabase project, on the free tier: a cron job calls an edge function every minute, about 43k calls a month against a 500k free quota. They keep trading when the app is closed and your computer is off.

Already running an older version? Go to [Upgrading to strategy v3](#upgrading-to-strategy-v3).

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

Open UpTrade → **Bots** → **Start bots**. Within a minute the 15 accounts appear (five rule sets × 15m, 1h, 4h), and the status pill turns green (**Running**).

## 5. AI analysis (optional, recommended)

Deploy `bot-analyze` and re-run `bot_cron.sql`. This reviews every trade, ranks the rule sets and writes hourly to monthly reports. It only measures; it never changes what the bots trade. See [ANALYSIS.md](ANALYSIS.md).

## Upgrading to strategy v3

v3 replaces every earlier strategy and removes the gates, lessons, probation, news and the aggressive accounts ([V3.md](V3.md)). Do these in this order:

1. **Pause the runner** so nothing trades halfway through. In the SQL Editor:
   ```sql
   select cron.unschedule(jobid) from cron.job where jobname like 'uptrade-bot-%';
   ```
2. **Run [`supabase/bot.sql`](../../supabase/bot.sql).** It replaces the engine functions and drops the ones nothing calls any more.
3. **Run [`supabase/bot_reset.sql`](../../supabase/bot_reset.sql).** Read its header first: it **permanently deletes** every bot account, every bot trade, the event log, all reports and the old learning tables. Your manual trading and your bot settings are not touched. If you want to keep the old trades, export `bot_trades` from the Table Editor before this step.
4. **Deploy the functions:**
   ```bash
   npx supabase functions deploy bot-tick --no-verify-jwt
   npx supabase functions deploy bot-analyze --no-verify-jwt
   npx supabase functions deploy bot-chat          # only if you use the chatbot
   npx supabase functions delete bot-news          # no longer used
   ```
5. **Run [`supabase/bot_cron.sql`](../../supabase/bot_cron.sql)** with your project ref and secret. It schedules tick, analyze and prune again, and removes the old news job.
6. **Deploy the web app** (push to `main`).

Within a minute of step 5 the Bots page shows 15 fresh $100 accounts. The first trades follow the next bar closes: 15m within the quarter hour.

Skipping the reset is possible but untidy: the engine ignores accounts of rule sets it no longer has, so the old ones would sit on the dashboard frozen, with any open trade of theirs still managed by nobody.

## Checking it's healthy

- The Bots page shows **Running** with a green dot when the last run was under 5 minutes ago. Amber means the last run hit an error, which is shown on the page. Red means it hasn't run.
- In the SQL Editor:
  ```sql
  select * from bot_runtime;                                              -- last run, last error, run count
  select status_code, content from net._http_response order by created desc limit 5;  -- the function's replies
  ```
  `last_summary` in `bot_runtime` shows the last run: `signals` is how many signals the rule sets gave, `opened` how many became trades, and `skippedByReason` why any did not.
- Signals that were not opened, and why:
  ```sql
  select created_at, timeframe, symbol, message from bot_events where kind = 'skipped' order by created_at desc limit 20;
  ```

**Market data region.** The function fetches candles from `data-api.binance.vision`, and falls back to `api.binance.com`. If your Supabase project's region can't reach either, every run reports `Binance unreachable` on the Bots page.

## Pause, resume, reset

- **Pause new entries:** the button on the Bots page. Open trades are still managed until they exit.
- **Stop everything:** `select cron.unschedule('uptrade-bot-tick');`
- **Start the test over** (deletes every bot trade): run [`supabase/bot_reset.sql`](../../supabase/bot_reset.sql). The next run recreates the accounts with $100 each.

## Backtest

On a computer that can reach Binance:

```bash
npm install
npm run backtest                    # the five live rule sets, last 365 days, fees only
npm run backtest -- --slip 0.05     # also 0.05% slippage on every taker fill (closer to a real account)
npm run backtest -- --all           # all ten candidate rule sets
npm run backtest -- --days 180
```

This writes `docs/backtests/latest.md`. It trades every signal, as the live bots do. Without `--slip` it matches what the paper accounts charge; with it, what a real account would pay.

The run the five were chosen on uses a fixed year and works offline once the candles are cached:

```bash
node --experimental-strip-types scripts/experiments/v3-select.ts
```
