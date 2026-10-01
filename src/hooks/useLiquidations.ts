"use client";

import { useEffect, useRef } from "react";
import { liquidatePosition } from "@/lib/actions";
import { findFirstCandle } from "@/lib/binance";
import { baseAsset, fmtPrice, fmtSignedUsd } from "@/lib/format";
import { toast } from "@/lib/store";
import type { Position } from "@/lib/types";
import { useOpenPositions } from "./useTrading";
import { usePrices } from "./useMarket";

const breached = (p: Position, price: number) =>
  !!p.liq_price && (p.side === "long" ? price <= p.liq_price : price >= p.liq_price);

/**
 * Client-side liquidation engine (isolated margin). Mounted once in the app shell.
 *  - Live: liquidates as soon as the streamed last price touches the liq price.
 *  - Catch-up: on load, scans candle wicks since the position's liq price was last
 *    set (last_fill_at) and liquidates at the first touch, timestamped then.
 * liquidate_position is idempotent (returns null if already closed).
 */
export function useLiquidations() {
  const { data: positions } = useOpenPositions();
  const watched = (positions ?? []).filter((p) => p.liq_price && p.liq_price > 0);
  const prices = usePrices(watched.map((p) => p.symbol));
  const inFlight = useRef(new Set<string>());
  const checked = useRef(new Set<string>());

  const liquidate = (p: Position, at?: string) => {
    if (inFlight.current.has(p.id)) return;
    inFlight.current.add(p.id);
    liquidatePosition(p.id, at)
      .then((res) => {
        if (res?.id)
          toast(
            "error",
            `${baseAsset(p.symbol)} ${p.side} ${p.leverage}x liquidated`,
            `@ ${fmtPrice(p.liq_price)} · lost ${fmtSignedUsd(-p.margin)} margin`,
          );
      })
      .catch((e: Error) => toast("error", "Liquidation failed", e.message))
      .finally(() => inFlight.current.delete(p.id));
  };

  // Live.
  useEffect(() => {
    for (const p of watched) {
      const price = prices[p.symbol];
      if (price != null && breached(p, price)) liquidate(p);
    }
  });

  // Catch-up, once per (position, liq price) pair.
  useEffect(() => {
    for (const p of watched) {
      const key = `${p.id}:${p.liq_price}`;
      if (checked.current.has(key)) continue;
      checked.current.add(key);
      const since = p.last_fill_at ?? p.opened_at;
      findFirstCandle(p.symbol, since, (c) => (p.side === "long" ? c.low <= p.liq_price! : c.high >= p.liq_price!))
        .then((at) => at && liquidate(p, at))
        .catch(() => checked.current.delete(key));
    }
  });
}
