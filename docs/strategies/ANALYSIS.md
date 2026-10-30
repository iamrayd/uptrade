# AI analysis and learning

Once an hour, the `bot-analyze` edge function studies every bot trade. It does four things:

1. **Reviews each closed trade.** It works out what went wrong and why, and how to fix it.
2. **Ranks every setup** (strategy × timeframe) by how usable they'd be with real money.
3. **Learns from the losing trades and the signals the bots skipped.** It marks the mistakes behind the losses, finds entry conditions the losers share and turns them into **lessons**. The bots use active lessons on their very next entry, and the report shows whether entries got better afterwards.
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

The bots learn in a loop that runs every hour:

1. **Every entry is judged before it is taken** (the gates below).
2. **Every signal that is *not* taken is kept and replayed**, so it still teaches something.
3. **Every loss is tagged with the mistakes it shows.**
4. **Mistakes that keep costing money become lessons**, which the bots apply on their very next entry.
5. **Lessons are re-checked**, and switched off when they stop helping.

### The gates a signal must pass

The thresholds and weights below were picked from a year of real history; [EVIDENCE.md](EVIDENCE.md) shows the numbers, including what did not work.

A strategy's trigger (an EMA cross, a breakout, …) is only the start. In order:

| Gate | What it does |
| --- | --- |
| **Confluence** | Independent indicators vote on whether the market agrees, and the weighted score must be **65/100 or more** (most checks, not all). The weights come from a year of history, not from taste (see [EVIDENCE.md](EVIDENCE.md)): MACD momentum 3, volume 2, then 1 each for price vs EMA 200, Supertrend, "not a stretched chase" and a sane stop. A fade (Bollinger + RSI) is judged on regime (ADX ≤ 25, weight 2) and on RSI turning back. Checks that showed **no edge** (ADX strength, EMA stack, the trend of the next timeframe up) are still recorded with every trade at weight 0, so the learner keeps testing them. Checks the strategy's own trigger already guarantees are left out, so the score measures *extra* confirmation. A trend entry with price against **both** EMA 200 and Supertrend is refused outright. |
| **Minimum stop** | A stop closer than **0.4%** of price is skipped: fees are a fixed share of price, so on a tight stop they eat a large share of the risk (stops under 0.2% averaged −0.19R). |
| **News** | Only the "+ News" bots. See [NEWS.md](NEWS.md). |
| **Cooldown** | After a loss on a coin, the bot waits 3 bars on that coin. After 3 losses in a row on the account, it waits 6 bars on every coin. |
| **Lessons** | The active lessons below. |
| **Probation** | A setup on probation trades **shadow-only**: every surviving signal is logged and replayed, but no capital is used. New 5m/15m/30m setups start on probation, because the year replay showed they lose money after slippage. The analyzer clears probation once 30+ replayed entries show a profit factor above 1.1 after slippage, and re-enters it when the setup's verdict turns "Avoid". A flip can happen at most once every 7 days. |

The gates run before the lessons, so a lesson is only credited with entries that would otherwise have been traded. Probation runs last, so its replays measure exactly the entries that would really have been traded.

The confluence bar is **per setup**: it starts at the global 65, and every hour the analyzer sweeps 65/70/75/80 on the setup's own entries (trades plus replayed signals). A higher bar is adopted only when it improves the average R in **both** time-halves of the data, keeps 30+ entries, and doesn't skip more than the 60% room rule allows. Capped at 80, floored at 65, and it too can flip at most once every 7 days.

A rejected sizing (stop under the 0.4% minimum, or a position too small to place) is also kept as a shadow signal (reason `min_stop`) and replayed, so the minimum-stop rule keeps being judged on data.

A bot that is deeply down also **trades smaller**: risk per trade is cut to 50% once the account is 30% below its starting balance, to 25% at 60% below, to 50% after 3 losses in a row, and to 50% when its last 6+ trades averaged worse than −0.3R. It goes back to full size when the account recovers. This keeps a struggling bot alive long enough to learn, instead of repeating the same mistake at full size.

