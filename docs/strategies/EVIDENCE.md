# What the data says (and doesn't)

The gate weights, the 0.4% minimum stop and the risk cuts were chosen from a replay of **a year of real Binance history** (365 days to 2026-10-29, BTC/ETH/SOL, all five strategies on all six timeframes, about 20,000 trades), not from taste. This page shows the evidence, including the parts that are disappointing. Reproduce it with `node scripts/gate-analysis.ts`, `node scripts/gate-rules.ts`, `node scripts/gate-sweep.ts` and `npm run backtest`.

## The headline

**No setting of these five textbook strategies made every bot profitable.** Over the year:

| | Setups profitable | Busted (≥ 90% down) | Mean yearly return | Average R per trade |
| --- | --- | --- | --- | --- |
| **Before** (every signal traded, 0.15% minimum stop, full risk always) | 9 of 30 | **8** | −33.5% | −0.029 |
| **Now** (confluence gate, 0.4% minimum stop, cooldown, smaller risk while down) | 10 of 30 | **1** | −19.5% | −0.028 |
| of which **1h, 4h, 1d** (15 setups) | 7 of 15 | 0 | **−3.0%** | **+0.043** |
| of which **5m, 15m, 30m** (15 setups) | 3 of 15 | 1 | −35.9% | −0.037 |

What improved is mostly **survival**: far fewer accounts were wiped out, because the bots wait after a loss, trade smaller while they are down, and skip trades whose stop is too tight to pay the fees. What did **not** improve much is the edge per trade on the short timeframes. On 5m–30m, fees and noise take about as much as the strategies earn. The edge, where there is one, is on **1h and above**.

This is a backtest with the paper fees (taker 0.02%) and **no slippage**. With 0.05% slippage per side, a 0.5% stop loses about another 0.2R per trade, which erases the small edge on 5m–30m. Don't take 5m–30m setups to real money on this evidence.

## What predicted a good trade, and what didn't

Every trade was recorded with the result of each confirming check. Lift = average R of trades that passed the check minus those that failed. "Older" and "newer" are the two halves of the year; a check only earns weight if it helps in **both**.

| Check | Lift | Older half | Newer half | Weight now |
| --- | ---: | ---: | ---: | --- |
| MACD histogram points the trade's way | +0.072 | +0.049 | +0.100 | **3** |
| Volume not drying up | +0.055 | +0.073 | +0.024 | **2** |
| Supertrend agrees | +0.046 | +0.078 | +0.003 | 1 |
| Not a stretched chase | +0.029 | +0.031 | +0.034 | 1 |
| Price on the trade's side of EMA 200 | +0.015 | +0.019 | +0.008 | 1 |
| EMA 50 stack agrees | −0.016 | −0.006 | −0.023 | 0 (tracked) |
| ADX ≥ 20 with the DMI lead | −0.039 | −0.019 | −0.070 | 0 (tracked) |
| Next timeframe up trends the same way | −0.040 | −0.063 | −0.010 | 0 (tracked) |

The last three are the opposite of what most traders expect: **entering with a mature, strong trend did slightly worse**, because those entries come late. They keep weight 0 but are recorded with every trade — each check's own pass/fail is stored live as a `cf_…` reading with every trade and shadow signal — so the learner keeps testing them and they can earn weight if the data changes.

The overall confluence score from my first design (equal-ish weights on all eight checks) was **not predictive at all**: score buckets 65–84 did worse than 0–39. That is why it was rebuilt.

## Stops that are too tight lose to fees

Fees are a fixed share of price, so the closer the stop, the larger the share of the risk they take.

| Stop distance (% of price) | < 0.2 | 0.2–0.4 | 0.4–0.6 | 0.6–0.9 | 0.9–1.4 | ≥ 1.4 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Average R | −0.190 | −0.073 | −0.013 | +0.006 | +0.004 | −0.041 |
| Trades | 629 | 3,875 | 3,689 | 4,186 | 3,800 | 4,087 |

The minimum stop went from 0.15% to **0.4%**. On the same trades that is +0.018R per trade, in both halves of the year.

## The gate threshold, replayed on the year

With the new weights and the 0.4% minimum stop, replaying the recorded trades at each threshold (average R per trade):

| Score needed | Trades kept | All timeframes | Older half | Newer half | 1h–1d only |
| --- | ---: | ---: | ---: | ---: | ---: |
| none | 100% | −0.011 | −0.023 | 0.000 | +0.033 |
| 60 | 87% | −0.001 | −0.013 | +0.009 | +0.056 |
| **65** | 78% | **+0.006** | −0.001 | +0.012 | **+0.059** |
| 70 | 75% | +0.007 | +0.004 | +0.009 | +0.062 |
| 80 | 69% | +0.008 | +0.009 | +0.007 | +0.064 |

Higher is slightly better and consistent in both halves, but each step also drops trades. 65 is "most checks pass" without starving the bots of trades. The learner can raise it for a setup where a higher bar helps (confluence is a lesson feature).

## What is a judgment call, not a measurement

- **The veto** (a trend entry with price against both EMA 200 and Supertrend is refused): about 3% of trades, and their result flips between the halves of the year (−0.12R, then +0.15R). The data neither supports nor refutes it.
- **The cooldown lengths** (3 bars after a loss, 6 after three losses in a row) and the **risk cuts** are protective choices. The sweep shows they cut ruin (busted accounts 8 → 0–2 of 30), not that they raise the edge.
- **The weights were chosen on the same year they were tested on.** The older/newer split shows they are consistent, but it is not a true out-of-sample test. The live paper trading from now on is.
- **The news variants** have no history to test on at all. See [NEWS.md](NEWS.md).

## What it means for the 3-month plan

- Expect the **1h, 4h and 1d** bots to be roughly break-even to modestly positive, and the **5m–30m** bots to keep losing slowly. A realistic result after three months is "some bots show a positive edge at 95% confidence after slippage (the *Ready for a small live test* verdict), most don't yet", not "all bots positive".
- Judge each setup with the app's own bar: 30+ trades, a positive 95% lower bound of R after slippage, profit factor ≥ 1.3, drawdown ≤ 25%, mostly winning weeks. Start real money small, only on setups that clear it, and expect the live result to be a little worse than paper.
- The learner will keep finding what the first year didn't. Check **Are the bots getting better?** on the analysis page each week: it compares the average R before and after the lessons, and shows what the skipped signals would have made.
