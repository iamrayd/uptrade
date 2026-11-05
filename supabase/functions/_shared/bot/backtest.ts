import type { Candle, ExitReason, Side, StrategyDef, Timeframe } from "./types.ts";
import { TF_SECONDS } from "./types.ts";
import { confluence, passesGate } from "./confluence.ts";
import { cooldownUntil, riskMultiplier, type RecentTrade } from "./discipline.ts";
import { checkExit, closeMath, limitFilled, MAKER_FEE, roundStop, sizePosition, TAKER_FEE, tighterStop, toTick, type RiskSettings } from "./risk.ts";

// Replays history through the SAME strategy and risk code the live bot uses.
// Differences from live, all on the conservative side:
//  - Stops/targets are checked on the strategy's own bars, not 1m bars, and when
//    a bar touches both, the stop is assumed to fill first.
//  - Market entries and signal exits fill at the NEXT bar's open (live fills at the
//    price a few seconds after the close, which is about the same).
//
// Costs. Fees are always charged (taker 0.02%, maker 0%). `slippage` adds what a paper
// fill leaves out: every taker fill (market entry, stop, signal or time exit) is moved
// against the trade by that fraction of price. Maker fills (a resting entry limit, a
// take-profit limit) fill at their own price, so they carry no slippage.
//
// Reading the result. `totalR`/`avgR` measure the STRATEGY: R is net PnL over the risk
// planned for that trade, so it does not depend on how big the trade was. `netUsd` and
// `returnPct` measure the ACCOUNT: they also depend on sizing, compounding and, when
// `discipline` is on, the risk cuts and cooldowns. Compare strategies on R with
// discipline off; read dollars for what an account would have done.

export interface BtTrade {
  symbol: string;
  side: Side;
  entryTime: number;
  exitTime: number;
  entry: number;
  exit: number;
  qty: number;
  leverage: number;
  riskUsd: number;
  entryFee: number;
  net: number;
  r: number;
  reason: ExitReason;
  /** The confluence reading at the signal, when the backtest was asked to track it. */
  cf?: { score: number; htf: number | null; checks: Record<string, boolean> };
}

export interface BtResult {
  strategy: string;
  timeframe: string;
  startBalance: number;
  finalEquity: number;
  /** Dollars made or lost by the account (finalEquity − startBalance): depends on sizing and discipline. */
  netUsd: number;
  returnPct: number;
  trades: number;
  winRate: number | null;
  profitFactor: number | null;
  /** Sum of the trades' R: the strategy's result, independent of position size. */
  totalR: number;
  avgR: number | null;
  maxDrawdownPct: number;
  liquidations: number;
  busted: boolean;
  /** Slippage per taker fill the run was charged (fraction of price). */
  slippage: number;
  /** Maker entries whose limit was never traded through, so no trade was opened. */
  unfilledEntries: number;
  /** Fraction of months (calendar, UTC) that ended up, for robustness. */
  positiveMonths: number | null;
  bestMonthPct: number | null;
  worstMonthPct: number | null;
  tradeList: BtTrade[];
  equityCurve: { time: number; equity: number }[];
}

interface Open {
  side: Side;
  entry: number;
  qty: number;
  margin: number;
  entryFee: number;
  liq: number;
  stop: number;
  takeProfit: number | null;
  trailed: boolean;
  riskUsd: number;
  entryTime: number;
  signalBarTime: number;
  cf?: BtTrade["cf"];
}

/**
 * candlesBySymbol: closed bars of ONE timeframe, ascending, same timestamps across symbols.
 * from: only trade bars at/after this time (earlier bars are indicator warm-up).
 */
