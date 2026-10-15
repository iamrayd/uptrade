import type { Candle, ExitReason, Side } from "./types.ts";

// Same numbers as the UpTrade engine (supabase/schema.sql, src/lib/pnl.ts).
export const MMR = 0.005;
export const TAKER_FEE = 0.0002;
export const MAKER_FEE = 0;
/** Smallest order notional we'll place (Binance's spot minimum is $5). */
export const MIN_NOTIONAL = 5;
/** Never take a stop tighter than this, as a fraction of price. Fees and noise eat anything closer. */
export const MIN_STOP_PCT = 0.0015;
/** The liquidation price must be at least this many stop-distances away from entry. */
export const LIQ_BUFFER = 1.5;

export interface RiskSettings {
  riskPct: number; // e.g. 0.02
  maxLeverage: number; // e.g. 20
  /** How many positions the account may hold at once; caps each one's margin at equity / slots. */
  slots: number;
}

/** Isolated-margin liquidation price (same as public._liq_price). 0 means never. */
export function liqPrice(side: Side, entry: number, qty: number, margin: number) {
  if (qty <= 0) return 0;
  return side === "long" ? Math.max((entry - margin / qty) / (1 - MMR), 0) : (entry + margin / qty) / (1 + MMR);
}

function floorToStep(value: number, step: number) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  const decimals = Math.max(0, Math.round(-Math.log10(step)));
  return +(Math.floor(value / step + 1e-9) * step).toFixed(decimals);
}

export interface SizedOrder {
  qty: number;
  leverage: number;
  notional: number;
  margin: number;
  entryFee: number;
  liqPrice: number;
  /** Loss if the stop fills exactly, including both fees. */
  riskUsd: number;
  /** riskUsd as a fraction of equity (≤ riskPct; lower when capped). */
  riskPctActual: number;
  stopPct: number;
  /** Plain-language explanation of the sizing, for the journal. */
  notes: string[];
}

/**
 * Fixed-fractional sizing: risk `riskPct` of equity between entry and stop
 * (fees included), then use the LOWEST leverage that fits the margin budget.
 * Leverage is also capped so that liquidation sits at least LIQ_BUFFER stop
 * distances beyond the stop, which means the stop is always hit first.
 */
export function sizePosition(a: {
  side: Side;
  entry: number;
  stop: number;
  equity: number; // free balance + margin in open trades
  freeBalance: number;
  stepSize: number;
  settings: RiskSettings;
}): SizedOrder | { skip: string } {
  const { side, entry, stop, equity, freeBalance, stepSize, settings } = a;
  const dist = side === "long" ? entry - stop : stop - entry;
  if (!(dist > 0)) return { skip: `Stop ${stop} is on the wrong side of the entry ${entry}.` };
  const stopPct = dist / entry;
  if (stopPct < MIN_STOP_PCT)
    return { skip: `Stop is only ${(stopPct * 100).toFixed(3)}% away (min ${(MIN_STOP_PCT * 100).toFixed(2)}%). Fees would dominate.` };

  const notes: string[] = [];
  const riskBudget = equity * settings.riskPct;
  // Per unit: the price move to the stop + taker fee on entry + taker fee on the stop fill.
  const perUnit = dist + entry * TAKER_FEE + stop * TAKER_FEE;
  let qty = floorToStep(riskBudget / perUnit, stepSize);

  // Highest leverage whose liquidation price stays LIQ_BUFFER × stop distance past entry.
  let levCap = Math.min(settings.maxLeverage, 125);
  while (levCap > 1) {
    const liq = liqPrice(side, entry, 1, entry / levCap);
    const liqDist = side === "long" ? (entry - liq) / entry : (liq - entry) / entry;
    if (liqDist >= stopPct * LIQ_BUFFER) break;
    levCap--;
  }
  if (levCap < settings.maxLeverage) notes.push(`Leverage capped at ${levCap}x so liquidation sits well beyond the stop.`);

  // Margin budget: an equal share of equity per slot, and never more than the free balance.
  const marginBudget = Math.min(equity / settings.slots, freeBalance);
  const feeReserve = (n: number) => n * TAKER_FEE;
  let leverage = Math.max(1, Math.ceil((qty * entry) / Math.max(marginBudget - feeReserve(qty * entry), 1e-9)));
  if (leverage > levCap) {
    leverage = levCap;
    const maxNotional = (marginBudget * leverage) / (1 + leverage * TAKER_FEE);
    const capped = floorToStep(maxNotional / entry, stepSize);
    if (capped < qty) {
      notes.push(`Size cut from ${qty} to ${capped}: at ${leverage}x the $${marginBudget.toFixed(2)} margin budget can't carry the full ${(settings.riskPct * 100).toFixed(1)}% risk.`);
      qty = capped;
    }
  }

  const notional = qty * entry;
  if (notional < MIN_NOTIONAL) return { skip: `Position would be only $${notional.toFixed(2)} notional (min $${MIN_NOTIONAL}).` };
  const margin = notional / leverage;
  const entryFee = notional * TAKER_FEE;
  if (margin + entryFee > freeBalance + 1e-9) return { skip: `Not enough free balance ($${freeBalance.toFixed(2)}) for $${margin.toFixed(2)} margin.` };

  const riskUsd = qty * perUnit;
  return {
    qty,
    leverage,
    notional,
    margin,
    entryFee,
    liqPrice: liqPrice(side, entry, qty, margin),
    riskUsd,
    riskPctActual: equity > 0 ? riskUsd / equity : 0,
    stopPct,
    notes,
  };
}

