import type { Candle, Timeframe } from "./types.ts";
import { SYMBOLS, TF_SECONDS, TIMEFRAMES } from "./types.ts";
import { STRATEGIES, STRATEGY_BY_KEY } from "./strategies.ts";
import { breakevenStop, checkExit, reachedR, roundStop, sizePosition, TAKER_FEE, tighterStop, toTick } from "./risk.ts";
import { entryFeatures, ruleBlocks } from "./analysis.ts";
import { CONFLUENCE, confluence, passesGate } from "./confluence.ts";
import { convictionMult, cooldownUntil, riskMultiplier } from "./discipline.ts";
import { newsFor, newsGate, newsReadings } from "./news.ts";
import type { AccountRow, Db, EventRow, FilteredSignalInput, LessonRow, Market, SkipReason, SymbolFilters, TradeRow, TradeUpdate } from "./io.ts";

// One bot run. Called every minute by pg_cron → bot-tick edge function.
//
//  1. Stops & targets: replay the closed 1-minute candles since each open
//     trade was last checked, and fill stops, targets and liquidations in time order.
//  2. Bar closes: for every timeframe whose bar just closed, each strategy
//     account manages its open trade (signal exits, trailing stops) and then
//     looks for a new entry. A signal becomes a trade only after passing, in order:
//       - the confluence gate (most confirming indicators must agree, confluence.ts),
//       - the news gate ("+ News" variants only, news.ts),
//       - the cooldown after a loss (discipline.ts),
//       - the active lessons learned from past losers (analysis.ts).
//     It is then sized with risk scaled down while the account is losing, and fills at
//     the current price.
//
// A signal that is not traded is never thrown away: it is stored with the reason and
// replayed later by bot-analyze, so a busted or heavily filtered bot keeps learning.
// Gates run before lessons so a lesson is only credited with entries that would
// otherwise have been traded.
//
// Signals use closed bars only. A bar is acted on only if the run sees it soon
// after it closed. A signal seen late (after downtime) is logged as missed rather
// than traded at a stale price.

const LOCK_TTL_SECONDS = 170;
const MAX_1M_PAGES = 10; // up to ~7 days of catch-up per run
const KLINE_LIMIT = 600;

