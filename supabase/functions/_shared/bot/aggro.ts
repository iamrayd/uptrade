import type { Candle, ExitReason, Side, StrategyDef, Timeframe } from "./types.ts";
import { TF_SECONDS } from "./types.ts";
import { atr, dmi, ema } from "./indicators.ts";
import { confluence, type Confluence } from "./confluence.ts";
import { entryFeatures, replayBars, sessionOf, simulateSignal, SLIPPAGE, type FeatureValue } from "./analysis.ts";
import { checkExit, closeMath, MAKER_FEE, roundStop, sizePosition, TAKER_FEE, tighterStop, toTick } from "./risk.ts";
import { STRATEGY_BY_KEY } from "./strategies.ts";
import { AGGRO_KEY, autopsy, dayGuard, estimate, learn, newPlaybook, riskFor, rollDay, type Estimate, type Facets, type LifeRecord, type LifeTrade, type Outcome, type Playbook } from "./playbook.ts";

// The aggressive accounts' view of the market: every signal of every rule set in the pool,
// each with its context (playbook.ts Facets). The live engine (tick.ts) and the replay below
// build their candidates here, so what the playbook learns offline is what it sees live.

export const isAggro = (strategy: string) => strategy === AGGRO_KEY;

/** The rule sets an aggressive account chooses among. */
export const aggroPool = (): StrategyDef[] => (STRATEGY_BY_KEY[AGGRO_KEY]?.pool ?? []).map((k) => STRATEGY_BY_KEY[k]).filter(Boolean);

/** Market regime on the last closed bar: the same for every signal on that bar. */
export function regime(c: Candle[]): { vol: Facets["vol"]; adx: Facets["adx"]; ema200: number | null } {
  const i = c.length - 1;
  const a = atr(c, 14);
  let vol: Facets["vol"] = "na";
  const past = a.slice(Math.max(0, i - 100), i).filter((x): x is number => x != null && x > 0);
  if (a[i] != null && past.length >= 50) {
    const ratio = a[i]! / (past.reduce((s, x) => s + x, 0) / past.length);
    vol = ratio > 1.25 ? "wild" : ratio < 0.8 ? "calm" : "normal";
  }
  const x = dmi(c, 14).adx[i];
  const adx: Facets["adx"] = x == null ? "na" : x >= 25 ? "trend" : x < 20 ? "range" : "mid";
  return { vol, adx, ema200: ema(c.map((k) => k.close), 200)[i] ?? null };
}

export interface Candidate {
  strategy: StrategyDef;
  side: Side;
  stop: number;
  takeProfit: number | null;
  reason: string;
  indicators: Record<string, number>;
  cf: Confluence;
  facets: Facets;
  /** Entry features with the context in them, as stored with a shadow signal. */
  features: Record<string, FeatureValue>;
}

/**
 * Every tradable signal of the pool on the last closed bar. `entry` is the price the trade
 * would be entered at; a signal whose stop or target is already on the wrong side of it is dropped.
 */
export function aggroCandidates(a: { candles: Candle[]; timeframe: Timeframe; symbol: string; at: number; tick: number; entry: number; pool?: StrategyDef[] }): Candidate[] {
  const out: Candidate[] = [];
  let reg: ReturnType<typeof regime> | null = null;
  for (const strategy of a.pool ?? aggroPool()) {
    if (a.candles.length < strategy.warmup) continue;
    const sig = strategy.entry(a.candles);
    if (!sig || "skip" in sig) continue;
    const stop = roundStop(sig.side, sig.stop, a.tick);
    const takeProfit = sig.takeProfit == null ? null : toTick(sig.takeProfit, a.tick, "nearest");
    if (sig.side === "long" ? stop >= a.entry : stop <= a.entry) continue;
    if (takeProfit != null && (sig.side === "long" ? a.entry >= takeProfit : a.entry <= takeProfit)) continue;
    reg ??= regime(a.candles);
    const cf = confluence({ strategy: strategy.key, timeframe: a.timeframe, side: sig.side, candles: a.candles, entry: a.entry, stop });
    const s = sig.side === "long" ? 1 : -1;
    const facets: Facets = {
      src: strategy.key,
      side: sig.side,
      sym: a.symbol,
      htf: cf.htf == null ? "na" : cf.htf > 0 ? "with" : cf.htf < 0 ? "against" : "mixed",
      cf: cf.score >= 80 ? "hi" : cf.score >= 50 ? "mid" : "lo",
      vol: reg.vol,
      adx: reg.adx,
      ema: reg.ema200 == null ? "na" : s * (a.candles[a.candles.length - 1].close - reg.ema200) > 0 ? "with" : "against",
      ses: sessionOf(a.at),
    };
    const indicators = { ...sig.indicators, ...cf.readings };
    out.push({
      strategy,
      side: sig.side,
      stop,
      takeProfit,
      reason: sig.reason,
      indicators,
      cf,
      facets,
      features: facetFeatures(entryFeatures({ side: sig.side, entry: a.entry, stop, symbol: a.symbol, at: a.at, indicators, strategy: strategy.key }), facets),
    });
  }
  return out;
}

