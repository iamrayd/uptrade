import type { Candle, StrategyDef, Timeframe } from "./types.ts";
import { SYMBOLS, TF_SECONDS, TIMEFRAMES } from "./types.ts";
import { STRATEGIES, STRATEGY_BY_KEY } from "./strategies.ts";
import { checkExit, planEntry, roundStop, sizePosition, TAKER_FEE, tighterStop } from "./risk.ts";
import { strategyMeta } from "./io.ts";
import type { AccountRow, Db, EventRow, Market, OpenTradeInput, SkipReason, SymbolFilters, TradeRow, TradeUpdate } from "./io.ts";

// One bot run. Called every minute by pg_cron → bot-tick edge function.
//
//  1. Stops & targets: replay the closed 1-minute candles since each open trade was last
//     checked, and fill stops, targets and liquidations in time order.
//  2. Bar closes: for every timeframe whose bar just closed, each strategy account manages
//     its open trade (time exits, trailing stops) and then asks its rule set for an entry.
//
// Strategy v3: EVERY signal is traded. There is no score, gate, cooldown, lesson or probation
// between a signal and an order. A signal is not opened only when it cannot be:
//   - the account already holds a trade on that coin (one position per coin),
//   - the account is busted (equity under $10),
//   - the price has already passed the signal's stop or target,
//   - the account cannot carry the order (position under the $5 minimum, no free balance).
// Each of those is logged as a "skipped" event with its reason.
//
// A stop tighter than the 0.4% minimum is widened, not rejected (risk.ts planEntry). Risk per
// trade is the owner's setting (bot_settings.risk_pct), the same for every trade.
//
// Signals use closed bars only. A bar is acted on only if the run sees it soon after it
// closed. A bar seen late (after downtime) is logged as missed rather than traded at a stale
// price.

const LOCK_TTL_SECONDS = 170;
const MAX_1M_PAGES = 10; // up to ~7 days of catch-up per run
/** Closed bars a rule set sees: the same window as the backtester. One more is fetched, because the last one is still forming. */
const WINDOW = 600;

export interface TickSummary {
  skipped?: string;
  opened: number;
  closed: number;
  stopMoves: number;
  /** Signals the rule sets produced this run (opened + not opened). */
  signals: number;
  /** Signals that could not be opened, by reason. */
  signalsSkipped: number;
  skippedByReason: Partial<Record<SkipReason, number>>;
  barsEvaluated: number;
  errors: string[];
}

const iso = (ms: number) => new Date(ms).toISOString();
const ms = (s: string) => new Date(s).getTime();
const fmt = (n: number) => +n.toPrecision(8);

/** Freshness window: act on a bar only if we see it within this long after it closed. */
export function freshnessMs(tf: Timeframe) {
  return Math.max(3 * 60_000, 0.1 * TF_SECONDS[tf] * 1000);
}