export function backtest(a: {
  strategy: StrategyDef;
  timeframe: string;
  candlesBySymbol: Record<string, Candle[]>;
  filters: Record<string, { step: number; tick: number }>;
  settings: RiskSettings;
  startBalance: number;
  from: number;
  /** Skip signals whose confluence score (0–100) is below this. Omit to trade every signal, as before. */
  minConfluence?: number;
  /** Record the confluence reading of every trade (for analysis), even when no gate is applied. */
  trackConfluence?: boolean;
  /** Apply the live bot's discipline for this timeframe: cool down after losses and trade smaller while the account is down. */
  discipline?: boolean;
  /** Extra cost on every taker fill, as a fraction of price (0.0005 = 0.05% per side). Default 0. */
  slippage?: number;
  /**
   * Enter with a limit order resting at the signal bar's close (maker fee, no slippage) instead
   * of a market order at the next open. The entry happens only if price trades through the
   * limit: within the next bar (`true`), or, with finer `candles`, within `timeoutSec` of the
   * signal bar's close, which is how the live bot cancels an unfilled order. The live bot places
   * the order a few seconds after the close and only counts candles that start after that, so
   * `delaySec` (60 matches live) leaves out fine candles starting before close + delaySec.
   */
  makerEntry?: boolean | { candles: Record<string, Candle[]>; timeoutSec: number; delaySec?: number };
}): BtResult {
  const { strategy, candlesBySymbol, settings } = a;
  const slip = a.slippage ?? 0;
  const symbols = Object.keys(candlesBySymbol);
  let balance = a.startBalance;
  let busted = false;
  let unfilledEntries = 0;
  const open = new Map<string, Open>();
  const pendingExit = new Map<string, string>();
  const pendingEntry = new Map<string, { side: Side; limit: number; stop: number; takeProfit: number | null; signalBarTime: number; cf?: BtTrade["cf"] }>();
  const trades: BtTrade[] = [];
  const curve: { time: number; equity: number }[] = [];
  let liquidations = 0;
  const recent: RecentTrade[] = [];
  const tfSec = TF_SECONDS[a.timeframe as Timeframe] ?? 3600;
  const tfMs = tfSec * 1000;

  // Index bars by time per symbol.
  const times = [...new Set(symbols.flatMap((s) => candlesBySymbol[s].map((c) => c.time)))].sort((x, y) => x - y);
  const idx: Record<string, Map<number, number>> = {};
  for (const s of symbols) idx[s] = new Map(candlesBySymbol[s].map((c, i) => [c.time, i]));

  const tick = (sym: string) => a.filters[sym]?.tick ?? 0;
  const equityNow = () => balance + [...open.values()].reduce((s, o) => s + o.margin, 0);
  /** A taker fill, moved against the trade by the slippage. `dir` +1: buying, −1: selling. */
  const slipped = (price: number, dir: 1 | -1) => price * (1 + dir * slip);
  /** The direction of the order that closes a position on this side. */
  const closeDir = (side: Side): 1 | -1 => (side === "long" ? -1 : 1);

  /** True when a maker entry resting at `limit` since the open of bar `c` gets filled. */
  const fine = typeof a.makerEntry === "object" ? a.makerEntry : null;
  const fineCursor: Record<string, number> = {};
  function makerFilled(sym: string, side: Side, limit: number, c: Candle) {
    if (!fine) return limitFilled(side, limit, c);
    const list = fine.candles[sym] ?? [];
    let j = fineCursor[sym] ?? 0;
    while (j < list.length && list[j].time < c.time + (fine.delaySec ?? 0)) j++;
    fineCursor[sym] = j;
    for (let k = j; k < list.length && list[k].time < c.time + fine.timeoutSec; k++) if (limitFilled(side, limit, list[k])) return true;
    return false;
  }

  function close(sym: string, o: Open, price: number, reason: ExitReason, feeRate: number, time: number) {
    // Maker fills (the target limit) and liquidations fill at their own price; everything else is a taker fill.
    const exit = reason === "liquidation" ? o.liq : feeRate === MAKER_FEE ? price : slipped(price, closeDir(o.side));
    const { pnl, fee } = closeMath({ side: o.side, entry: o.entry, exit, qty: o.qty, margin: o.margin, feeRate, liquidation: reason === "liquidation" });
    balance += o.margin + pnl - fee;
    const net = pnl - o.entryFee - fee;
    trades.push({
      symbol: sym, side: o.side, entryTime: o.entryTime, exitTime: time, entry: o.entry,
      exit, qty: o.qty, leverage: Math.round((o.qty * o.entry) / o.margin),
      riskUsd: o.riskUsd, entryFee: o.entryFee, net, r: o.riskUsd > 0 ? net / o.riskUsd : 0, reason, cf: o.cf,
    });
    if (reason === "liquidation") liquidations++;
    recent.push({ symbol: sym, r: o.riskUsd > 0 ? net / o.riskUsd : 0, closed_at: new Date(time * 1000).toISOString() });
    open.delete(sym);
    if (equityNow() < 10) busted = true;
  }

  for (const t of times) {
    for (const sym of symbols) {
      const i = idx[sym].get(t);
      if (i == null) continue;
      const all = candlesBySymbol[sym];
      const c = all[i];

      // 1) Orders queued at the previous close fill at this bar's open (a maker entry: at its limit, if reached).
      const o0 = open.get(sym);
      const pe = pendingExit.get(sym);
      if (o0 && pe) close(sym, o0, c.open, pe as ExitReason, TAKER_FEE, c.time);
      pendingExit.delete(sym);
      const pn = pendingEntry.get(sym);
      pendingEntry.delete(sym);
      if (pn && !open.has(sym) && !busted) {
        const maker = !!a.makerEntry;
        const entry = maker ? pn.limit : slipped(c.open, pn.side === "long" ? 1 : -1);
        const okSide = pn.side === "long" ? pn.stop < entry : pn.stop > entry;
        const okTp = pn.takeProfit == null || (pn.side === "long" ? pn.takeProfit > entry : pn.takeProfit < entry);
        if (maker && okSide && okTp && !makerFilled(sym, pn.side, pn.limit, c)) unfilledEntries++;
        else if (okSide && okTp) {
          const eq = equityNow();
          const mult = a.discipline ? riskMultiplier({ equity: eq, startBalance: a.startBalance, recent, timeframe: a.timeframe }).mult : 1;
          const sz = sizePosition({
            side: pn.side, entry, stop: pn.stop, equity: eq, freeBalance: balance, stepSize: a.filters[sym]?.step ?? 0.00001,
            settings: { ...settings, riskPct: settings.riskPct * mult }, entryFeeRate: maker ? MAKER_FEE : TAKER_FEE,
          });
          if (!("skip" in sz)) {
            balance -= sz.margin + sz.entryFee;
            open.set(sym, {
              side: pn.side, entry, qty: sz.qty, margin: sz.margin, entryFee: sz.entryFee, liq: sz.liqPrice,
              stop: pn.stop, takeProfit: pn.takeProfit, trailed: false, riskUsd: sz.riskUsd, entryTime: c.time, signalBarTime: pn.signalBarTime, cf: pn.cf,
            });
          }
        }
      }

      // 2) Stops / targets / liquidation inside this bar.
      const o = open.get(sym);
      if (o) {
        const f = checkExit({ side: o.side, stop: o.stop, takeProfit: o.takeProfit, liqPrice: o.liq, trailed: o.trailed }, c);
        if (f) close(sym, o, f.price, f.reason, f.feeRate, c.time);
      }

      // 3) At the close: manage, then look for an entry (both act at the next open).
      if (t < a.from || i + 1 < strategy.warmup) continue;
      const hist = all.slice(Math.max(0, i + 1 - 600), i + 1); // same window size as live
      const o2 = open.get(sym);
      let flat = !o2;
      if (o2) {
        const barsHeld = hist.filter((x) => x.time > o2.signalBarTime).length;
        const m = strategy.manage(hist, { side: o2.side, entryPrice: o2.entry, stop: o2.stop, takeProfit: o2.takeProfit, barsHeld });
        if (m.exit) {
          pendingExit.set(sym, m.exit.reason);
          flat = true;
        } else {
          const ns = tighterStop(o2.side, o2.stop, m.stop == null ? undefined : roundStop(o2.side, m.stop, tick(sym)));
          if (ns != null) {
            if (o2.side === "long" ? ns >= c.close : ns <= c.close) {
              pendingExit.set(sym, "trailing_stop");
              flat = true;
            } else {
              o2.stop = ns;
              o2.trailed = true;
            }
          }
        }
      }
      if (flat && !busted) {
        const sig = strategy.entry(hist);
        const cool = a.discipline ? cooldownUntil(recent, sym, tfMs, a.timeframe) : null;
        const cooling = cool != null && cool.until > t * 1000;
        const live = sig && !("skip" in sig) ? sig : null;
        const stop = live ? roundStop(live.side, live.stop, tick(sym)) : 0;
        const cf = live && (a.minConfluence != null || a.trackConfluence) ? confluence({ strategy: strategy.key, timeframe: a.timeframe as Timeframe, side: live.side, candles: hist, entry: c.close, stop }) : null;
        const agrees = cf == null || a.minConfluence == null || passesGate(cf, a.minConfluence);
        if (live && agrees && !cooling)
          pendingEntry.set(sym, {
            side: live.side,
            limit: c.close,
            stop,
            takeProfit: live.takeProfit == null ? null : toTick(live.takeProfit, tick(sym), "nearest"),
            signalBarTime: c.time,
            cf: cf ? { score: cf.score, htf: cf.htf, checks: Object.fromEntries(cf.checks.map((k) => [k.key, k.pass])) } : undefined,
          });
      }
    }

    // Mark-to-market equity at this bar's close.
    let eq = balance;
    for (const [sym, o] of open) {
      const i = idx[sym].get(t);
      const px = i == null ? o.entry : candlesBySymbol[sym][i].close;
      eq += Math.max(0, o.margin + (o.side === "long" ? px - o.entry : o.entry - px) * o.qty);
    }
    if (t >= a.from) curve.push({ time: t, equity: eq });
  }

  // Close anything still open at the last close (taker), so results are realized.
  for (const [sym, o] of [...open]) {
    const last = candlesBySymbol[sym][candlesBySymbol[sym].length - 1];
    close(sym, o, last.close, "signal", TAKER_FEE, last.time);
  }

  const finalEquity = balance;
  const wins = trades.filter((x) => x.net > 0);
  const grossWin = wins.reduce((s, x) => s + x.net, 0);
  const grossLoss = -trades.filter((x) => x.net <= 0).reduce((s, x) => s + x.net, 0);
  let peak = a.startBalance;
  let maxDd = 0;
  for (const p of curve) {
    peak = Math.max(peak, p.equity);
    maxDd = Math.max(maxDd, peak > 0 ? (peak - p.equity) / peak : 0);
  }
  const months = monthlyReturns(curve, a.startBalance);
  const totalR = trades.reduce((s, x) => s + x.r, 0);

  return {
    strategy: strategy.key,
    timeframe: a.timeframe,
    startBalance: a.startBalance,
    finalEquity,
    netUsd: finalEquity - a.startBalance,
    returnPct: ((finalEquity - a.startBalance) / a.startBalance) * 100,
    trades: trades.length,
    winRate: trades.length ? (wins.length / trades.length) * 100 : null,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
    totalR,
    avgR: trades.length ? totalR / trades.length : null,
    maxDrawdownPct: maxDd * 100,
    liquidations,
    busted,
    slippage: slip,
    unfilledEntries,
    positiveMonths: months.length ? months.filter((m) => m > 0).length / months.length : null,
    bestMonthPct: months.length ? Math.max(...months) : null,
    worstMonthPct: months.length ? Math.min(...months) : null,
    tradeList: trades,
    equityCurve: curve,
  };
}

/** Calendar-month returns (%) from an equity curve. */
export function monthlyReturns(curve: { time: number; equity: number }[], start: number) {
  const out: number[] = [];
  let month = "";
  let open = start;
  let last = start;
  for (const p of curve) {
    const m = new Date(p.time * 1000).toISOString().slice(0, 7);
    if (m !== month) {
      if (month) out.push(((last - open) / open) * 100);
      month = m;
      open = last;
    }
    last = p.equity;
  }
  if (month) out.push(((last - open) / open) * 100);
  return out.filter(Number.isFinite);
}