export interface TickSummary {
  skipped?: string;
  opened: number;
  closed: number;
  stopMoves: number;
  signalsSkipped: number;
  /** Signals not traded because of a gate, a cooldown, a lesson or a busted account (all kept for replay). */
  signalsFiltered: number;
  /** The same, by reason. */
  filteredByReason: Partial<Record<SkipReason, number>>;
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

export async function runTick({
  market,
  db,
  now = Date.now,
  minConfluence = CONFLUENCE.minScore,
}: {
  market: Market;
  db: Db;
  now?: () => number;
  /** Entries scoring below this (0–100) are not traded. Tests lower it to 0 to exercise the rest of the engine. */
  minConfluence?: number;
}): Promise<TickSummary> {
  const summary: TickSummary = { opened: 0, closed: 0, stopMoves: 0, signalsSkipped: 0, signalsFiltered: 0, filteredByReason: {}, barsEvaluated: 0, errors: [] };
  if (!(await db.lock(LOCK_TTL_SECONDS))) return { ...summary, skipped: "another run holds the lock" };

  const events: EventRow[] = [];
  const filtered: FilteredSignalInput[] = [];
  const updates = new Map<string, TradeUpdate>();
  const pend = (id: string, u: Omit<TradeUpdate, "id">) => updates.set(id, { ...(updates.get(id) ?? { id }), ...u });
  let fatal: string | null = null;

  const flush = async () => {
    const u = [...updates.values()];
    updates.clear();
    if (u.length) await db.updateTrades(u);
    const e = events.splice(0);
    if (e.length) await db.log(e);
    const f = filtered.splice(0);
    if (f.length) await db.logFiltered(f);
  };

  try {
    await db.sync(
      STRATEGIES.map(({ key, name, version, summary, rules, params }) => ({ key, name, version, summary, rules, params })),
      TIMEFRAMES,
    );
    const state = await db.getState();
    const accounts: AccountRow[] = state.accounts.map((a) => ({
      ...a,
      balance: +a.balance,
      risk_pct: +a.risk_pct,
      max_leverage: +a.max_leverage,
      start_balance: +a.start_balance,
      recent: (a.recent ?? []).map((t) => ({ ...t, r: t.r == null ? null : +t.r })),
    }));
    const news = state.news ?? null;
    const accById = new Map(accounts.map((a) => [a.id, a]));
    const open: TradeRow[] = state.open_trades.map(numTrade);
    const cursors = state.cursors;
    const lessons: LessonRow[] = state.lessons ?? [];
    let filters: Record<string, SymbolFilters> | null = null; // qty step / price tick, fetched when first needed
    const getFilters = async (symbol: string) => (filters ??= await market.symbolFilters(SYMBOLS))[symbol] ?? { step: 0.00001, tick: 0.01 };
    if (!accounts.length) return { ...summary, skipped: "no bot accounts (enable bots in the app)" };

    // ── 1. Stops, targets, liquidations on 1-minute candles ──
    const lastClosedMinute = Math.floor(now() / 60_000) * 60_000 - 60_000;
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
              const fill = checkExit(
                { side: t.side, stop: t.stop_price, takeProfit: t.take_profit, liqPrice: t.liq_price, trailed: t.trailed },
                c,
              );
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
                  if (acc) noteClosed(acc, t.symbol, res);
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
          const raw = await market.klines(symbol, tf, { limit: KLINE_LIMIT });
          const closed = raw.filter((c) => c.time * 1000 + tfMs <= now());
          const last = closed[closed.length - 1];
          if (!last || last.time * 1000 < lastClosedOpen) throw new Error(`Binance hasn't published the ${tf} bar at ${iso(lastClosedOpen)} yet`);
          const forming = raw[raw.length - 1];
          const price = forming.time * 1000 + tfMs > now() ? forming.close : last.close;
          const closeTime = last.time * 1000 + tfMs;

          if (now() - closeTime > freshnessMs(tf)) {
            events.push({
              kind: "missed_bar",
              symbol,
              timeframe: tf,
              message: `${tf} ${symbol} bar closed ${Math.round((now() - closeTime) / 60_000)} min ago: too late to act on, skipped.`,
            });
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

    async function evaluate(acc: AccountRow, symbol: string, tf: Timeframe, closed: Candle[], price: number) {
      const strat = STRATEGY_BY_KEY[acc.strategy];
      if (!strat || closed.length < strat.warmup) return;
      const at = now();
      const signalBar = closed[closed.length - 1];
      const base = { user_id: acc.user_id, account_id: acc.id, symbol, timeframe: tf };

      // Manage the open trade (if any).
      const t = open.find((x) => x.account_id === acc.id && x.symbol === symbol);
      if (t) {
        const barsHeld = closed.filter((c) => c.time * 1000 > ms(t.signal_bar_time)).length;
        const m = strat.manage(closed, { side: t.side, entryPrice: t.entry_price, stop: t.stop_price, takeProfit: t.take_profit, barsHeld });
        let exit: { reason: string; note: string; feeRate: number } | null = null;
        if (m.exit) exit = { reason: m.exit.reason, note: m.exit.note, feeRate: TAKER_FEE };
        else {
          const f = await getFilters(symbol);
          // The breakeven rule (stop to fee cover once the trade has been +1R, per-setup flag from the
          // analyzer) competes with the strategy's own trailing stop; the tighter proposal wins.
          let proposed = m.stop ?? undefined;
          let stopNote = m.stopNote ?? "trailing stop";
          if (acc.breakeven && reachedR(t.side, t.entry_price, t.initial_stop, t.mfe_price)) {
            const be = breakevenStop(t.side, t.entry_price);
            if (proposed == null || (t.side === "long" ? be > proposed : be < proposed)) {
              proposed = be;
              stopNote = "breakeven stop: the trade reached +1R, so the stop moves to fee cover";
            }
          }
          const ns = tighterStop(t.side, t.stop_price, proposed == null ? undefined : roundStop(t.side, proposed, f.tick));
          if (ns != null) {
            const through = t.side === "long" ? ns >= price : ns <= price;
            if (through)
              exit = { reason: "trailing_stop", note: `New stop ${fmt(ns)} (${stopNote}) is already past the price ${fmt(price)}. Closed at market.`, feeRate: TAKER_FEE };
            else {
              pend(t.id, {
                stop_price: ns,
                trailed: true,
                stop_event: { at: iso(at), from: t.stop_price, to: ns, note: stopNote },
              });
              events.push({ ...base, trade_id: t.id, kind: "stop_moved", message: `Stop ${fmt(t.stop_price)} → ${fmt(ns)}: ${stopNote}` });
              t.stop_price = ns;
              t.trailed = true;
              summary.stopMoves++;
            }
          }
        }
        if (exit) {
          const res = await db.closeTrade({ id: t.id, price, reason: exit.reason, feeRate: exit.feeRate, at: iso(at), note: exit.note });
          removeTrade(open, t.id);
          updates.delete(t.id);
          if (res) {
            summary.closed++;
            noteClosed(acc, symbol, res);
          }
        } else return; // still in a trade: no new entry on this symbol
      }

      if (!acc.enabled) return;
      const sig = strat.entry(closed);
      if (!sig) return;
      if ("skip" in sig) {
        summary.signalsSkipped++;
        events.push({ ...base, kind: "skipped", message: sig.skip });
        return;
      }
      const dir = sig.side === "long" ? "Long" : "Short";
      const skip = (why: string) => {
        summary.signalsSkipped++;
        events.push({ ...base, kind: "skipped", message: `${dir} signal not taken: ${why}`, data: { indicators: sig.indicators } });
      };
      const f = await getFilters(symbol);
      sig.stop = roundStop(sig.side, sig.stop, f.tick);
      if (sig.takeProfit != null) sig.takeProfit = toTick(sig.takeProfit, f.tick, "nearest");
      if (sig.side === "long" ? sig.stop >= price : sig.stop <= price) return skip(`price ${fmt(price)} already moved through the stop ${fmt(sig.stop)}.`);
      if (sig.takeProfit != null && (sig.side === "long" ? price >= sig.takeProfit : price <= sig.takeProfit))
        return skip(`price ${fmt(price)} already reached the target ${fmt(sig.takeProfit)}.`);

      // What the market says besides the strategy's own trigger. The readings are stored with the
      // trade (and with a skipped signal), so the learner can test whether they matter.
      const cf = confluence({ strategy: acc.strategy, timeframe: tf, side: sig.side, candles: closed, entry: price, stop: sig.stop });
      const nr = newsFor(news, symbol, at);
      // The threshold this setup is judged against: its own learned bar, or the global default.
      const minCf = acc.min_confluence ?? minConfluence;
      sig.indicators = { ...sig.indicators, ...cf.readings, cfMin: minCf, ...newsReadings(nr) };
      const features = entryFeatures({ side: sig.side, entry: price, stop: sig.stop, symbol, at, indicators: sig.indicators, strategy: acc.strategy });

      // A signal that is not traded is kept, with the reason, for bot-analyze to replay.
      const shadow = (reason: SkipReason, why: string, lessonIds: string[] = []) => {
        summary.signalsFiltered++;
        summary.filteredByReason[reason] = (summary.filteredByReason[reason] ?? 0) + 1;
        filtered.push({
          account_id: acc.id,
          reason,
          lesson_ids: lessonIds,
          symbol,
          side: sig.side,
          entry_price: price,
          stop_price: sig.stop,
          take_profit: sig.takeProfit,
          signal_bar_time: iso(signalBar.time * 1000),
          features,
        });
        events.push({ ...base, kind: "skipped", message: `${dir} signal not taken: ${why}`, data: { reason, lesson_ids: lessonIds, indicators: sig.indicators } });
      };

      if (acc.status !== "active") return shadow("busted", "the account is busted, so this signal is only replayed for learning.");
      if (!passesGate(cf, minCf)) return shadow("confluence", `${cf.summary} Needs ${minCf}.`);
      let newsNote = "";
      if (strat.newsAware) {
        const g = newsGate(nr, sig.side);
        if (g.block) return shadow("news", g.reason);
        newsNote = ` ${g.reason}`;
      }
      const cool = cooldownUntil(acc.recent, symbol, TF_SECONDS[tf] * 1000);
      if (cool && cool.until > at) return shadow("cooldown", `cooling down after ${cool.why} (until ${iso(cool.until)}).`);

      // Lessons learned from past losers (see analysis.ts). The blocked signal is replayed later
      // so lessons that would have cost money get retired.
      const blockers = lessons.filter(
        (l) => l.user_id === acc.user_id && l.strategy === acc.strategy && (l.timeframe == null || l.timeframe === tf) && ruleBlocks(l, features),
      );
      if (blockers.length)
        return shadow("lesson", `lesson "${blockers[0].title}"${blockers.length > 1 ? ` (+${blockers.length - 1} more)` : ""}.`, blockers.map((l) => l.id));

      // Probation runs after the other gates, so its replays measure the entries that would
      // really have been traded. The setup keeps learning at zero capital until promoted.
      if (acc.probation) return shadow("probation", "the setup is on probation (shadow-only until its replayed entries prove an edge).");

      // Conviction-weighted sizing (per-setup flag; the analyzer reverts it if it costs money).
      const conv = acc.conviction ? convictionMult({ cfScore: cf.score, verdict: acc.verdict }) : { mult: 1, note: null };
      sig.indicators.convMult = conv.mult;

      const margins = open.filter((x) => x.account_id === acc.id).reduce((s, x) => s + x.margin, 0);
      const equity = acc.balance + margins;
      const risk = riskMultiplier({ equity, startBalance: acc.start_balance, recent: acc.recent });
      const riskPct = acc.risk_pct * risk.mult * conv.mult;
      const sized = sizePosition({
        side: sig.side,
        entry: price,
        stop: sig.stop,
        equity,
        freeBalance: acc.balance,
        stepSize: f.step,
        settings: { riskPct, maxLeverage: acc.max_leverage, slots: SYMBOLS.length },
      });
      // Sizing and minimum-stop rejections are kept as shadow signals too: the learner replays
      // them, so the 0.4% minimum stop and the sizing caps are judged on data, not assumed.
      if ("skip" in sized) return shadow("min_stop", sized.skip);

      const notes = [
        ...(risk.note ? [risk.note] : []),
        ...(conv.note ? [conv.note] : []),
        `Risk ${(riskPct * 100).toFixed(2)}% of $${equity.toFixed(2)} equity = $${(equity * riskPct).toFixed(2)}. The stop is ${(sized.stopPct * 100).toFixed(2)}% away, so the size is ${sized.qty} ${symbol.replace(/USDT$/, "")} ($${sized.notional.toFixed(2)} notional).`,
        `Leverage ${sized.leverage}x: the lowest that fits the $${Math.min(equity / SYMBOLS.length, acc.balance).toFixed(2)} margin budget (equity ÷ ${SYMBOLS.length} coins). Liquidation at ${fmt(sized.liqPrice)}, beyond the stop.`,
        ...sized.notes,
      ];
      const res = await db.openTrade({
        account_id: acc.id,
        symbol,
        side: sig.side,
        qty: sized.qty,
        entry_price: price,
        leverage: sized.leverage,
        stop_price: sig.stop,
        take_profit: sig.takeProfit,
        risk_usd: sized.riskUsd,
        risk_pct: sized.riskPctActual,
        signal_bar_time: iso(signalBar.time * 1000),
        opened_at: iso(at),
        entry_reason: `${sig.reason} ${cf.summary}${newsNote}`,
        entry_indicators: sig.indicators,
        sizing_notes: notes,
      });
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

/** Books a close on the in-memory account, so later signals in this run see the new balance and the loss. */
function noteClosed(acc: AccountRow, symbol: string, res: { trade: { r_multiple: number | null; closed_at: string }; balance: number; status: "active" | "busted" }) {
  Object.assign(acc, { balance: +res.balance, status: res.status });
  acc.recent = [...acc.recent, { symbol, r: res.trade.r_multiple == null ? null : +res.trade.r_multiple, closed_at: res.trade.closed_at }].slice(-10);
}

function removeTrade(list: TradeRow[], id: string) {
  const i = list.findIndex((t) => t.id === id);
  if (i >= 0) list.splice(i, 1);
}

