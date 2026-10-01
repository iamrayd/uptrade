"use client";

import { useState } from "react";
import type { SymbolInfo } from "@/lib/binance";
import { closePosition } from "@/lib/actions";
import { baseAsset, fmtDuration, fmtPct, fmtPrice, fmtQty, fmtSignedUsd, fmtUsd, pnlClass } from "@/lib/format";
import { TAKER_FEE, distanceToLiq, roePct, unrealizedPnl } from "@/lib/pnl";
import { toast } from "@/lib/store";
import type { Position } from "@/lib/types";
import { ConfirmButton, EmptyState, SideBadge, Skeleton, cx } from "./ui";

export function LevBadge({ leverage }: { leverage: number }) {
  return (
    <span
      className={cx(
        "rounded px-1.5 py-0.5 text-[11px] font-bold",
        leverage >= 50 ? "bg-amber-400/15 text-amber-400" : "bg-panel-2 text-muted",
      )}
    >
      {leverage}x
    </span>
  );
}

function LiqCell({ p, mark, decimals }: { p: Position; mark: number | undefined; decimals?: number }) {
  if (!p.liq_price) return <span className="text-faint">None</span>;
  const d = distanceToLiq(p, mark);
  return (
    <span className="text-amber-400">
      {fmtPrice(p.liq_price, decimals)}
      {d != null && <span className={cx("ml-1 text-xs", d < 2 ? "text-down" : "text-faint")}>{d.toFixed(1)}%</span>}
    </span>
  );
}

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
      const net = (unrealizedPnl(p, mark) ?? 0) - p.qty * mark * TAKER_FEE;
      toast(net >= 0 ? "success" : "info", `Closed ${baseAsset(p.symbol)} ${p.side} ${p.leverage}x`, `≈ ${fmtSignedUsd(net)} after fee`);
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
                <div className="flex items-center gap-1.5">
                  <span className="font-semibold">{baseAsset(p.symbol)}</span>
                  <SideBadge side={p.side} />
                  <LevBadge leverage={p.leverage} />
                </div>
                <div className={cx("num text-right font-semibold", pnlClass(pnl))}>
                  {fmtSignedUsd(pnl)} <span className="text-xs font-normal">{fmtPct(roePct(p, mark))}</span>
                </div>
              </div>
              <div className="num mt-3 grid grid-cols-3 gap-x-2 gap-y-2.5 text-xs">
                <Stat label="Size" value={fmtQty(p.qty, info?.qtyDecimals)} />
                <Stat label="Entry" value={fmtPrice(p.avg_entry, info?.priceDecimals)} />
                <Stat label="Mark" value={fmtPrice(mark, info?.priceDecimals)} />
                <Stat label="Margin" value={fmtUsd(p.margin)} />
                <Stat label="Liq. price" value={<LiqCell p={p} mark={mark} decimals={info?.priceDecimals} />} />
                <Stat label="Open" value={fmtDuration(p.opened_at, null)} />
              </div>
              <div className="mt-3 flex justify-end">
                <ConfirmButton label="Close" confirmLabel="Confirm" loading={closing === p.id} onConfirm={() => close(p)} />
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
              <th className="px-4 py-2.5 text-right font-medium">Size</th>
              <th className="px-4 py-2.5 text-right font-medium">Entry</th>
              <th className="px-4 py-2.5 text-right font-medium">Mark</th>
              <th className="px-4 py-2.5 text-right font-medium">Liq. price</th>
              <th className="px-4 py-2.5 text-right font-medium">Margin</th>
              <th className="px-4 py-2.5 text-right font-medium">PnL (ROE)</th>
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
                    <div className="flex items-center gap-1.5">
                      <span className="font-semibold">{baseAsset(p.symbol)}</span>
                      <SideBadge side={p.side} />
                      <LevBadge leverage={p.leverage} />
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right">
                    {fmtQty(p.qty, info?.qtyDecimals)}
                    <div className="text-xs text-faint">{fmtUsd(mark ? mark * p.qty : null)}</div>
                  </td>
                  <td className="px-4 py-3 text-right">{fmtPrice(p.avg_entry, info?.priceDecimals)}</td>
                  <td className="px-4 py-3 text-right">{fmtPrice(mark, info?.priceDecimals)}</td>
                  <td className="px-4 py-3 text-right">
                    <LiqCell p={p} mark={mark} decimals={info?.priceDecimals} />
                  </td>
                  <td className="px-4 py-3 text-right">{fmtUsd(p.margin)}</td>
                  <td className={cx("px-4 py-3 text-right font-semibold", pnlClass(pnl))}>
                    {fmtSignedUsd(pnl)}
                    <div className="text-xs font-normal">{fmtPct(roePct(p, mark))}</div>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <ConfirmButton label="Close" confirmLabel="Confirm" loading={closing === p.id} onConfirm={() => close(p)} />
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
    <div className="min-w-0">
      <div className="text-faint">{label}</div>
      <div className="mt-0.5 truncate text-fg">{value}</div>
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
