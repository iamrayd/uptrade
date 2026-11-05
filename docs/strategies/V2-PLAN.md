# Strategy v2 plan (agreed 2026-11-04, build starts 2026-11-05)

## Why

A full-year replay (365 days to 2026-10-29) of the live configuration (confluence gate 65, discipline on, 2% risk) with 0.05% slippage per side shows no edge:

- 6 of 30 setups profitable; every 5m/15m/30m setup busts.
- The 15 higher-timeframe setups (1h/4h/1d) as one $100 portfolio: −13.9% per year, PF 0.86, win rate 32%.
- Setups picked on the older half of the year (avg R +0.11 to +0.21) averaged −0.19R on the newer half. The edge does not persist.
- Raising risk to 4% or 6% only deepens the loss (−27%, −37%) and the drawdown (29%, 39%).
- Gate 80 instead of 65: no change. Breakeven stop: hurts.

Measured leaks (15 HTF setups, gate 65):

| Leak | Evidence |
|---|---|
| Execution costs | avg R +0.043 on paper, +0.017 at 0.02% slip, −0.022 at 0.05% slip. Maker entries recover ~0.02R |
| Signal exits (opposite cross) | 208 trades, avg −0.37R, −76R total. Trailing stops avg +0.34R, take-profits +1.79R |
| Discipline on 1d | supertrend 1d −2.3% with discipline vs +13.3% without; donchian 1d +13.8% vs +25.2% |
| Regime dependence | donchian 4h −0.02R older half, +0.44R newer half; only 23 trades/yr on donchian 1d |
| Shorts | −0.031R vs longs −0.012R |
| Correlation | 3 same-direction positions × 2% = 6% open risk, no cap |

Scripts: `scripts/experiments/slippage-review.ts` (output in `slippage-review.out.txt`), `cost-sensitivity.ts`, `discipline-on-off.ts`. Run with `node --experimental-strip-types scripts/experiments/<file>`. They read the cached candles in `scripts/.cache` (end timestamp 1793232000).

## Scope for tomorrow (items 1–4 and 8 from the review)

1. **Retire persistent losers.** Keep 5m/15m/30m on probation permanently. Also stop capital on ema_trend 1h, donchian 1h, supertrend 1h, macd_adx 4h, supertrend 4h (negative in both halves of the year).
2. **Trailing exits instead of signal exits** for ema_trend and macd_adx: new strategy keys (`ema_trend_v2`, `macd_adx_v2`), trail instead of the opposite-cross exit, fixed 2R target dropped or made partial. Do not edit the running strategies in place (see docs/strategies/README.md).
3. **Discipline per timeframe.** Disable cooldown and risk cuts on 1d, shorten on 4h, keep on 1h.
4. **Maker entries.** Limit order at the signal close, cancelled if unfilled within N minutes; model it in the backtester as maker fee + zero entry slippage.
5. **Backtester realism** (item 8): add a slippage parameter, report $ and R separately, keep discipline out of raw strategy comparisons.

Validation bar: out-of-sample (newer half) avg R > +0.10 at 0.05% slip over 100+ trades before any setup trades above 2% risk.

## Built on 2026-11-05

| Item | Where | What |
|---|---|---|
| 1. Retire losers | `tuning.ts` (`RETIRED`, `isRetired`), `tick.ts`, `bot.sql` | The short timeframes and the five named setups (with their news twins) are shadow-only. The engine enforces it in code, and no replay record promotes them. |
| 2. Trailing exits | `strategies.ts` (`withChandelier`, `ema_trend_v2`, `macd_adx_v2`) | Same entry and initial stop as the originals. The only exit is a chandelier stop: best price since entry minus 3 × ATR(14). No target, no opposite-cross exit. 12 new accounts; the originals are unchanged. |
| 3. Discipline per timeframe | `discipline.ts` (`disciplineFor`) | 1d: no cooldown, no risk cuts. 4h: cooldown 1 bar, 2 bars after a streak, risk cuts kept. 1h and below: unchanged. |
| 4. Maker entries | `risk.ts` (`ENTRY`), `tick.ts` step 0, `bot.sql` (`bot_pending_entries`) | Built and tested, **switched off** (`ENTRY.maker = false`): the replay below shows no gain. When on, an entry is a limit at the signal close. It fills when a closed 1m candle trades through it; it is cancelled after a quarter of the bar (2 min to 1 h) and kept as an `unfilled` shadow signal. |
| 5. Backtester realism | `backtest.ts`, `scripts/backtest.ts` | `slippage` on every taker fill, `makerEntry` (limit at the signal close, must be traded through; with 1m candles it follows the live fill rules exactly), `totalR`/`avgR` (strategy) apart from `netUsd` (account). The report shows R without discipline and $ with it. |

