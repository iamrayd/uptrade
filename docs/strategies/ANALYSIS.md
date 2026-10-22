# AI analysis and learning

Once an hour, the `bot-analyze` edge function studies every bot trade. It does four things:

1. **Reviews each closed trade.** It works out what went wrong and why, and how to fix it.
2. **Ranks the 30 setups** (strategy × timeframe) by how usable they'd be with real money.
3. **Learns from the losing trades.** It finds entry conditions the losers share and turns them into **lessons**. The bots use active lessons on their very next entry.
4. **Writes reports** for the last hour, day, week and month. With an Anthropic API key, Claude writes the analysis and coaching. Without one, a built-in template does.

You'll find all of it under **Bots → AI analysis**. Each trade's own page shows its review.

## 1. Trade reviews

Each closed trade gets a category, an explanation, a fix, and warnings about the entry context:

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

The warnings come from the entry's own indicator readings. Examples: a stop inside 1 ATR, ADX under 20 on a trend entry, RSI over 70 on a long, an entry against the EMA 200, below-average volume, a weekend entry.

## 2. Rankings: what could be traded for real

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

## 3. Learning: how the bots improve

A lesson is an entry filter: *skip `<strategy>` [`<timeframe>`] entries when `<feature>` `<op>` `<value>`*. The features are scale-free, so one rule works on every coin:

| Feature | What it is |
| --- | --- |
| stopPct, stopAtr | Stop distance, as % of price and in ATRs |
| atrPct | Volatility (ATR as % of price) |
| adx14, diEdge | Trend strength, and the DMI lead in the trade's direction |
| rsi, rsiPrev | RSI at the signal and on the bar before |
| volumeX | Volume vs its 20-bar average |
| trendDistPct | Distance from EMA 200, in the trade's direction |
| bandWidthPct | Bollinger band width |
| side, symbol, session, weekend | Direction, coin, UTC session (asia / europe / us / late), weekend |

**How a lesson is learned.** Every run does this for each setup with 30+ closed trades, and also for each strategy across all its timeframes:

1. Leave out trades that an existing lesson would already have skipped. Each new lesson then targets the losers the current ones still let through.
2. Split the trades in time order. The oldest 70% are used to learn; the newest 30% are held back to check.
3. Try every candidate filter: quantile thresholds of each number feature, and each value of each category feature. Measure them on the older trades.
4. Keep a filter only if all of these hold on the older trades:
   - It skips 10–50% of entries.
   - The trades it skips average −0.25R or worse.
   - It lifts the remaining trades by at least 0.1R.
   - It saves at least 2R in total.
   - It is **statistically clear**: a Welch t ≥ 3, roughly a multiple-comparison bar for the dozens of filters tried.
5. Then it must also hold on the **newer 30%**, which it never saw:
   - It skips at least 4 of those trades, and they lost money.
   - The remaining trades do better than the overall average.
   - The t-stat is ≥ 1.
6. The best filter that passes becomes a lesson. That's at most one per setup per run.

R here always includes the slippage stress.

**How strict this is.** On simulated data:
- In pure-noise setups, about 0–5% produce a lesson.
- A real bad context (a third of entries winning 10% of the time vs 42% for the rest) is found about 60% of the time at 120 trades, and about 95% at 200 trades.

The learning is careful on purpose. It needs real evidence before it changes how the bots trade.

**Switching on.** With **auto-learn** on (the default), a confirmed lesson is active on the next bot run. Each account can have at most 3 active lessons, so a bot can't filter itself out of trading. Lessons over that limit, and all new lessons when auto-learn is off, wait on the analysis page for you to switch them on. You can pause or reject any lesson there.

**Keeping score.** When an active lesson blocks a signal, the engine logs that signal in `bot_filtered_signals`. The analyzer later replays it on the strategy's own bars, with the strategy's own stops, targets and exits, and records what it would have made. Once a lesson has blocked 8+ signals that would have averaged **+0.1R or better**, it is **retired** automatically: it was costing money. The page shows how much R each lesson has saved.

**Claude's ideas.** The AI write-up can suggest up to 3 filters. They go through exactly the same checks as mined ones, and become lessons only if the data backs them up. They're marked "AI idea".

## 4. Reports

| Report | When | Breaks down by |
| --- | --- | --- |
| Hourly | Every hour | 10-minute slots |
| Daily | Just after 00:00 UTC | Hour |
| Weekly | Just after Monday 00:00 UTC | Day |
| Monthly | Just after the 1st, 00:00 UTC | Week |

Each report contains:
- The period's results, overall and by setup.
- The three rankings and every setup's stats and verdict.
- Loss reasons for the period and all time, and the most common one per setup.
- The worst losing trades of the period, with their reviews.
- When the bots do well, by session, weekday and hour.
- Lessons: new, active, waiting and retired.
- The narrative: headline, summary, ranking notes, why entries failed, how to improve, and caveats.

Claude (`claude-opus-5-5`) gets only these computed numbers, plus each strategy's summary and parameters. It is told to quote the numbers it relies on and to call small samples unproven.

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

**Limits.** Each run writes at most one AI report, to stay inside the edge function's time limit. A second report due at the same time (say, the weekly one on a Monday) is written the next hour. Each run also makes at most 60 Binance candle requests, so a large backlog of reviews is worked through over a few runs.

**Checking it.** `select kind, period_start, ai_model, ai_error from bot_reports order by created_at desc limit 5;`
