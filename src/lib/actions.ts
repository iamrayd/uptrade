"use client";

import { createClient } from "./supabase/client";
import { bumpData } from "./store";
import type { Account, Order, OrderType, Side } from "./types";

const FRIENDLY: [RegExp, string][] = [
  [/insufficient balance/i, "Not enough balance for this order."],
  [/invalid quantity/i, "Enter a quantity greater than zero."],
  [/invalid price/i, "Enter a valid price."],
  [/order not open/i, "That order is no longer open."],
  [/position not open/i, "That position is already closed."],
  [/invalid amount/i, "Enter an amount other than zero."],
  [/not authenticated|JWT/i, "Your session expired. Please sign in again."],
  [/Failed to fetch|NetworkError/i, "Network error. Check your connection and try again."],
];

export function friendlyError(message: string) {
  return FRIENDLY.find(([re]) => re.test(message))?.[1] ?? message;
}

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await createClient().rpc(fn, args);
  if (error) throw new Error(friendlyError(error.message));
  bumpData();
  return data as T;
}

export function placeOrder(a: {
  symbol: string;
  side: Side;
  type: OrderType;
  qty: number;
  limitPrice?: number;
  marketPrice?: number;
}) {
  return rpc<Order>("place_order", {
    p_symbol: a.symbol,
    p_side: a.side,
    p_type: a.type,
    p_qty: a.qty,
    p_limit_price: a.limitPrice ?? null,
    p_market_price: a.marketPrice ?? null,
  });
}

export function fillLimitOrder(orderId: string, filledAt?: string) {
  return rpc<Order>("fill_limit_order", { p_order_id: orderId, p_filled_at: filledAt ?? null });
}

export function cancelOrder(orderId: string) {
  return rpc<Order>("cancel_order", { p_order_id: orderId });
}

export function closePosition(positionId: string, marketPrice: number) {
  return rpc<Order>("close_position", { p_position_id: positionId, p_market_price: marketPrice });
}

export function adjustBalance(amount: number, note: string) {
  return rpc<Account>("adjust_balance", { p_amount: amount, p_note: note });
}