To deploy: re-run `supabase/bot.sql`, then redeploy `bot-tick` and `bot-analyze` (SETUP.md).

### What the year replay says about it

`node --experimental-strip-types scripts/experiments/v2-validate.ts` (output in `v2-validate.out.txt`). Same cached year, 0.05% slippage on every taker fill, gate 65. Trades are split by entry time into the older and the newer half.

**Exits.** Average R per trade, 1h + 4h + 1d together, taker entries:

| | older half | newer half |
|---|---:|---:|
| ema_trend (cross exit + 2R target) | −0.029 (259) | −0.125 (230) |
| ema_trend_v2 (3 × ATR trail) | +0.004 (257) | +0.218 (220) |
| macd_adx (cross exit + 2R target) | −0.001 (175) | −0.109 (188) |
| macd_adx_v2 (3 × ATR trail) | +0.059 (152) | +0.043 (160) |

The trail beats the cross exit in both halves for both strategies. Trail widths of 2.5 and 3 × ATR are equal within noise on the older half (ema_trend +0.015 vs +0.004, macd_adx +0.073 vs +0.059); 3 was fixed before the run and kept. On the older half alone the v2 edge is about zero: most of the gain is in the newer half.

**Maker entries: no gain, so they are off.** Replayed on 1-minute candles with the live rules (the order can fill only on candles that start at least a minute after the close, and lapses after a quarter of the bar), 92% of the orders fill. All 16 live setups, per trade: +0.019R taker vs +0.007R maker (older half), +0.116R vs +0.127R (newer half). Total over the year: **+98.5R taker, +87.9R maker**. The fee and slippage saved are given back by the entries that never fill, which are the ones that ran away at once. The earlier estimate ("maker entries recover ~0.02R") did not count those. A cruder model that lets the order fill in the first minute shows +143R: most of the apparent gain sits in a minute the live bot cannot trade. Maker entries would pay only if real slippage is well above 0.05% per side.

**Discipline.** Dollars of the $100 accounts over the year, on vs off: 1h −21.9 vs −76.9, 4h +9.7 vs +50.5, 1d the same (off). It protects the 1h accounts and costs the 4h accounts most of their return, even with the shortened rules. That is one year of five setups, so 4h was left as planned; it is the first thing to look at next.

**The book as it now runs live** (16 setups, gate 65, discipline, market entries): older half +0.023R over 667 trades (t = 0.4), newer half +0.145R over 652 trades (t = 1.6). $100 split across the 16 setups made **+$4.81 over the year, about $0.013 per day**. Before these changes the 15 higher-timeframe setups lost 13.9%.

**Validation bar: not met.** The newer half of the whole book clears +0.10R, but that test is flattered: the retired list was drawn from both halves of this same year. The clean test picks setups on the older half only (avg R > 0.05, 10+ trades: donchian 1d, ema_trend_v2 4h, macd_adx_v2 4h) and reads their newer half: **+0.419R, but over only 86 trades (t = 1.1)**, short of the 100 the bar asks for. One single setup clears the bar on the newer half (macd_adx_v2 1h, +0.229R over 112 trades), but it lost on the older half (−0.057R), so that is one good half-year, not a proven edge. Risk stays at 2%.

The 1h setups are the weak part of the book: ema_trend_v2 1h lost $35 over the year (−0.138R on the older half, +0.033R on the newer) and is not retired, because it is a new rule set with no live record yet. The analyzer will put it on probation if its live verdict turns "Avoid".

## Deferred (items 5–7, 9–10)

More symbols (10–15 liquid perps on 4h/1d), BTC regime filter / long-only test, portfolio risk cap ≤ 4%, freezing self-tuning until the base edge is proven, promotion bar for aggression.

## Expectation

If items 1–7 land and the edge holds: roughly +20–40% per year on the HTF portfolio, about $0.05–0.10 per day on $100. Daily income from $100 is not realistic; capital size is the lever, not risk.
