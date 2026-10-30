# Strategy improvement plan — bot trading patterns

Date: 2026-10-29. Status: implemented 2026-10-30 (changes 1–5; see tuning.ts, bot.sql per-setup tuning columns, scripts/test/bot-tuning.test.ts). One deviation: a breakeven stop-out reports exit reason `trailing_stop` with a "breakeven stop" note, instead of a new `breakeven_stop` reason, to avoid widening the `bot_trades.exit_reason` check constraint.
Evidence base: `docs/strategies/EVIDENCE.md` (1-year replay, ~20k trades), `docs/backtests/after-upgrade.md`, full code exploration of `supabase/functions/_shared/bot/` (3 subagent reports, file:line cites below).

## Measured problems

1. **5m–30m setups have no edge.** Avg −0.037R, −35.9% mean yearly return; 0.05% slippage per side erases any residue. 1h–1d: +0.043R, −3.0% — the edge lives there (EVIDENCE.md headline table). Worst bleeders: donchian 5m −90% (busted), supertrend 5m −68.1%, ema_trend 5m/15m/30m ≈ −60%.
2. **Exits leak R, and nothing learns them.** Lessons can only say "skip entry when X" (`analysis.ts:124-138`); AI suggestions likewise (`ai.ts:44-59`). Review categories `gave_back` (MFE ≥ 1R then loss), `stopped_then_ran`, `exit_too_early` have canned fix texts ("breakeven at +1R", "widen stop") that are display-only (`analysis.ts:170-183`). No breakeven, no partials, no generic time stop in engine (`tick.ts:216-251`).
3. **Confluence threshold global and static at 65** (`confluence.ts:24`; `tick.ts:65,300`). Evidence: 70–80 yields +0.062→+0.064R on 1h–1d, consistent in both year halves.
4. **Learner blind spots — signals never replayed:**
   - Min-stop and sizing skips use plain `skip()`, not `shadow()` (`tick.ts:330`).
   - Strategy-internal skips (ADX/volume/reward filters) only logged as events (`tick.ts:256-260`).
   - **Weight-0 confluence checks are NOT persisted live**: `cf.readings` keeps only cfScore/cfPassed/cfTotal/cfHtf; the `checks` array is dropped (`confluence.ts:165-167`). EVIDENCE.md's claim that the learner "keeps testing them" is false in live trading — only the offline backtest stores them (`backtest.ts:198`).
5. **Flat sizing.** Only drawdown/streak cuts (`discipline.ts:27-47`); no conviction scaling. Side effect: positive-avg-R setups with negative dollar returns (donchian 1h +0.07R but −28.8%) because recoveries happen at cut size.

## Changes (build order)

### 1. Probation: shadow-only mode for unproven setups
- Add `probation boolean` to `bot_accounts` (`bot.sql:37`; account = strategy × timeframe = natural per-setup config row, read in `io.ts:62-75`).
- In `tick.ts` after lessons gate (`tick.ts:316`): `if (acc.probation) return shadow("probation", ...)`. Add `"probation"` to `SkipReason` (`io.ts:122`) and to the check on `bot_filtered_signals.reason`.
- Default 5m/15m/30m setups to probation. Signals keep replaying hourly via existing machinery (`analyze.ts:166-229`, `simulateSignal` at `analysis.ts:1004-1043`), zero capital burn.
- Promotion (analyzer, hourly): replayed entries reach Promising bar — PF > 1.1 after slippage, 30+ entries — clears probation; verdict "avoid" re-enters it. Hysteresis: no flip more than once per 7 days.

### 2. Close learner blind spots (small, high value)
- Route min-stop/sizing skips through `shadow()` with new reason `min_stop` (`tick.ts:330`).
- Persist full confluence `checks` array into `cf.readings` / `entry_indicators` (`confluence.ts:165-167`, `tick.ts:277`) so weight-0 checks (emaStack, strength, htf) become real lesson features live, as EVIDENCE.md intends.
- Watch shadow caps: analyzer loads newest 4000 resolved / 800 pending (`bot.sql:523-533`); probation adds volume. Raise caps or prioritize by setup if starved.

