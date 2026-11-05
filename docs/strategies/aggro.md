# Aggressive (playbook) (`aggro` v1)

> Generated from `supabase/functions/_shared/bot/strategies.ts`. Don't edit by hand; run `npm run docs:strategies`.

Takes the best-rated signal of all 7 rule sets and risks up to 10% of equity on it, sized by a playbook that learns from every signal. Aims for +10% a day; it can bust, and a redeploy keeps what it learned.

**Timeframes:** 15m, 1h. Each timeframe is its own $100 account trading BTC, ETH and SOL, at most one position per coin.

**Idea.** A high-risk account that does not own a rule set. It watches the signals of every rule set and bets on the ones its own record says pay, as large as that record justifies. It is built to compound fast or bust, and to come back knowing more.

**Signals.** On every closed bar, each of these rule sets is asked for an entry: ema_trend, bb_rsi, donchian, macd_adx, supertrend, ema_trend_v2, macd_adx_v2. The confluence gate, the cooldown, lessons and probation do not apply here: the playbook decides.

**Context.** Every signal is described by: the rule set, the side, the coin, the next timeframe up (with / against / mixed), the confluence band, volatility (ATR against its 100-bar average), trend strength (ADX), the side of EMA 200 and the UTC session.

**Playbook.** For every context the account keeps the average result in R of all signals it has seen there, traded or not (untraded ones are replayed after slippage). The expected R of a new signal starts from all signals, moves to its rule set, then to each context of that rule set; every step is shrunk with 20 phantom samples, so a few lucky trades change little. Old samples fade, so the playbook follows the current market.

**Entry.** The best-rated signal on a coin is traded if its expected R is at least +0.05R and its rule set has 10+ samples. One position per coin. Every other signal is kept and replayed, so it still teaches.

**Risk**
- Risk per trade = expected R × 0.4, between 2% and 10% of equity. Leverage and margin caps are the shared ones, so the real risk can be lower.
- Stop, target and trailing: those of the rule set that produced the signal.
- Day target: once the account is up 10% on the UTC day it stops entering. Day loss limit: the same at -15%.

**Lives.** Under $10 of equity the account is busted. **Redeploy** starts the next life at the starting balance with the playbook intact. Each ended life gets a post-mortem, and the losing trades between its peak and its end are learned a second time.

## Parameters

| Name | Value |
|---|---|
| maxRiskPct | 10 |
| minRiskPct | 2 |
| minEdgeR | 0.05 |
| dayTargetPct | 10 |
| dayStopPct | -15 |
| priorSamples | 20 |

Warm-up: 400 closed bars before the first signal.

## Shared rules (all strategies)

See [README.md](README.md#risk-management-shared-by-every-strategy).