export async function runTick({ market, db, now = Date.now }: { market: Market; db: Db; now?: () => number }): Promise<TickSummary> {
  const summary: TickSummary = { opened: 0, closed: 0, stopMoves: 0, signals: 0, signalsSkipped: 0, skippedByReason: {}, barsEvaluated: 0, errors: [] };
  if (!(await db.lock(LOCK_TTL_SECONDS))) return { ...summary, skipped: "another run holds the lock" };

  const events: EventRow[] = [];
  const updates = new Map<string, TradeUpdate>();
  const pend = (id: string, u: Omit<TradeUpdate, "id">) => updates.set(id, { ...(updates.get(id) ?? { id }), ...u });
  let fatal: string | null = null;

  const flush = async () => {
    const u = [...updates.values()];
    updates.clear();
    if (u.length) await db.updateTrades(u);
    const e = events.splice(0);
    if (e.length) await db.log(e);
  };

  try {
    await db.sync(strategyMeta(STRATEGIES), TIMEFRAMES);
    const state = await db.getState();
    const accounts: AccountRow[] = state.accounts
      .map((a) => ({ ...a, balance: +a.balance, risk_pct: +a.risk_pct, max_leverage: +a.max_leverage, start_balance: +a.start_balance }))
      // Only accounts of a rule set and timeframe that trade today.
      .filter((a) => {
        const st = STRATEGY_BY_KEY[a.strategy];
        return st != null && (TIMEFRAMES as readonly string[]).includes(a.timeframe) && (!st.timeframes || st.timeframes.includes(a.timeframe as Timeframe));
      });
    const accById = new Map(accounts.map((a) => [a.id, a]));
    const open: TradeRow[] = state.open_trades.map(numTrade);
    const cursors = state.cursors;
    let filters: Record<string, SymbolFilters> | null = null; // qty step / price tick, fetched when first needed
    const getFilters = async (symbol: string) => (filters ??= await market.symbolFilters(SYMBOLS))[symbol] ?? { step: 0.00001, tick: 0.01 };
    if (!accounts.length) return { ...summary, skipped: "no bot accounts (enable bots in the app)" };

    const lastClosedMinute = Math.floor(now() / 60_000) * 60_000 - 60_000;

    // ── 1. Stops, targets, liquidations on 1-minute candles ──
    for (const symbol of SYMBOLS) {
      const trades = () => open.filter((t) => t.symbol === symbol);
      if (!trades().length) continue;
      try {
        let from = Math.min(...trades().map((t) => ms(t.checked_until)));
        for (let page = 0; page < MAX_1M_PAGES && from <= lastClosedMinute && trades().length; page++) {
          const candles = (await market.klines(symbol, "1m", { startTime: from, limit: 1000 })).filter((c) => c.time * 1000 <= lastClosedMinute);
          if (!candles.length) break;
          for (const c of candles) {
            for (const t of trades()) {
              if (c.time * 1000 < ms(t.checked_until)) continue;
              const fill = checkExit({ side: t.side, stop: t.stop_price, takeProfit: t.take_profit, liqPrice: t.liq_price, trailed: t.trailed }, c);
              if (fill) {
                const res = await db.closeTrade({
                  id: t.id,
                  price: fill.price,
                  reason: fill.reason,
                  feeRate: fill.feeRate,
                  at: iso(Math.min(c.time * 1000 + 59_000, now())),
                  note: `${fill.note} (1m candle ${iso(c.time * 1000)}: O ${fmt(c.open)} H ${fmt(c.high)} L ${fmt(c.low)} C ${fmt(c.close)})`,
                });
                removeTrade(open, t.id);
                updates.delete(t.id);
                if (res) {
                  summary.closed++;
                  const acc = accById.get(t.account_id);
                  if (acc) Object.assign(acc, { balance: +res.balance, status: res.status });
                }
                continue;
              }
              const [best, worst] = t.side === "long" ? [c.high, c.low] : [c.low, c.high];
              t.mfe_price = t.mfe_price == null ? best : t.side === "long" ? Math.max(t.mfe_price, best) : Math.min(t.mfe_price, best);
              t.mae_price = t.mae_price == null ? worst : t.side === "long" ? Math.min(t.mae_price, worst) : Math.max(t.mae_price, worst);
              t.checked_until = iso(c.time * 1000 + 60_000);
              pend(t.id, { mfe_price: t.mfe_price, mae_price: t.mae_price, checked_until: t.checked_until });
            }
          }
          from = candles[candles.length - 1].time * 1000 + 60_000;
        }
      } catch (e) {
        recordError(e, `stop check ${symbol}`, { symbol });
      }
    }
    await flush();

    // ── 2. Bar closes: manage open trades, then look for entries ──
    for (const tf of TIMEFRAMES) {
      const tfMs = TF_SECONDS[tf] * 1000;
      const tfAccounts = accounts.filter((a) => a.timeframe === tf);
      if (!tfAccounts.length) continue;
      const lastClosedOpen = Math.floor(now() / tfMs) * tfMs - tfMs;

      for (const symbol of SYMBOLS) {
        const key = `${tf}:${symbol}`;
        if (cursors[key] && ms(cursors[key]) >= lastClosedOpen) continue;
        try {
          const raw = await market.klines(symbol, tf, { limit: WINDOW + 1 });
          const closed = raw.filter((c) => c.time * 1000 + tfMs <= now()).slice(-WINDOW);
          const last = closed[closed.length - 1];
          if (!last || last.time * 1000 < lastClosedOpen) throw new Error(`Binance hasn't published the ${tf} bar at ${iso(lastClosedOpen)} yet`);
          const forming = raw[raw.length - 1];
          const price = forming.time * 1000 + tfMs > now() ? forming.close : last.close;
          const closeTime = last.time * 1000 + tfMs;

          if (now() - closeTime > freshnessMs(tf)) {
            events.push({ kind: "missed_bar", symbol, timeframe: tf, message: `${tf} ${symbol} bar closed ${Math.round((now() - closeTime) / 60_000)} min ago: too late to act on, skipped.` });
          } else {
            summary.barsEvaluated++;
            for (const acc of tfAccounts) {
              try {
                await evaluate(acc, symbol, tf, closed, price);
              } catch (e) {
                recordError(e, `${acc.strategy} ${tf} ${symbol}`, { account_id: acc.id, user_id: acc.user_id, symbol, timeframe: tf });
              }
            }
          }
          await db.setCursor(key, iso(last.time * 1000));
        } catch (e) {
          recordError(e, `bar ${key}`, { symbol, timeframe: tf });
        }
      }
    }

    /** Manages an open trade at a bar close with its rule set. Returns true when the trade was closed. */
    async function manageOpen(acc: AccountRow, strat: StrategyDef, t: TradeRow, symbol: string, tf: Timeframe, closed: Candle[], price: number) {
      const at = now();
      const base = { user_id: acc.user_id, account_id: acc.id, symbol, timeframe: tf };
      const barsHeld = closed.filter((c) => c.time * 1000 > ms(t.signal_bar_time)).length;
      const m = strat.manage(closed, { side: t.side, entryPrice: t.entry_price, stop: t.stop_price, takeProfit: t.take_profit, barsHeld });
      let exit: { reason: string; note: string } | null = null;
      if (m.exit) exit = { reason: m.exit.reason, note: m.exit.note };
      else if (m.stop != null) {
        const f = await getFilters(symbol);
        const stopNote = m.stopNote ?? "trailing stop";
        const ns = tighterStop(t.side, t.stop_price, roundStop(t.side, m.stop, f.tick));
        if (ns != null) {
          const through = t.side === "long" ? ns >= price : ns <= price;
          if (through) exit = { reason: "trailing_stop", note: `New stop ${fmt(ns)} (${stopNote}) is already past the price ${fmt(price)}. Closed at market.` };
          else {
            pend(t.id, { stop_price: ns, trailed: true, stop_event: { at: iso(at), from: t.stop_price, to: ns, note: stopNote } });
            events.push({ ...base, trade_id: t.id, kind: "stop_moved", message: `Stop ${fmt(t.stop_price)} → ${fmt(ns)}: ${stopNote}` });
            t.stop_price = ns;
            t.trailed = true;
            summary.stopMoves++;
          }
        }
      }
      if (!exit) return false;
      const res = await db.closeTrade({ id: t.id, price, reason: exit.reason, feeRate: TAKER_FEE, at: iso(at), note: exit.note });
      removeTrade(open, t.id);
      updates.delete(t.id);
      if (res) {
        summary.closed++;
        Object.assign(acc, { balance: +res.balance, status: res.status });
      }
      return true;
    }

    async function evaluate(acc: AccountRow, symbol: string, tf: Timeframe, closed: Candle[], price: number) {
      const strat = STRATEGY_BY_KEY[acc.strategy];
      if (!strat || closed.length < strat.warmup) return;
      const at = now();
      const signalBar = closed[closed.length - 1];
      const base = { user_id: acc.user_id, account_id: acc.id, symbol, timeframe: tf };

      // Manage the open trade (if any). Still in a trade: no new entry on this coin.
      const t = open.find((x) => x.account_id === acc.id && x.symbol === symbol);
      if (t && !(await manageOpen(acc, strat, t, symbol, tf, closed, price))) return;

      if (!acc.enabled) return;
      const sig = strat.entry(closed);
      if (!sig || "skip" in sig) return;
      summary.signals++;
      const dir = sig.side === "long" ? "Long" : "Short";
      const skip = (reason: SkipReason, why: string) => {
        summary.signalsSkipped++;
        summary.skippedByReason[reason] = (summary.skippedByReason[reason] ?? 0) + 1;
        events.push({ ...base, kind: "skipped", message: `${dir} signal not opened: ${why}`, data: { reason, signal_bar_time: iso(signalBar.time * 1000), indicators: sig.indicators } });
      };

      if (acc.status !== "active") return skip("busted", "the account is busted.");
      const f = await getFilters(symbol);
      const plan = planEntry({ side: sig.side, entry: price, stop: sig.stop, takeProfit: sig.takeProfit, tick: f.tick });
      if ("skip" in plan) return skip("stale", plan.skip);

      const margins = open.filter((x) => x.account_id === acc.id).reduce((s, x) => s + x.margin, 0);
      const equity = acc.balance + margins;
      const sized = sizePosition({
        side: sig.side,
        entry: price,
        stop: plan.stop,
        equity,
        freeBalance: acc.balance,
        stepSize: f.step,
        settings: { riskPct: acc.risk_pct, maxLeverage: acc.max_leverage, slots: SYMBOLS.length },
      });
      if ("skip" in sized) return skip("sizing", sized.skip);

      const order: OpenTradeInput = {
        account_id: acc.id,
        symbol,
        side: sig.side,
        qty: sized.qty,
        entry_price: price,
        leverage: sized.leverage,
        stop_price: plan.stop,
        take_profit: plan.takeProfit,
        risk_usd: sized.riskUsd,
        risk_pct: sized.riskPctActual,
        signal_bar_time: iso(signalBar.time * 1000),
        opened_at: iso(at),
        entry_reason: sig.reason,
        entry_indicators: sig.indicators,
        sizing_notes: [
          ...(plan.note ? [plan.note] : []),
          `Risk ${(acc.risk_pct * 100).toFixed(2)}% of $${equity.toFixed(2)} equity = $${(equity * acc.risk_pct).toFixed(2)}. The stop is ${(sized.stopPct * 100).toFixed(2)}% away, so the size is ${sized.qty} ${symbol.replace(/USDT$/, "")} ($${sized.notional.toFixed(2)} notional).`,
          `Leverage ${sized.leverage}x: the lowest that fits the $${Math.min(equity / SYMBOLS.length, acc.balance).toFixed(2)} margin budget (equity ÷ ${SYMBOLS.length} coins). Liquidation at ${fmt(sized.liqPrice)}, beyond the stop.`,
          ...sized.notes,
        ],
      };
      const res = await db.openTrade(order);
      acc.balance = +res.balance;
      open.push(numTrade(res.trade));
      summary.opened++;
    }
  } catch (e) {
    fatal = e instanceof Error ? e.message : String(e);
  } finally {
    try {
      await flush();
    } catch (e) {
      summary.errors.push(`flush: ${e instanceof Error ? e.message : String(e)}`);
    }
    await db.unlock(fatal ?? (summary.errors.length ? summary.errors.join(" | ").slice(0, 2000) : null), summary);
  }
  if (fatal) summary.errors.unshift(fatal);
  return summary;

  function recordError(e: unknown, where: string, ctx: Partial<EventRow>) {
    const msg = `${where}: ${e instanceof Error ? e.message : String(e)}`;
    summary.errors.push(msg);
    events.push({ ...ctx, kind: "error", message: msg });
  }
}

function numTrade(t: TradeRow): TradeRow {
  return {
    ...t,
    qty: +t.qty,
    entry_price: +t.entry_price,
    margin: +t.margin,
    liq_price: +t.liq_price,
    initial_stop: +t.initial_stop,
    stop_price: +t.stop_price,
    take_profit: t.take_profit == null ? null : +t.take_profit,
    mfe_price: t.mfe_price == null ? null : +t.mfe_price,
    mae_price: t.mae_price == null ? null : +t.mae_price,
    leverage: +t.leverage,
  };
}

function removeTrade(list: TradeRow[], id: string) {
  const i = list.findIndex((t) => t.id === id);
  if (i >= 0) list.splice(i, 1);
}
