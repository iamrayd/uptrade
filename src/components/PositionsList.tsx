"use client";

import { useState } from "react";
import type { SymbolInfo } from "@/lib/binance";
import { closePosition } from "@/lib/actions";
import { baseAsset, fmtDuration, fmtPct, fmtPrice, fmtQty, fmtSignedUsd, fmtUsd, pnlClass } from "@/lib/format";
import { pnlPct, unrealizedPnl } from "@/lib/pnl";
import { toast } from "@/lib/store";
import type { Position } from "@/lib/types";
import { ConfirmButton, EmptyState, SideBadge, Skeleton, cx } from "./ui";

export function PositionsList({
  positions,
  prices,
  infos,
  loading,
  onSelectSymbol,
}: {
  positions: Position[] | undefined;
  prices: Record<string, number>;
  infos: Record<string, SymbolInfo>;
  loading: boolean;
  onSelectSymbol: (s: string) => void;
}) {
  const [closing, setClosing] = useState<string | null>(null);

  async function close(p: Position) {
    const mark = prices[p.symbol];
    if (!mark) return toast("error", "No live price yet", "Try again in a second.");
    setClosing(p.id);
    try {
      await closePosition(p.id, mark);
      const pnl = unrealizedPnl(p, mark) ?? 0;
      toast(pnl >= 0 ? "success" : "info", `Closed ${p.side} ${baseAsset(p.symbol)}`, `Realized ${fmtSignedUsd(pnl)}`);
    } catch (e) {
      toast("error", "Couldn't close position", (e as Error).message);
    } finally {
      setClosing(null);
    }
  }

  if (loading && !positions) return <ListSkeleton />;
  if (!positions?.length)
    return <EmptyState title="No open positions" body="Pick a market and place your first trade. It’s all paper money." />;

  return (
    <>
      {/* Phone: cards */}
      <ul className="divide-y divide-line md:hidden">
        {positions.map((p) => {
          const info = infos[p.symbol];
          const mark = prices[p.symbol];
          const pnl = unrealizedPnl(p, mark);
          return (
            <li key={p.id} className="p-4" onClick={() => onSelectSymbol(p.symbol)}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="font-semibold">{baseAsset(p.symbol)}</span>
                  <SideBadge side={p.side} />
                </div>
                <div className={cx("num text-right font-semibold", pnlClass(pnl))}>
                  {fmtSignedUsd(pnl)} <span className="text-xs font-normal">{fmtPct(pnlPct(p, mark))}</span>
                </div>
              </div>
              <div className="num mt-3 grid grid-cols-3 gap-2 text-xs">
                <Stat label="Size" value={`${fmtQty(p.qty, info?.qtyDecimals)}`} />
                <Stat label="Entry" value={fmtPrice(p.avg_entry, info?.priceDecimals)} />
                <Stat label="Mark" value={fmtPrice(mark, info?.priceDecimals)} />
              </div>
              <div className="mt-3 flex items-center justify-between">
                <span className="text-xs text-faint">Open {fmtDuration(p.opened_at, null)}</span>
                <ConfirmButton
                  label="Close"
                  confirmLabel="Confirm"
                  loading={closing === p.id}
                  onConfirm={() => close(p)}
                />
              </div>
            </li>
          );
        })}
      </ul>

      {/* Tablet/desktop: table */}
      <div className="hidden overflow-x-auto md:block">
        <table className="num w-full text-sm">
          <thead className="text-left text-xs text-muted">
            <tr className="border-b border-line">
              <th className="px-4 py-2.5 font-medium">Market</th>
              <th className="px-4 py-2.5 font-medium text-right">Size</th>
              <th className="px-4 py-2.5 font-medium text-right">Value</th>
              <th className="px-4 py-2.5 font-medium text-right">Entry</th>
              <th className="px-4 py-2.5 font-medium text-right">Mark</th>
              <th className="px-4 py-2.5 font-medium text-right">Unrealized PnL</th>
              <th className="px-4 py-2.5" />
            </tr>
          </thead>
          <tbody>
            {positions.map((p) => {
              const info = infos[p.symbol];
              const mark = prices[p.symbol];
              const pnl = unrealizedPnl(p, mark);
              return (
                <tr
                  key={p.id}
                  onClick={() => onSelectSymbol(p.symbol)}
                  className="cursor-pointer border-b border-line/60 last:border-0 hover:bg-panel-2/50"
                >
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold">{baseAsset(p.symbol)}</span>
                      <SideBadge side={p.side} />
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right">{fmtQty(p.qty, info?.qtyDecimals)}</td>
                  <td className="px-4 py-3 text-right">{fmtUsd(mark ? mark * p.qty : null)}</td>
                  <td className="px-4 py-3 text-right">{fmtPrice(p.avg_entry, info?.priceDecimals)}</td>
                  <td className="px-4 py-3 text-right">{fmtPrice(mark, info?.priceDecimals)}</td>
                  <td className={cx("px-4 py-3 text-right font-semibold", pnlClass(pnl))}>
                    {fmtSignedUsd(pnl)} <span className="text-xs font-normal">{fmtPct(pnlPct(p, mark))}</span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <ConfirmButton
                      label="Close"
                      confirmLabel="Confirm"
                      loading={closing === p.id}
                      onConfirm={() => close(p)}
                    />
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

export function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="text-faint">{label}</div>
      <div className="mt-0.5 text-fg">{value}</div>
    </div>
  );
}

export function ListSkeleton() {
  return (
    <div className="space-y-3 p-4">
      <Skeleton className="h-12" />
      <Skeleton className="h-12" />
    </div>
  );
}