**Conviction-weighted sizing** multiplies on top of those cuts: 1.25× risk when the entry's confluence is 80+ **and** the setup is rated at least Promising; 0.75× when confluence is under 70 or the setup is rated Unproven/Avoid. The multiplier is stored with each trade, and the analyzer reverts a setup to flat sizing when 30+ weighted trades did worse than flat sizing would have.

**Exit management is learned too.** Once a trade has been up **+1R** (tracked on 1-minute candles), a per-setup **breakeven rule** can move the stop to the entry plus fee cover, so a "winner turned loser" ends as a scratch instead. The rule is judged on evidence before it is switched on: every replayed shadow signal is simulated **twice** — plain, and with the breakeven rule — and the rule goes live for a setup only when 30+ such pairs show it saved at least 2R with a t-statistic ≥ 2. It is switched off again when its latest 30 pairs stopped helping. Partial exits are not in this version (closes are whole-position).

### Shadow signals: why a bot never stops learning

Every signal that is not traded is stored in `bot_filtered_signals` with the reason: `confluence`, `news`, `cooldown`, `lesson`, `busted`, `probation` or `min_stop`. The hourly analysis replays each one on the strategy's own bars, with the strategy's own stops, targets and exits, and records what it would have made after slippage (plain, and with the breakeven-stop variant). All replays of one coin and timeframe share a single candle request.

These replays are **learning data, like trades**. This is what fixes the old "stuck" behaviour: a bot that trades little, whose signals are mostly filtered, or that is **busted** (a busted bot still sees every signal and replays it) keeps gathering evidence. Before, a lesson that blocked signals also starved the learner of the very data it needed.

### Mistake tags: marking what went wrong

Each entry is checked against 13 named mistakes, from its own indicator readings:

| Mistake | Meaning |
| --- | --- |
| stop inside the noise | Stop closer than 1 ATR |
| weak trend for a trend entry | ADX under 20 on a trend strategy |
| fading a strong trend | ADX over 28 on the reversion strategy |
| chasing a stretched move | RSI over 70 on a long / under 30 on a short |
| against the EMA 200 trend | Trading against EMA 200 (for the fade: more than 5% against) |
| late entry in an extended trend | More than 8% past EMA 200 |
| below-average volume | Volume under its 20-bar average |
| DMI favoured the other side | +DI/−DI pointing the other way |
| weekend entry | Thinner liquidity |
| too few indicators agreed | Confluence under 65 |
| against the higher-timeframe trend | The next timeframe up trends against the entry |
| news was against the trade | Sentiment ≤ −0.25 for this direction |
| entered into a news event | Fresh high-impact news |

A losing trade's review lists its mistakes. The report's **Mistakes that cost the most** shows, for each one, the average R of entries with it vs without it, and the total R it cost.

### How a lesson is learned

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
| confluence, htfAlign | The confluence score, and the next timeframe up (1 with the trade, 0 mixed, −1 against) |
| newsScore, newsRisk, fng | News sentiment in the trade's direction, event risk, Fear & Greed |
| mk_… | Each named mistake above (yes/no) |
| side, symbol, session, weekend | Direction, coin, UTC session (asia / europe / us / late), weekend |

Every run does this for each setup with enough **entries** (its trades plus its replayed signals), and also for each strategy across all its timeframes:

1. Leave out entries that an existing lesson would already have skipped. Each new lesson then targets the losers the current ones still let through.
2. Split the entries in time order. The oldest 70% are used to learn; the newest 30% are held back to check.
3. Try every candidate filter: quantile thresholds of each number feature, each value of each category feature, and each named mistake. Measure them on the older entries.
4. Keep a filter only if all of these hold on the older entries:
   - It skips 10–50% of entries.
   - The entries it skips average −0.25R or worse.
   - It lifts the remaining entries by at least 0.1R.
   - It saves at least 2R in total.
   - It is **statistically clear**: a Welch t ≥ 3, roughly a multiple-comparison bar for the dozens of filters tried.
