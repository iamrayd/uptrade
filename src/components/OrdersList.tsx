"use client";

import { useState } from "react";
import type { SymbolInfo } from "@/lib/binance";
import { cancelOrder } from "@/lib/actions";
import { baseAsset, fmtDateTime, fmtPct, fmtPrice, fmtQty } from "@/lib/format";
import { toast } from "@/lib/store";
import type { Order } from "@/lib/types";
import { ListSkeleton, Stat } from "./PositionsList";
import { Button, EmptyState, SideBadge } from "./ui";

export function OrdersList({
  orders,
  prices,
  infos,
  loading,
  onSelectSymbol,
}: {
  orders: Order[] | undefined;
  prices: Record<string, number>;
  infos: Record<string, SymbolInfo>;
  loading: boolean;
  onSelectSymbol: (s: string) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);

  async function cancel(o: Order) {
    setBusy(o.id);
    try {
      await cancelOrder(o.id);
      toast("info", "Order cancelled", `${o.side} ${baseAsset(o.symbol)} @ ${fmtPrice(o.limit_price, infos[o.symbol]?.priceDecimals)}`);
    } catch (e) {
      toast("error", "Couldn't cancel", (e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  if (loading && !orders) return <ListSkeleton />;
  if (!orders?.length)
    return <EmptyState title="No open orders" body="Limit orders wait here until the price reaches your level." />;

  const distance = (o: Order) => {
    const p = prices[o.symbol];
    return p && o.limit_price ? ((o.limit_price - p) / p) * 100 : null;
  };

  return (
    <>
      <ul className="divide-y divide-line md:hidden">
        {orders.map((o) => {
          const info = infos[o.symbol];
          return (
            <li key={o.id} className="p-4" onClick={() => onSelectSymbol(o.symbol)}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="font-semibold">{baseAsset(o.symbol)}</span>
                  <SideBadge side={o.side} />
                  <span className="text-xs text-muted">Limit</span>
                </div>
                <span className="text-xs text-faint">{fmtDateTime(o.created_at)}</span>
              </div>
              <div className="num mt-3 grid grid-cols-3 gap-2 text-xs">
                <Stat label="Price" value={fmtPrice(o.limit_price, info?.priceDecimals)} />
                <Stat label="Size" value={fmtQty(o.qty, info?.qtyDecimals)} />
                <Stat label="From last" value={fmtPct(distance(o))} />
              </div>
              <div className="mt-3 flex justify-end">
                <Button size="sm" variant="outline" loading={busy === o.id} onClick={(e) => (e.stopPropagation(), cancel(o))}>
                  Cancel
                </Button>
              </div>
            </li>
          );
        })}
      </ul>

      <div className="hidden overflow-x-auto md:block">
        <table className="num w-full text-sm">
          <thead className="text-left text-xs text-muted">
            <tr className="border-b border-line">
              <th className="px-4 py-2.5 font-medium">Market</th>
              <th className="px-4 py-2.5 font-medium text-right">Limit price</th>
              <th className="px-4 py-2.5 font-medium text-right">Size</th>
              <th className="px-4 py-2.5 font-medium text-right">Value</th>
              <th className="px-4 py-2.5 font-medium text-right">From last</th>
              <th className="px-4 py-2.5 font-medium text-right">Placed</th>
              <th className="px-4 py-2.5" />
            </tr>
          </thead>
          <tbody>
            {orders.map((o) => {
              const info = infos[o.symbol];
              return (
                <tr
                  key={o.id}
                  onClick={() => onSelectSymbol(o.symbol)}
                  className="cursor-pointer border-b border-line/60 last:border-0 hover:bg-panel-2/50"
                >
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold">{baseAsset(o.symbol)}</span>
                      <SideBadge side={o.side} />
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right">{fmtPrice(o.limit_price, info?.priceDecimals)}</td>
                  <td className="px-4 py-3 text-right">{fmtQty(o.qty, info?.qtyDecimals)}</td>
                  <td className="px-4 py-3 text-right">${((o.limit_price ?? 0) * o.qty).toFixed(2)}</td>
                  <td className="px-4 py-3 text-right text-muted">{fmtPct(distance(o))}</td>
                  <td className="px-4 py-3 text-right text-muted">{fmtDateTime(o.created_at)}</td>
                  <td className="px-4 py-3 text-right">
                    <Button size="sm" variant="outline" loading={busy === o.id} onClick={(e) => (e.stopPropagation(), cancel(o))}>
                      Cancel
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
