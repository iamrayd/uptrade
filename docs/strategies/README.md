# UpTrade strategy bots

Five widely used crypto strategies, trailing-exit (v2) variants of two of them and news-aware twins of three of them, each tested on six timeframes, run around the clock against live Binance prices. Every **strategy × timeframe** pair is its own **$100 paper account** (60 accounts in total), so the results can be compared fairly. Not every account trades with capital: see [Retired setups](#retired-setups).

| Strategy | Type | Entry | Exit | Doc |
|---|---|---|---|---|
| EMA Trend Cross | Trend following | EMA 9/21 cross with the 200 EMA | 1.5×ATR stop, 2R target, opposite cross | [ema_trend.md](ema_trend.md) |
| Bollinger + RSI Reversion | Mean reversion | Close back inside a 2σ band after an RSI extreme | Stop beyond the swing, target the middle band, 24-bar time stop | [bb_rsi.md](bb_rsi.md) |
| Donchian Breakout | Breakout | 20-bar high/low break with 1.5× volume | 2×ATR stop, then trails the 10-bar channel | [donchian.md](donchian.md) |
| MACD Momentum + ADX | Momentum | MACD/signal cross with ADX ≥ 25 and the DMI agreeing | 1.5×ATR stop, 2R target, opposite cross | [macd_adx.md](macd_adx.md) |
| Supertrend Flip | Trend following | Supertrend(10, 3) flip with ADX ≥ 20 | The Supertrend line as the trailing stop | [supertrend.md](supertrend.md) |
| EMA Trend Cross **v2** | Trend following | Same as EMA Trend Cross | 1.5×ATR stop, then a 3×ATR chandelier trail. No target, no exit on the opposite cross | [ema_trend_v2.md](ema_trend_v2.md) |
| MACD Momentum + ADX **v2** | Momentum | Same as MACD + ADX | 1.5×ATR stop, then a 3×ATR chandelier trail. No target, no exit on the opposite cross | [macd_adx_v2.md](macd_adx_v2.md) |
| MACD Momentum + ADX **+ News** | As MACD + ADX | Same trigger, but waits out fresh high-impact crypto news and doesn't trade against one-sided news | Same as MACD + ADX | [macd_adx_news.md](macd_adx_news.md) |
| Donchian Breakout **+ News** | As Donchian | As above | Same as Donchian | [donchian_news.md](donchian_news.md) |
| Supertrend Flip **+ News** | As Supertrend | As above | Same as Supertrend | [supertrend_news.md](supertrend_news.md) |

How the entry gate, the stop floor and the risk cuts were chosen, and what a year of history says they achieve (and don't), is in [EVIDENCE.md](EVIDENCE.md). The news twins are explained in [NEWS.md](NEWS.md). Each is a separate track record next to its original, so the two can be compared on the same timeframe.

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
| Minimum stop distance | **0.4%** of price (was 0.15%). Tighter stops are skipped, because fees would eat too much of the risk: on a year of history, stops under 0.2% averaged −0.19R per trade and 0.2–0.4% averaged −0.07R. |
| Minimum order | $5 notional |
| Fees | as MEXC futures and the UpTrade engine: taker 0.02% on market and stop fills, maker 0% on take-profit limits |
| Entries | market orders (taker). Limit-order entries at the signal bar's close are built (`ENTRY.maker` in `risk.ts`) but **off**: on a year of 1-minute candles they made no more than market entries, because the orders that never fill are the trades that ran away at once ([V2-PLAN.md](V2-PLAN.md)). |
| Busted | below $10 of equity, the account stops opening trades. It still sees every signal and replays it, so it keeps learning. |
| Smaller risk while losing | 50% of the normal risk once the account is 30% below its start (25% at 60% below), after 3 losses in a row, or when the last 6+ trades averaged worse than −0.3R. Full size again once it recovers. Not on 1d. |
| Patience | A signal must score **65/100 or more** on the confluence gate (most confirming indicators agree, weighted by what a year of history showed predicts a good entry). After a loss on a coin the bot waits 3 bars there; after 3 losses in a row, 6 bars everywhere (1 and 2 bars on 4h, no wait on 1d). See [ANALYSIS.md](ANALYSIS.md#3-learning-how-the-bots-improve). |

**Why 2% and not more?** The stretch goal is $100 → $500 in a month (+400%). No honest risk setting gets there reliably. At 2%, ten losses in a row cost about 18%, so the month produces real data on which strategies work instead of 30 blown accounts. The goal tracker on the Bots page shows how close the best account gets.

## Retired setups

A year replay of the live configuration with 0.05% slippage per side ([V2-PLAN.md](V2-PLAN.md)) showed no edge after costs on most setups. These get **no capital**. They stay shadow-only: their signals are logged and replayed, so the record keeps growing, but no replay record promotes them.

- every strategy on **5m, 15m and 30m**
- **EMA Trend 1h, Donchian 1h, Supertrend 1h, MACD + ADX 4h, Supertrend 4h** (negative in both halves of the year), and their news twins

The list lives in `tuning.ts` (`RETIRED`). The v2 strategies are new rule sets, so only the short timeframes are closed to them.

## How a trade is executed

1. **Signal.** Every minute, the runner checks which timeframes just closed a bar. Strategies only see **closed** bars, so signals never repaint. A signal then has to pass the confluence gate, the news gate (news twins only), the cooldown and the active lessons. A signal that doesn't is stored with the reason and replayed later as learning data.
2. **Fresh only.** A bar is acted on only if the runner sees it within max(3 min, 10% of the bar) after the close. After downtime, late bars are logged as *missed*, not traded at a stale price.
3. **Entry** fills at the current market price (taker fee). Stops round away from price to the exchange tick, and targets round to the nearest tick. With `ENTRY.maker` on (off by default), the entry is instead a limit order resting at the signal bar's close, or at the current price when that is already better. It fills when a closed 1-minute candle trades **through** the limit (a touch is not counted), at the limit price and with no fee. If that does not happen within a quarter of the bar (at least 2 minutes, at most 1 hour), the order is cancelled and the signal is kept as an `unfilled` shadow signal.
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
| Confluence gate (indicators that must agree, next-timeframe trend) | `supabase/functions/_shared/bot/confluence.ts` |
| Cooldown and smaller risk while losing | `supabase/functions/_shared/bot/discipline.ts` |
| Crypto news: feeds, scoring, the news gate | `supabase/functions/_shared/bot/news.ts`, `supabase/functions/bot-news/index.ts` |
| Learning: mistake tags, lessons, replays | `supabase/functions/_shared/bot/analysis.ts`, `analyze.ts` |
| The per-minute run | `supabase/functions/_shared/bot/tick.ts` |
| Edge function entry | `supabase/functions/bot-tick/index.ts` |
| Tables, RLS and atomic accounting (service-role only) | `supabase/bot.sql` |
| Cron schedule | `supabase/bot_cron.sql` |
| Dashboard | `src/app/(app)/bots/**` |
| Backtester (same strategy, gate and risk code; slippage, maker entries, R and $ reported separately) | `supabase/functions/_shared/bot/backtest.ts`, `scripts/backtest.ts`, `scripts/gate-sweep.ts` |
| Per-setup tuning and the retired list | `supabase/functions/_shared/bot/tuning.ts` |
| The v2 evidence (year replay, older half vs newer half) | `scripts/experiments/v2-validate.ts`, [V2-PLAN.md](V2-PLAN.md) |
| Tests (unit, plus Postgres integration on PGlite) | `scripts/test/*.test.ts` (`npm run test:bot`) |

## Changing or adding a strategy

Don't edit a running strategy in place, because that mixes two rule sets in one track record. Copy it under a new `key` (for example `ema_trend_v2`), add it to `STRATEGIES`, and deploy. The next run creates its 6 new $100 accounts automatically, alongside the original's. `ema_trend_v2` and `macd_adx_v2` were added this way.
