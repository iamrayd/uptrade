# AI analysis

Once an hour, the `bot-analyze` edge function studies every bot trade. It does three things:

1. **Reviews each closed trade.** It works out what went wrong and why, and how to fix it.
2. **Ranks every rule set and every setup** (rule set × timeframe) by how usable they'd be with real money.
3. **Writes reports** for the last hour, day, week and month. With an Anthropic API key, Claude writes the analysis and coaching. Without one, a built-in template does.

**It only measures.** The analyzer never blocks, filters or resizes a trade: the bots trade every signal of their five rule sets ([V3.md](V3.md)). You read the reports and decide which rule sets to keep.

You'll find all of it under **Bots → AI analysis**. Each trade's own page shows its review.

## 1. Trade reviews

Each closed trade gets a category, an explanation and a fix:

| Category | Meaning | Typical fix |
| --- | --- | --- |
| False signal | Price never got +0.3R in favour | A confirmation filter, or skip this context |
| Chopped out | Got +0.3–1R, then reversed to the stop | A trend-strength filter |
| Winner turned loser | Was up ≥ 1R, closed at a loss | Breakeven stop or partial profit at +1R |
| Right idea, stopped out | After the stop, price reached the target (or +1.5R) within 10 bars | Wider stop, or a pullback entry |
| Exited, then it worked | Same, after a signal exit | Confirm exit signals |
| No movement | Time stop | Filter quiet markets |
| Stop gapped / Liquidated | Filled well past the stop | Lower leverage, avoid thin hours |

For the "right idea" check, the analyzer waits until up to 10 more bars (at most 3 days) have closed after a losing exit. It then looks at what price did next.

## 2. Rankings: what could be traded for real

The **Rule sets** table at the top of the page is each rule set over all its timeframes, all time: trades, win rate, average R, profit factor and net. It is the table to drop and keep rule sets from.

Below it, every setup (rule set × timeframe) is scored on its own.

Every setup gets these stats:

- **Avg R (slip):** average R per trade after an extra **0.05% slippage per side**. Paper fills are kinder than a real exchange's.
- **95% low R:** the 95% lower confidence bound of R after slippage. This is the edge you can actually count on.
- **Profit factor, max drawdown, % winning weeks.**
- **Readiness score (0–100).** It weights edge 35, sample size 20, PF 15, consistency 15 and drawdown 15. Below 30 trades, everything except sample size is scaled down, so a short lucky streak can't top the list.

There are three rankings:

- **Best for real trading:** the highest readiness score.
- **Most effective:** the highest 95% low R (setups with 10+ trades).
- **Highest return:** account return so far.

Each setup also gets a **verdict**:

| Verdict | Rule |
| --- | --- |
| Ready for a small live test | 30+ trades, 95% low R > 0 after slippage, PF ≥ 1.3, max DD ≤ 25%, ≥ 50% winning weeks |
| Promising | Profitable after slippage with PF > 1.1, but not proven yet |
| Unproven | No clear edge |
| Needs more trades | Under 10 trades |
| Avoid | Busted, or losing after slippage over 20+ trades |

"Ready for a small live test" means just that: start small. Paper results are not a guarantee.

## 3. Reports

| Report | When | Breaks down by |
| --- | --- | --- |
| Hourly | Every hour | 10-minute slots |
| Daily | Just after 00:00 UTC | Hour |
| Weekly | Just after Monday 00:00 UTC | Day |
| Monthly | Just after the 1st, 00:00 UTC | Week |

Each report contains:
- The period's results, overall and by setup.
- Each rule set over all its timeframes.
- The three rankings and every setup's stats and verdict.
- Loss reasons for the period and all time, and the most common one per setup.
- The worst losing trades of the period, with their reviews.
- When the bots do well, by session, weekday and hour.
- The narrative: headline, summary, ranking notes, why entries failed, how to improve, and caveats.

Claude (`claude-opus-5-5`) gets only these computed numbers, plus each rule set's summary and parameters. It is told to quote the numbers it relies on and to call small samples unproven.

## 4. Ask about the analysis (chatbot)

The **Ask about the analysis** box at the top of **Bots → AI analysis** answers questions in plain English. For example: *"Which setup is closest to being ready for real money?"*, *"Why does Order Block 15m keep losing?"*, *"Which rule set should I drop first?"*

- It runs on **Google Gemini's free tier** through the `bot-chat` edge function. The API key stays on the server, and the function only reads the signed-in user's own reports, recent trades and open trades.
- It answers from the latest hourly, daily, weekly and monthly reports and the last 40 closed trades with their reviews. It's told to quote the numbers it uses and to say when the data can't answer.
- The conversation is kept in your browser, and only the last 12 messages are sent with each question.
- **Free-tier limits:** Google caps free requests per minute and per day, and the caps change over time; see your limits in [AI Studio](https://aistudio.google.com). When they run out, the chat says so; try again a minute later, or the next day. Google may use free-tier prompts, which here are your bots' trade stats, to improve its models.

**Setup:**
1. Get a free API key at https://aistudio.google.com/apikey.
2. Run these from the repo folder:
   ```bash
   npx supabase secrets set GEMINI_API_KEY=...
   npx supabase functions deploy bot-chat      # no --no-verify-jwt: only signed-in users may call it
   ```
3. Optional: the model defaults to `gemini-flash-latest`, Google's alias for its current Flash model. To pin a specific one: `npx supabase secrets set GEMINI_MODEL=<model id>`.

## Setup

Do this after the bots are running (see [SETUP.md](SETUP.md)).

1. **Database.** Re-run [`supabase/bot.sql`](../../supabase/bot.sql) in the SQL Editor. It's safe to re-run.
2. **Function:**
   ```bash
   npx supabase functions deploy bot-analyze --no-verify-jwt
   # Optional, for the AI write-up (https://platform.claude.com):
   npx supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
   # Optional: which reports get the AI write-up (default daily,weekly,monthly):
   npx supabase secrets set AI_REPORT_KINDS=daily,weekly,monthly
   ```
3. **Schedule.** Re-run [`supabase/bot_cron.sql`](../../supabase/bot_cron.sql) with your project ref and secret filled in. It adds the hourly `uptrade-bot-analyze` job.

**Cost.** Without an API key, everything except the written narrative works the same, for free. With a key, it's about 3 Claude calls a week on the defaults: one each day, one each week, one each month. Each is a few cents. Adding `hourly` makes it about 24 calls a day.

**Limits.** Each run writes at most one AI report, to stay inside the edge function's time limit. A second report due at the same time (say, the weekly one on a Monday) is written the next hour. Each run also makes at most 100 Binance candle requests (and stops fetching after 45 seconds), so a large backlog of reviews is worked through over a few runs.

**Checking it.** `select kind, period_start, ai_model, ai_error from bot_reports order by created_at desc limit 5;`
