# UpTrade strategy bots

Five widely used crypto strategies, each tested on six timeframes, run around the clock against live Binance prices. Every **strategy × timeframe** pair is its own **$100 paper account** (30 accounts in total), so the results can be compared fairly.

| Strategy | Type | Entry | Exit | Doc |
|---|---|---|---|---|
| EMA Trend Cross | Trend following | EMA 9/21 cross with the 200 EMA | 1.5×ATR stop, 2R target, opposite cross | [ema_trend.md](ema_trend.md) |
| Bollinger + RSI Reversion | Mean reversion | Close back inside a 2σ band after an RSI extreme | Stop beyond the swing, target the middle band, 24-bar time stop | [bb_rsi.md](bb_rsi.md) |
| Donchian Breakout | Breakout | 20-bar high/low break with 1.5× volume | 2×ATR stop, then trails the 10-bar channel | [donchian.md](donchian.md) |
| MACD Momentum + ADX | Momentum | MACD/signal cross with ADX ≥ 25 and the DMI agreeing | 1.5×ATR stop, 2R target, opposite cross | [macd_adx.md](macd_adx.md) |
| Supertrend Flip | Trend following | Supertrend(10, 3) flip with ADX ≥ 20 | The Supertrend line as the trailing stop | [supertrend.md](supertrend.md) |

**Timeframes:** 5m, 15m, 30m, 1h, 4h and 1d for every strategy. **Coins:** BTCUSDT, ETHUSDT and SOLUSDT. Each account holds at most one position per coin.

The rules in each doc are generated from the code the bot runs (`npm run docs:strategies`), so they can't drift apart. Changes I made to the textbook versions are marked **Modification** in each doc, with the reason.

## Risk management shared by every strategy

Settings live in the `bot_settings` table. The defaults are the ones we agreed on:

| Rule | Value |
|---|---|
| Starting balance | $100 per account |
| Risk per trade | **2% of the account's equity**, measured from entry to stop and **including both fees** |
| Leverage | the **lowest** that fits, **20x max**. It's also capped so the liquidation price sits at least 1.5× the stop distance beyond entry, so the stop is always hit first. |
| Margin per trade | at most ⅓ of equity (one slot per coin). If that can't carry the full 2% risk, the size shrinks rather than the leverage rising. |
| Minimum stop distance | 0.15% of price. Tighter stops are skipped, because fees and noise would dominate. |
| Minimum order | $5 notional |
| Fees | as MEXC futures and the UpTrade engine: taker 0.02% on market and stop fills, maker 0% on take-profit limits |
| Busted | below $10 of equity, the account stops opening trades |

**Why 2% and not more?** The stretch goal is $100 → $500 in a month (+400%). No honest risk setting gets there reliably. At 2%, ten losses in a row cost about 18%, so the month produces real data on which strategies work instead of 30 blown accounts. The goal tracker on the Bots page shows how close the best account gets.

## How a trade is executed

1. **Signal.** Every minute, the runner checks which timeframes just closed a bar. Strategies only see **closed** bars, so signals never repaint.
2. **Fresh only.** A bar is acted on only if the runner sees it within max(3 min, 10% of the bar) after the close. After downtime, late bars are logged as *missed*, not traded at a stale price.
3. **Entry** fills at the current market price (taker fee). Stops round away from price to the exchange tick, and targets round to the nearest tick.
4. **Stops, targets and liquidations** are checked against every closed **1-minute** candle since the last check:
   - a candle that opens past the stop fills at the open (slippage)
   - when one candle touches both the stop and the target, the **stop is assumed first** (conservative)
   - after downtime, the runner replays up to ~7 days of 1m candles in time order
5. **Management** at each bar close: trailing stops only ever tighten. Signal exits and time stops close at market.
6. **Journal.** Each trade stores:
   - the reason for the entry and the indicator readings on the signal bar
   - the sizing maths (risk $, stop %, why that leverage)
   - every stop move
   - best and worst price (MFE/MAE, in R)
   - the exit reason with the exact 1m candle that triggered it
   - net PnL and the R multiple

   The trade page adds a chart with the strategy's indicators and a one-line review.

## Where things are

| Piece | File |
|---|---|
| Strategies (entry and management rules) | `supabase/functions/_shared/bot/strategies.ts` |
| Indicators (EMA/RSI/BB/MACD match the chart; ATR, DMI/ADX and Supertrend follow TradingView's definitions) | `supabase/functions/_shared/bot/indicators.ts` |
| Sizing, leverage, liquidation, fills | `supabase/functions/_shared/bot/risk.ts` |
| The per-minute run | `supabase/functions/_shared/bot/tick.ts` |
| Edge function entry | `supabase/functions/bot-tick/index.ts` |
| Tables, RLS and atomic accounting (service-role only) | `supabase/bot.sql` |
| Cron schedule | `supabase/bot_cron.sql` |
| Dashboard | `src/app/(app)/bots/**` |
| Backtester (same strategy and risk code) | `supabase/functions/_shared/bot/backtest.ts`, `scripts/backtest.ts` |
| Tests (16: unit, plus Postgres integration on PGlite) | `scripts/test/*.test.ts` (`npm run test:bot`) |

## Changing or adding a strategy

Don't edit a running strategy in place, because that mixes two rule sets in one track record. Copy it under a new `key` (for example `ema_trend_v2`), add it to `STRATEGIES`, and deploy. The next run creates its 6 new $100 accounts automatically, alongside the original's.
