"use client";

import { useEffect, useRef } from "react";
import { fetchKlines, type Interval } from "@/lib/binance";
import { fillLimitOrder } from "@/lib/actions";
import { fmtPrice, fmtQty } from "@/lib/format";
import { toast } from "@/lib/store";
import type { Order } from "@/lib/types";
import { useOpenOrders } from "./useTrading";
import { usePrices } from "./useMarket";

const crosses = (o: Order, price: number) =>
  o.limit_price != null && (o.side === "buy" ? price <= o.limit_price : price >= o.limit_price);

/**
 * Client-side limit order engine. Mounted once in the app shell.
 *  - Live: fills an order as soon as the streamed last price crosses its limit.
 *  - Catch-up: on load, replays candles since each order was placed to fill
 *    orders that would have triggered while the app was closed.
 * The fill_limit_order RPC is idempotent, so two open tabs can't double-fill.
 */
export function useLimitMatcher() {
  const { data: orders } = useOpenOrders();
  const limits = (orders ?? []).filter((o) => o.type === "limit");
  const prices = usePrices(limits.map((o) => o.symbol));
  const inFlight = useRef(new Set<string>());
  const caughtUp = useRef(new Set<string>());

  const fill = (o: Order, at?: string) => {
    if (inFlight.current.has(o.id)) return;
    inFlight.current.add(o.id);
    fillLimitOrder(o.id, at)
      .then((res) => {
        const what = `${o.side === "buy" ? "Buy" : "Sell"} ${fmtQty(o.qty)} ${o.symbol} @ ${fmtPrice(o.limit_price)}`;
        if (res.status === "filled") toast("success", "Limit order filled", what);
        else if (res.status === "cancelled") toast("error", "Limit order cancelled", res.cancel_reason ?? what);
      })
      .catch((e: Error) => toast("error", "Limit fill failed", e.message))
      .finally(() => inFlight.current.delete(o.id));
  };

  // Live matching.
  useEffect(() => {
    for (const o of limits) {
      const p = prices[o.symbol];
      if (p != null && crosses(o, p)) fill(o);
    }
  });

  // Catch-up for orders not yet checked this session.
  useEffect(() => {
    for (const o of limits) {
      if (caughtUp.current.has(o.id)) continue;
      caughtUp.current.add(o.id);
      catchUp(o).then((at) => at && fill(o, at)).catch(() => caughtUp.current.delete(o.id));
    }
  });
}

/** Returns the time the order would have filled, or null. */
async function catchUp(o: Order): Promise<string | null> {
  const start = new Date(o.created_at).getTime();
  const ageMin = (Date.now() - start) / 60000;
  if (ageMin < 1) return null;
  // One request covers up to 1000 bars; pick the finest interval that reaches back far enough.
  const interval: Interval = ageMin <= 1000 ? "1m" : ageMin <= 1000 * 60 ? "1h" : "1d";
  const candles = await fetchKlines(o.symbol, interval, { startTime: start, limit: 1000 });
  const hit = candles.find((c) => (o.side === "buy" ? c.low <= o.limit_price! : c.high >= o.limit_price!));
  return hit ? new Date(Math.max(hit.time * 1000, start)).toISOString() : null;
}