/** Entry features plus the context, flat, the way a shadow signal stores them. */
export function facetFeatures(features: Record<string, FeatureValue>, f: Facets): Record<string, FeatureValue> {
  return { ...features, src: f.src, side: f.side, symbol: f.sym, session: f.ses, pb_htf: f.htf, pb_cf: f.cf, pb_vol: f.vol, pb_adx: f.adx, pb_ema: f.ema };
}

/** The context back out of a shadow signal's stored features; null when it is not an aggressive account's signal. */
export function facetsOf(f: Record<string, unknown> | null | undefined): Facets | null {
  if (!f || typeof f.src !== "string" || typeof f.pb_cf !== "string") return null;
  const str = (v: unknown, d: string) => (typeof v === "string" ? v : d);
  return {
    src: f.src,
    side: f.side === "short" ? "short" : "long",
    sym: str(f.symbol, ""),
    htf: str(f.pb_htf, "na") as Facets["htf"],
    cf: f.pb_cf as Facets["cf"],
    vol: str(f.pb_vol, "na") as Facets["vol"],
    adx: str(f.pb_adx, "na") as Facets["adx"],
    ema: str(f.pb_ema, "na") as Facets["ema"],
    ses: str(f.session, ""),
  };
}

/** R of a closed trade after SLIPPAGE on both fills: the same basis a replayed signal is scored on. */
export function learnedR(t: { r_multiple: number | null; qty: number; entry_price: number; exit_price: number | null; risk_usd: number }): number | null {
  if (t.r_multiple == null || !Number.isFinite(+t.r_multiple)) return null;
  if (!(+t.risk_usd > 0) || t.exit_price == null) return +t.r_multiple;
  return +t.r_multiple - (SLIPPAGE * +t.qty * (+t.entry_price + +t.exit_price)) / +t.risk_usd;
}

export type Rated = { c: Candidate; est: Estimate; risk: { pct: number; why: string } };

/** The candidates with the playbook's estimate and bet size, best expectation first. */
export function rate(pb: Playbook, cands: Candidate[]): Rated[] {
  return cands
    .map((c) => {
      const est = estimate(pb, c.facets);
      return { c, est, risk: riskFor(est) };
    })
    .sort((x, y) => y.est.exp - x.est.exp);
}

// ───────────────────────── Replay ─────────────────────────
//
// Replays history through the same candidates, playbook and risk code as the live engine, with
// the playbook learning as it goes (it only ever knows outcomes that had already happened), so
// the result is out-of-sample throughout. Like backtest.ts: entries and signal exits fill at
// the next bar's open with slippage, stops and targets on the timeframe's own bars (stop first).
// A busted life is post-mortemed and the next one starts at the starting balance at once (live,
// the owner has to click Redeploy).

export interface AggroReplayTrade {
  life: number;
  symbol: string;
  src: string;
  side: Side;
  entryTime: number;
  exitTime: number;
  riskPct: number;
  exp: number;
  net: number;
  r: number;
  reason: ExitReason;
}

export interface AggroReplayResult {
  timeframe: string;
  lives: LifeRecord[];
  /** Lives started (the last one may still be alive). */
  livesUsed: number;
  /** Equity of the life still running at the end. */
  finalEquity: number;
  trades: AggroReplayTrade[];
  /** Every signal seen, with the outcome it had on its own (traded or not) and the playbook's estimate at the time. */
  signals: { time: number; src: string; exp: number; raw: number; r: number; traded: boolean }[];
  /** UTC days with the day's return on the equity the day started with. */
  days: { date: string; ret: number; life: number }[];
  playbook: Playbook;
}

interface Open {
  src: StrategyDef;
  facets: Facets;
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
  riskPct: number;
  exp: number;
  raw: number;
  entryTime: number;
  signalBarTime: number;
}

