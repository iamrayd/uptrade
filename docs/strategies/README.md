# UpTrade strategy bots

Five rule sets, each on three timeframes, run around the clock against live Binance prices. Every **rule set × timeframe** pair is its own **$100 paper account** (15 accounts), so the results can be compared fairly. **Every signal a rule set gives is traded**: nothing scores, filters or holds back an entry.

| Rule set | Type | Entry | Exit | Doc |
|---|---|---|---|---|
| Fair Value Gap | ICT, trend | First retrace into a displacement gap, with the 200 EMA | Stop beyond the gap, 2R target | [fvg.md](fvg.md) |
| Order Block | ICT, structure | First retest of the last opposite candle before a break of structure | Stop beyond the block, 2R target | [order_block.md](order_block.md) |
| Bollinger + RSI Reversion | Mean reversion | Close back inside a 2σ band after an RSI extreme | Stop beyond the swing, target the middle band, 24-bar time stop | [bb_rsi_reversion.md](bb_rsi_reversion.md) |
| EMA Pullback | Trend following | First dip to the 20 EMA in a 20/50 EMA trend | Stop beyond the wick, 2R target | [ema_pullback.md](ema_pullback.md) |
| Donchian Breakout | Breakout | 20-bar high/low break with 1.5× volume | 2×ATR stop, then trails the 10-bar channel | [donchian_breakout.md](donchian_breakout.md) |

Why these five, what a year of history says about them, and how to read the trial: [V3.md](V3.md). The short version is that none of them has a proven edge after realistic costs, and the trial is there to find out which are worth keeping.

**Timeframes:** 15m, 1h and 4h for every rule set. **Coins:** BTCUSDT, ETHUSDT and SOLUSDT. Each account holds at most one position per coin.

The rules in each doc are generated from the code the bot runs (`npm run docs:strategies`), so they can't drift apart.

## Risk management shared by every rule set

Settings live in the `bot_settings` table.

| Rule | Value |
|---|---|
| Starting balance | $100 per account |
| Risk per trade | **2% of the account's equity**, measured from entry to stop and **including both fees**. The same for every trade: no scaling up or down. |
| Leverage | the **lowest** that fits, **20x max**. It's also capped so the liquidation price sits at least 1.5× the stop distance beyond entry, so the stop is always hit first. |
| Margin per trade | at most ⅓ of equity (one slot per coin). If that can't carry the full 2% risk, the size shrinks rather than the leverage rising. |
| Minimum stop distance | **0.4%** of price. A rule's stop that is closer is **widened to 0.4%** and its target moved out by the same factor, so the reward-to-risk stays the same. The trade is still taken. (Fees are a fixed share of price: on a year of history, stops under 0.2% averaged −0.19R per trade.) |
| Minimum order | $5 notional |
| Fees | taker 0.02% on market and stop fills, maker 0% on take-profit limits |
| Entries | market orders (taker) |
| Busted | below $10 of equity, the account stops opening trades |

## When a signal is not opened

Only when it cannot be. Each case is written to the bot log as `skipped`, with the reason:

- **the account already holds that coin** (one position per coin; the open trade is managed, no log line),
- **busted**: the account is under $10,
- **stale**: by the time the order is placed, the price is already past the signal's stop or target,
- **sizing**: the position would be under $5, or the account has no free balance for the margin.

## How a trade is executed

1. **Signal.** Every minute, the runner checks which timeframes just closed a bar. Rule sets only see **closed** bars (the last 600), so signals never repaint.
2. **Fresh only.** A bar is acted on only if the runner sees it within max(3 min, 10% of the bar) after the close. After downtime, late bars are logged as *missed*, not traded at a stale price.
3. **Entry** fills at the current market price (taker fee). The stop is widened if it is under the minimum, then rounded away from price to the exchange tick; the target rounds to the nearest tick.
4. **Stops, targets and liquidations** are checked against every closed **1-minute** candle since the last check:
   - a candle that opens past the stop fills at the open (slippage)
   - when one candle touches both the stop and the target, the **stop is assumed first** (conservative)
   - after downtime, the runner replays up to ~7 days of 1m candles in time order
5. **Management** at each bar close: trailing stops only ever tighten. Time stops close at market.
6. **Journal.** Each trade stores:
   - the reason for the entry and the readings on the signal bar (the gap or block edges, the swing that broke, ATR)
   - the sizing maths (risk $, stop %, why that leverage, whether the stop was widened)
   - every stop move
   - best and worst price (MFE/MAE, in R)
   - the exit reason with the exact 1m candle that triggered it
   - net PnL and the R multiple

   The trade page adds a chart and a review.

## Where things are

| Piece | File |
|---|---|
| Rule sets (entry and management rules) | `supabase/functions/_shared/bot/strategies.ts` |
| Market structure: swings, breaks, fair value gaps, order blocks, levels, candle patterns | `supabase/functions/_shared/bot/structure.ts` |
| Indicators (EMA/RSI/BB/MACD match the chart; ATR and DMI/ADX follow TradingView's definitions) | `supabase/functions/_shared/bot/indicators.ts` |
| Entry planning, sizing, leverage, liquidation, fills | `supabase/functions/_shared/bot/risk.ts` |
| The per-minute run | `supabase/functions/_shared/bot/tick.ts` |
| Reviews, statistics, reports (measures only) | `supabase/functions/_shared/bot/analysis.ts`, `analyze.ts` |
| Edge function entries | `supabase/functions/bot-tick`, `bot-analyze`, `bot-chat` |
| Tables, RLS and atomic accounting (service-role only) | `supabase/bot.sql` |
| Full reset | `supabase/bot_reset.sql` |
| Cron schedule | `supabase/bot_cron.sql` |
| Dashboard | `src/app/(app)/bots/**` |
| Backtester (same rule, entry-planning and risk code as live) | `supabase/functions/_shared/bot/backtest.ts`, `scripts/backtest.ts` |
| The selection run | `scripts/experiments/v3-select.ts`, [V3.md](V3.md) |
| Tests (unit, plus Postgres integration on PGlite) | `scripts/test/*.test.ts` (`npm run test:bot`) |

## Changing, adding or dropping a rule set

- **Change.** Don't edit a running rule set in place, because that mixes two rule sets in one track record. Copy it under a new `key` (for example `fvg_v2`), add it to `STRATEGIES`, and deploy `bot-tick`. The next run creates its three new $100 accounts alongside the original's.
- **Add.** The other backtested rule sets are in `CANDIDATES` in the same file. Add one to `STRATEGIES` and deploy.
- **Drop.** Remove it from `STRATEGIES` and deploy. Its accounts stop trading at once (open trades stay open until you close the test with a reset, so drop a rule set when it is flat, or accept that). Its history stays in the database.
- **One timeframe only.** Give the rule set a `timeframes` list, for example `timeframes: ["1h", "4h"]`.