### 3. Per-setup confluence threshold (learned parameter)
- Add `min_confluence int` to `bot_accounts`; use at gate: `passesGate(cf, acc.min_confluence ?? minConfluence)` (`tick.ts:300`). Fix `low_confluence` mistake tag to read the per-setup value (`analysis.ts:358`).
- Hourly analyzer sweeps {65,70,75,80} on each setup's trades + resolved replays (per-entry `confluence` feature already stored). Adopt higher threshold only if both time-halves improve, ≥30 entries, resulting extra skip ≤ existing 60% room rule. Cap 80, floor 65.

### 4. Learned exit management: breakeven stop
- Generic rule wrapped around `strat.manage` call (`tick.ts:219-241`): once trade's MFE ≥ +1R (MFE already tracked per 1m candle, `tick.ts:150-154`), propose stop = entry ± fee cover. Engine already accepts only tighter stops (`risk.ts:188-192`) — clean fit. Exit reason `breakeven_stop`.
- Per-setup on/off, judged like lessons. Scoring: add breakeven variant to `simulateSignal` (`analysis.ts:1004`) and replay recent entries from entry onward, comparing variant `rSlip` vs baseline on the same signals. (Do NOT reuse `afterExitR`: losers-only, no time-ordered path — MFE/MAE alone cannot say whether +1R came before the stop.)
- Activate when variant saves ≥2R with t ≥ 2 over ≥30 entries; retire when it stops helping (same retire logic shape as `analyze.ts:231-245`).
- **Partials dropped from v1**: `closeTrade` is whole-position (`io.ts:192`), `TradeUpdate` has no qty — schema + RPC cost deferred.

### 5. Conviction-weighted sizing
- `size_mult` per account: 1.25× when entry confluence ≥ 80 AND setup verdict ≥ Promising; 0.75× when confluence < 70 or verdict Unproven. Multiply into `riskPct` at `tick.ts:328`; existing discipline cuts still multiply on top; leverage/margin caps unchanged.
- Auto-revert to 1.0 if R-weighted result worse than flat after 30 trades (existing before/after comparison machinery).

## Not doing (and why)
- **New strategies.** None of current 5 has proven edge; 6th adds noise.
- **Changing gate weights.** Measured from lift; change 2 makes weight-0 checks learnable live, which is the right correction path.
- **Partial exits** — deferred (schema).
- **Loosening gates automatically** (lower threshold/cooldowns): shadow replays will show if gates cost money; revisit with data.

## Backlog (found, not in v1)
- Lesson dedup key `strategy|tf|feature|op` blocks re-learning a retired rule at a new threshold (`analysis.ts:914`, unique index `bot.sql:157-158`).
- Lessons don't apply across `*_news` twins (`tick.ts:313` exact-key match; `baseKey` exists in `strategies.ts:363-391`).
- No correlation/exposure check across BTC/ETH/SOL (up to 6% same-direction risk per account).
- No regime model; results flip between year halves (veto, Supertrend lift).
- Backtest/live divergence: live checks stops on 1m bars + current-price entry; backtest uses TF bars + next-open, no slippage, no lessons/news.
- Single-feature rules only; no conjunctions.
- Busted accounts permanent without manual SQL reset.

## Files touched
`supabase/functions/_shared/bot/tick.ts`, `risk.ts`, `io.ts`, `types.ts`, `confluence.ts`, `analysis.ts`, `analyze.ts`, `supabase/bot.sql` (new account columns, reason check, RPC updates), tests in `scripts/test/`, docs in `docs/strategies/`.

## Validation
- Each change behind per-setup flag; judged by existing hourly before/after R report.
- Pre-deploy: `npm run backtest` year replay with changes 1, 3, 4 (backtester shares strategy/risk code, `backtest.ts:7-12`); require busted ≤ 1, mean return improves, 1h–1d avg R improves, both year halves.
- Unit tests: probation gate ordering, breakeven stop proposal/acceptance, threshold sweep adoption rules, sizing multiplier bounds.

## Build order
2 → 1 → 3 → 4 → 5. Blind-spot fixes first (they feed every later judgment), then risk removal, then threshold, exits, sizing.