export function aggroReplay(a: {
  timeframe: Timeframe;
  /** Closed bars of the timeframe, ascending, the same timestamps across symbols. */
  candlesBySymbol: Record<string, Candle[]>;
  filters: Record<string, { step: number; tick: number }>;
  /** Only bars at or after this time are traded (earlier ones are warm-up). */
  from: number;
  startBalance: number;
  maxLeverage: number;
  /** Extra cost on every taker fill, as a fraction of price. */
  slippage?: number;
  /** Start from this playbook instead of an empty one. */
  playbook?: Playbook;
  pool?: StrategyDef[];
}): AggroReplayResult {
  const pool = a.pool ?? aggroPool();
  const slip = a.slippage ?? 0;
  const symbols = Object.keys(a.candlesBySymbol);
  const tfSec = TF_SECONDS[a.timeframe];
  const warmup = Math.max(...pool.map((s) => s.warmup));
  const pb = a.playbook ?? newPlaybook();
  const times = [...new Set(symbols.flatMap((s) => a.candlesBySymbol[s].map((c) => c.time)))].sort((x, y) => x - y);
  const idx: Record<string, Map<number, number>> = {};
  for (const s of symbols) idx[s] = new Map(a.candlesBySymbol[s].map((c, i) => [c.time, i]));

  let balance = a.startBalance;
  let life = 1;
  let lifeStart = a.from;
  let lifeTrades: LifeTrade[] = [];
  const open = new Map<string, Open>();
  const pendingExit = new Map<string, ExitReason>();
  /** `missed`: what the signal did on its own, learned if the entry is not opened after all (live keeps it as a shadow signal). */
  const pendingEntry = new Map<string, { x: Rated; bar: number; missed: { at: number; o: Outcome } | null }>();
  /** Outcomes of untraded signals, learnable once the bar they would have closed on is over. */
  let due: { at: number; o: Outcome }[] = [];
  const trades: AggroReplayTrade[] = [];
  const signals: AggroReplayResult["signals"] = [];
  const days: AggroReplayResult["days"] = [];
  const lives: LifeRecord[] = [];

  const iso = (sec: number) => new Date(sec * 1000).toISOString();
  const equityNow = () => balance + [...open.values()].reduce((s, o) => s + o.margin, 0);
  const slipped = (price: number, dir: 1 | -1) => price * (1 + dir * slip);

  function close(sym: string, o: Open, price: number, reason: ExitReason, feeRate: number, time: number) {
    const exit = reason === "liquidation" ? o.liq : feeRate === MAKER_FEE ? price : slipped(price, o.side === "long" ? -1 : 1);
    const { pnl, fee } = closeMath({ side: o.side, entry: o.entry, exit, qty: o.qty, margin: o.margin, feeRate, liquidation: reason === "liquidation" });
    balance += o.margin + pnl - fee;
    const net = pnl - o.entryFee - fee;
    const r = o.riskUsd > 0 ? net / o.riskUsd : 0;
    trades.push({ life, symbol: sym, src: o.src.key, side: o.side, entryTime: o.entryTime, exitTime: time, riskPct: o.riskPct, exp: o.exp, net, r, reason });
    lifeTrades.push({ facets: o.facets, r, net, closed_at: iso(time) });
    // Slippage is already in the fills here, so R is learned as it is.
    learn(pb, [{ facets: o.facets, r, raw: o.raw }]);
    open.delete(sym);
  }

  function endLife(time: number, cause: "busted" | "redeployed") {
    lives.push(autopsy(pb, { life, startedAt: iso(lifeStart), endedAt: iso(time), startBalance: a.startBalance, endEquity: equityNow(), cause, trades: lifeTrades }));
  }

  for (const t of times) {
    const closeTime = t + tfSec;
    // Untraded signals whose exit bar has closed by now become knowledge.
    if (due.some((d) => d.at <= t)) {
      learn(pb, due.filter((d) => d.at <= t).sort((x, y) => x.at - y.at).map((d) => d.o));
      due = due.filter((d) => d.at > t);
    }
    if (t >= a.from && rollDay(pb, t * 1000, equityNow(), life)) days.push({ date: pb.day!.date, ret: 0, life });

    for (const sym of symbols) {
      const i = idx[sym].get(t);
      if (i == null) continue;
      const all = a.candlesBySymbol[sym];
      const c = all[i];

      // 1) Orders queued at the previous close fill at this bar's open.
      const o0 = open.get(sym);
      const pe = pendingExit.get(sym);
      if (o0 && pe) close(sym, o0, c.open, pe, TAKER_FEE, c.time);
      pendingExit.delete(sym);
      const queued = pendingEntry.get(sym);
      pendingEntry.delete(sym);
      let opened = false;
      if (queued && !open.has(sym) && equityNow() >= 10) {
        const pn = queued.x;
        const entry = slipped(c.open, pn.c.side === "long" ? 1 : -1);
        const okSide = pn.c.side === "long" ? pn.c.stop < entry : pn.c.stop > entry;
        const okTp = pn.c.takeProfit == null || (pn.c.side === "long" ? pn.c.takeProfit > entry : pn.c.takeProfit < entry);
        if (okSide && okTp) {
          const eq = equityNow();
          const sz = sizePosition({ side: pn.c.side, entry, stop: pn.c.stop, equity: eq, freeBalance: balance, stepSize: a.filters[sym]?.step ?? 0.00001, settings: { riskPct: pn.risk.pct, maxLeverage: a.maxLeverage, slots: symbols.length } });
          if (!("skip" in sz)) {
            opened = true;
            balance -= sz.margin + sz.entryFee;
            open.set(sym, {
              src: pn.c.strategy, facets: pn.c.facets, side: pn.c.side, entry, qty: sz.qty, margin: sz.margin, entryFee: sz.entryFee, liq: sz.liqPrice,
              stop: pn.c.stop, takeProfit: pn.c.takeProfit, trailed: false, riskUsd: sz.riskUsd, riskPct: sz.riskPctActual, exp: pn.est.exp, raw: pn.est.raw, entryTime: c.time, signalBarTime: queued.bar,
            });
          }
        }
      }
      if (queued && !opened && queued.missed) due.push(queued.missed);

      // 2) Stops, targets and liquidation inside this bar.
      const o = open.get(sym);
      if (o) {
        const f = checkExit({ side: o.side, stop: o.stop, takeProfit: o.takeProfit, liqPrice: o.liq, trailed: o.trailed }, c);
        if (f) close(sym, o, f.price, f.reason, f.feeRate, c.time);
      }

      // 3) At the close: manage the open trade with its own rule set, then rate the bar's signals.
      if (t < a.from || i + 1 < warmup) continue;
      const hist = all.slice(Math.max(0, i + 1 - 600), i + 1); // the same window as live
      const o2 = open.get(sym);
      let flat = !o2;
      if (o2) {
        const barsHeld = hist.filter((x) => x.time > o2.signalBarTime).length;
        const m = o2.src.manage(hist, { side: o2.side, entryPrice: o2.entry, stop: o2.stop, takeProfit: o2.takeProfit, barsHeld });
        if (m.exit) {
          pendingExit.set(sym, m.exit.reason);
          flat = true;
        } else {
          const ns = tighterStop(o2.side, o2.stop, m.stop == null ? undefined : roundStop(o2.side, m.stop, a.filters[sym]?.tick ?? 0));
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

      const cands = aggroCandidates({ candles: hist, timeframe: a.timeframe, symbol: sym, at: closeTime * 1000, tick: a.filters[sym]?.tick ?? 0, entry: c.close, pool });
      if (!cands.length) continue;
      const rated = rate(pb, cands);
      const eq = equityNow();
      const blocked = !flat || eq < 10 || dayGuard(pb, eq).block;
      let taken: Rated | null = null;
      for (const x of rated) {
        const sim = simulateSignal(x.c.strategy, all, i, { side: x.c.side, entry: c.close, stop: x.c.stop, takeProfit: x.c.takeProfit }, replayBars(tfSec));
        if (!blocked && !taken && x.risk.pct > 0) {
          taken = x;
          pendingEntry.set(sym, { x, bar: c.time, missed: sim.done ? { at: all[Math.min(all.length - 1, i + sim.bars)].time + tfSec, o: { facets: x.c.facets, r: sim.rSlip, raw: x.est.raw } } : null });
          if (sim.done) signals.push({ time: t, src: x.c.strategy.key, exp: x.est.exp, raw: x.est.raw, r: sim.rSlip, traded: true });
          continue; // its real outcome is learned when the trade closes
        }
        if (!sim.done) continue;
        signals.push({ time: t, src: x.c.strategy.key, exp: x.est.exp, raw: x.est.raw, r: sim.rSlip, traded: false });
        const at = all[Math.min(all.length - 1, i + sim.bars)].time + tfSec;
        due.push({ at, o: { facets: x.c.facets, r: sim.rSlip, raw: x.est.raw } });
      }
    }

    // The day's return so far, on the equity the day started with (open trades at cost).
    const eq = equityNow();
    const day = days[days.length - 1];
    if (day && pb.day && day.date === pb.day.date && day.life === life && pb.day.start > 0) day.ret = eq / pb.day.start - 1;

    // A busted life ends here: what is still open is closed, the life is post-mortemed and the next one starts.
    if (eq < 10 && t >= a.from) {
      for (const [sym, o] of [...open]) {
        const i = idx[sym].get(t);
        close(sym, o, i == null ? o.entry : a.candlesBySymbol[sym][i].close, "signal", TAKER_FEE, t);
      }
      for (const q of pendingEntry.values()) if (q.missed) due.push(q.missed);
      pendingEntry.clear();
      pendingExit.clear();
      endLife(closeTime, "busted");
      life++;
      lifeStart = closeTime;
      lifeTrades = [];
      balance = a.startBalance;
    }
  }

  for (const [sym, o] of [...open]) {
    const last = a.candlesBySymbol[sym][a.candlesBySymbol[sym].length - 1];
    close(sym, o, last.close, "signal", TAKER_FEE, last.time);
  }
  return { timeframe: a.timeframe, lives, livesUsed: life, finalEquity: balance, trades, signals, days, playbook: pb };
}
