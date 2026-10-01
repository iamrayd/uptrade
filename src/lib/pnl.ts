import type { Position, PositionSide, Side } from "./types";

// Same formulas as public._apply_fill in supabase/schema.sql.

export function unrealizedPnl(p: Pick<Position, "side" | "qty" | "avg_entry">, mark: number | undefined) {
  if (mark == null) return null;
  return p.side === "long" ? (mark - p.avg_entry) * p.qty : (p.avg_entry - mark) * p.qty;
}

export function pnlPct(p: Pick<Position, "side" | "avg_entry">, mark: number | undefined) {
  if (mark == null || !p.avg_entry) return null;
  const move = ((mark - p.avg_entry) / p.avg_entry) * 100;
  return p.side === "long" ? move : -move;
}

export interface EquitySummary {
  balance: number;
  inPositions: number;
  unrealized: number;
  equity: number;
}

export function summarizeEquity(balance: number, positions: Position[], prices: Record<string, number>): EquitySummary {
  let inPositions = 0;
  let unrealized = 0;
  for (const p of positions) {
    inPositions += p.qty * p.avg_entry;
    unrealized += unrealizedPnl(p, prices[p.symbol]) ?? 0;
  }
  return { balance, inPositions, unrealized, equity: balance + inPositions + unrealized };
}

export interface FillPreview {
  closeQty: number;
  closingSide: PositionSide | null;
  estPnl: number;
  openQty: number;
  openSide: PositionSide;
  cashNeeded: number; // for the opening part
  cashReturned: number; // from the closing part
  resulting: { side: PositionSide; qty: number } | null;
}

/** Mirrors the netting logic so the order form can preview the outcome. */
export function previewFill(side: Side, qty: number, price: number, pos: Position | undefined): FillPreview {
  const dir: PositionSide = side === "buy" ? "long" : "short";
  let closeQty = 0;
  let estPnl = 0;
  let cashReturned = 0;
  if (pos && pos.side !== dir) {
    closeQty = Math.min(qty, pos.qty);
    estPnl = pos.side === "long" ? (price - pos.avg_entry) * closeQty : (pos.avg_entry - price) * closeQty;
    cashReturned = closeQty * pos.avg_entry + estPnl;
  }
  const openQty = qty - closeQty;

  let resulting: FillPreview["resulting"] = null;
  if (pos && pos.side === dir) resulting = { side: dir, qty: pos.qty + qty };
  else if (pos && openQty <= 1e-12) resulting = pos.qty - closeQty > 1e-12 ? { side: pos.side, qty: pos.qty - closeQty } : null;
  else if (openQty > 0) resulting = { side: dir, qty: openQty };

  return {
    closeQty,
    closingSide: closeQty > 0 && pos ? pos.side : null,
    estPnl,
    openQty,
    openSide: dir,
    cashNeeded: openQty * price,
    cashReturned,
    resulting,
  };
}