5. Then it must also hold on the **newer 30%**, which it never saw:
   - It skips at least 4 of those entries, and they lost money.
   - The remaining entries do better than the overall average.
   - The t-stat is ≥ 1.
6. The best filter that passes becomes a lesson. That's at most one per setup per run.

**Named mistakes get a lower bar**, because they are about 13 hypotheses chosen in advance, not dozens of blind thresholds: 20+ entries, skipped entries averaging −0.15R or worse, saving 1.5R, t ≥ 2 on the older entries, and 3+ confirming entries on the newer ones. This is how a recurring mistake is turned into a rule weeks sooner.

R here always includes the slippage stress.

**How strict this is.** On simulated data:
- In pure-noise setups, about 0–5% produce a lesson.
- A real bad context (a third of entries winning 10% of the time vs 42% for the rest) is found about 60% of the time at 120 trades, and about 95% at 200 trades. Replayed signals count toward those numbers, so a filtered bot gets there sooner.

The learning is careful on purpose. It needs real evidence before it changes how the bots trade.

### Switching on, keeping room, and keeping score

- **Switching on.** With **auto-learn** on (the default), a confirmed lesson is active on the next bot run.
- **Room.** A setup can have up to 8 active lessons, and all of them together may skip at most **60%** of its signals, so a bot can't filter itself out of trading. A lesson that doesn't fit is **waiting for room**.
- **Waiting lessons go live by themselves** once there is room *and* they still hold on today's data. A lesson you paused is never switched back on automatically. You can pause or reject any lesson on the analysis page.
- **Keeping score.** When a lesson blocks a signal, the signal is replayed and the lesson's tally is updated. A lesson is **retired** when the signals it blocked would have averaged **+0.1R or better** after slippage, judged on its lifetime (8+ signals) *or* on its latest 12. The page shows how much R each lesson has saved.
- **Did it help?** The report compares each setup's average R per trade *before the first lesson switched on* with the trades *since*. A small number of trades since is noise: wait for 30+.

### Claude's ideas

The AI write-up can suggest up to 3 filters. They go through exactly the same checks as mined ones, and become lessons only if the data backs them up. They're marked "AI idea".

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
- Learning: average R before vs after lessons switched on, the mistakes that cost the most, what the skipped signals would have made, and what the indicator gate skipped vs let through.
- The narrative: headline, summary, ranking notes, why entries failed, how to improve, and caveats.

Claude (`claude-opus-5-5`) gets only these computed numbers, plus each strategy's summary and parameters. It is told to quote the numbers it relies on and to call small samples unproven.

## 5. Ask about the analysis (chatbot)

The **Ask about the analysis** box at the top of **Bots → AI analysis** answers questions in plain English. For example: *"Which setup is closest to being ready for real money?"*, *"Why does Donchian 5m keep losing?"*, *"Is the ADX lesson helping?"*

- It runs on **Google Gemini's free tier** through the `bot-chat` edge function. The API key stays on the server, and the function only reads the signed-in user's own reports, lessons, recent trades and open trades.
- It answers from the latest hourly, daily, weekly and monthly reports, all lessons, and the last 40 closed trades with their reviews. It's told to quote the numbers it uses and to say when the data can't answer.
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

**Limits.** Each run writes at most one AI report, to stay inside the edge function's time limit. A second report due at the same time (say, the weekly one on a Monday) is written the next hour. Each run also makes at most 100 Binance candle requests (and stops fetching after 45 seconds), so a large backlog of reviews and replays is worked through over a few runs. Replayed signals older than 90 days are deleted; lessons keep their own tallies.

**Checking it.** `select kind, period_start, ai_model, ai_error from bot_reports order by created_at desc limit 5;`
