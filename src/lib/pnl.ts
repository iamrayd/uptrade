import type { Position, PositionSide, Side } from "./types";

// Mirrors supabase/schema.sql exactly. If you change a number here, change it there.
export const MMR = 0.005; // maintenance margin rate
export const TAKER_FEE = 0.0002; // MEXC futures taker 0.02%
export const MAKER_FEE = 0; // MEXC futures maker 0%
export const MAX_LEVERAGE = 125;

/** Isolated-margin liquidation price. 0 = never (e.g. a 1x long). */
export function liqPrice(side: PositionSide, entry: number, qty: number, margin: number) {
  if (qty <= 0) return null;
  return side === "long" ? Math.max((entry - margin / qty) / (1 - MMR), 0) : (entry + margin / qty) / (1 + MMR);
}

export function unrealizedPnl(p: Pick<Position, "side" | "qty" | "avg_entry">, mark: number | undefined) {
  if (mark == null) return null;
  return p.side === "long" ? (mark - p.avg_entry) * p.qty : (p.avg_entry - mark) * p.qty;
}

/** Return on margin (what exchanges call ROE / ROI), in %. */
export function roePct(p: Pick<Position, "side" | "qty" | "avg_entry" | "margin">, mark: number | undefined) {
  const u = unrealizedPnl(p, mark);
  return u == null || !p.margin ? null : (u / p.margin) * 100;
}

/** % from the mark price to liquidation (how far price can move against you). */
export function distanceToLiq(p: Pick<Position, "side" | "liq_price">, mark: number | undefined) {
  if (!p.liq_price || mark == null) return null;
  return p.side === "long" ? ((mark - p.liq_price) / mark) * 100 : ((p.liq_price - mark) / mark) * 100;
}

/** Net realized result of a closed position: price PnL minus every fee. */
export const netPnl = (p: Pick<Position, "realized_pnl" | "fees">) => p.realized_pnl - p.fees;

/** Margin the position committed in total (for return % on closed trades). */
export const usedMargin = (p: Pick<Position, "entry_qty" | "avg_entry" | "leverage">) =>
  (p.entry_qty * p.avg_entry) / p.leverage;

export interface EquitySummary {
  balance: number;
  margin: number;
  unrealized: number;
  equity: number;
}

export function summarizeEquity(balance: number, positions: Position[], prices: Record<string, number>): EquitySummary {
  let margin = 0;
  let unrealized = 0;
  let equity = balance;
  for (const p of positions) {
    const u = unrealizedPnl(p, prices[p.symbol]) ?? 0;
    margin += p.margin;
    unrealized += u;
    // Isolated: a position can't be worth less than zero to the account.
    equity += Math.max(p.margin + u, 0);
  }
  return { balance, margin, unrealized, equity };
}

export interface FillPreview {
  closeQty: number;
  closingSide: PositionSide | null;
  estPnl: number; // net of closing fee
  openQty: number;
  openSide: PositionSide;
  leverage: number;
  notional: number; // of the opening part
  marginNeeded: number;
  fee: number; // total fee for the order
  cashReturned: number;
  resulting: { side: PositionSide; qty: number; entry: number; liq: number | null } | null;
}

/** Mirrors _apply_fill so the order form can preview the outcome. */
export function previewFill(
  side: Side,
  qty: number,
  price: number,
  pos: Position | undefined,
  leverage: number,
  feeRate: number,
): FillPreview {
  const dir: PositionSide = side === "buy" ? "long" : "short";
  let closeQty = 0;
  let estPnl = 0;
  let cashReturned = 0;
  let fee = 0;
  if (pos && pos.side !== dir) {
    closeQty = Math.min(qty, pos.qty);
    const release = (pos.margin * closeQty) / pos.qty;
    let pnl = pos.side === "long" ? (price - pos.avg_entry) * closeQty : (pos.avg_entry - price) * closeQty;
    let f = closeQty * price * feeRate;
    if (release + pnl < 0) {
      pnl = -release;
      f = 0;
    } else if (release + pnl < f) f = release + pnl;
    estPnl = pnl - f;
    cashReturned = release + pnl - f;
    fee += f;
  }
  const openQty = Math.max(qty - closeQty, 0);
  const lev = pos && pos.side === dir ? pos.leverage : leverage;
  const notional = openQty * price;
  const marginNeeded = notional / lev;
  fee += notional * feeRate;

  let resulting: FillPreview["resulting"] = null;
  if (pos && pos.side === dir) {
    const q = pos.qty + qty;
    const entry = (pos.avg_entry * pos.qty + price * qty) / q;
    resulting = { side: dir, qty: q, entry, liq: liqPrice(dir, entry, q, pos.margin + marginNeeded) };
  } else if (openQty > 1e-12) {
    resulting = { side: dir, qty: openQty, entry: price, liq: liqPrice(dir, price, openQty, marginNeeded) };
  } else if (pos && pos.qty - closeQty > 1e-12) {
    resulting = { side: pos.side, qty: pos.qty - closeQty, entry: pos.avg_entry, liq: pos.liq_price };
  }

  return {
    closeQty,
    closingSide: closeQty > 0 && pos ? pos.side : null,
    estPnl,
    openQty,
    openSide: dir,
    leverage: lev,
    notional,
    marginNeeded,
    fee,
    cashReturned,
    resulting,
  };
}