export interface LiveTrade {
  side: Side;
  stop: number;
  takeProfit: number | null;
  liqPrice: number; // 0 = never
  /** True once the stop has been trailed, so a hit reports "trailing_stop". */
  trailed: boolean;
}

export interface ExitFill {
  price: number;
  reason: ExitReason;
  feeRate: number;
  note: string;
}

/**
 * Checks one candle (normally 1m) against an open trade's stop, target and
 * liquidation price. Rules, in order:
 *  1. If the candle OPENS past the liquidation price → liquidated.
 *  2. If it opens past the stop (a gap) → stop fills at the open (slippage).
 *  3. If it opens past the target → target fills at the target (limit order).
 *  4. If the range touches both stop and target → assume the STOP first (conservative).
 *  5. Stop touched → fills at the stop. Target touched → fills at the target.
 * Stops are stop-market orders (taker fee). Targets are resting limit orders (maker fee).
 */
export function checkExit(t: LiveTrade, c: Candle): ExitFill | null {
  const stopReason: ExitReason = t.trailed ? "trailing_stop" : "stop_loss";
  if (t.side === "long") {
    if (t.liqPrice > 0 && c.open <= t.liqPrice) return { price: t.liqPrice, reason: "liquidation", feeRate: 0, note: "Price gapped through the liquidation price." };
    if (c.open <= t.stop) return { price: c.open, reason: stopReason, feeRate: TAKER_FEE, note: "Price opened below the stop. Filled at the open (slippage)." };
    if (t.takeProfit != null && c.open >= t.takeProfit) return { price: t.takeProfit, reason: "take_profit", feeRate: MAKER_FEE, note: "Target limit order filled." };
    if (c.low <= t.stop) return { price: t.stop, reason: stopReason, feeRate: TAKER_FEE, note: "Stop hit." };
    if (t.takeProfit != null && c.high >= t.takeProfit) return { price: t.takeProfit, reason: "take_profit", feeRate: MAKER_FEE, note: "Target limit order filled." };
  } else {
    if (t.liqPrice > 0 && c.open >= t.liqPrice) return { price: t.liqPrice, reason: "liquidation", feeRate: 0, note: "Price gapped through the liquidation price." };
    if (c.open >= t.stop) return { price: c.open, reason: stopReason, feeRate: TAKER_FEE, note: "Price opened above the stop. Filled at the open (slippage)." };
    if (t.takeProfit != null && c.open <= t.takeProfit) return { price: t.takeProfit, reason: "take_profit", feeRate: MAKER_FEE, note: "Target limit order filled." };
    if (c.high >= t.stop) return { price: t.stop, reason: stopReason, feeRate: TAKER_FEE, note: "Stop hit." };
    if (t.takeProfit != null && c.low <= t.takeProfit) return { price: t.takeProfit, reason: "take_profit", feeRate: MAKER_FEE, note: "Target limit order filled." };
  }
  return null;
}

/** Gross price PnL and fee of closing, capped so a slice can't lose more than its margin (isolated). Mirrors _apply_fill. */
export function closeMath(a: { side: Side; entry: number; exit: number; qty: number; margin: number; feeRate: number; liquidation: boolean }) {
  let pnl = a.side === "long" ? (a.exit - a.entry) * a.qty : (a.entry - a.exit) * a.qty;
  let fee = a.exit * a.qty * a.feeRate;
  if (a.liquidation) {
    pnl = Math.max(pnl, -a.margin);
    fee = a.margin + pnl; // the remaining maintenance margin is forfeited
  } else if (a.margin + pnl < 0) {
    pnl = -a.margin;
    fee = 0;
  } else if (a.margin + pnl < fee) {
    fee = a.margin + pnl;
  }
  return { pnl, fee };
}

/** Only accept a new stop if it is meaningfully tighter (moves in the trade's favour) than the current one. */
export function tighterStop(side: Side, current: number, proposed: number | undefined) {
  if (proposed == null || !Number.isFinite(proposed)) return null;
  const eps = Math.abs(current) * 1e-9; // ignore float/storage rounding noise
  return side === "long" ? (proposed > current + eps ? proposed : null) : proposed < current - eps ? proposed : null;
}

/** Rounds a price to the exchange tick. Stops round AWAY from price (never tighter than the rule), targets to the nearest tick. */
export function toTick(price: number, tick: number, mode: "down" | "up" | "nearest") {
  if (!(tick > 0)) return price;
  const decimals = Math.max(0, Math.round(-Math.log10(tick)) + 1);
  const n = price / tick;
  const k = mode === "down" ? Math.floor(n + 1e-9) : mode === "up" ? Math.ceil(n - 1e-9) : Math.round(n);
  return +(k * tick).toFixed(decimals);
}

export const roundStop = (side: Side, stop: number, tick: number) => toTick(stop, tick, side === "long" ? "down" : "up");
