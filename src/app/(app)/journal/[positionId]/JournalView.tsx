"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { fetchKlines, INTERVAL_SECONDS, INTERVALS, type Interval } from "@/lib/binance";
import { baseAsset, fmtDateTime, fmtDuration, fmtPct, fmtPrice, fmtQty, fmtSignedUsd, fmtUsd, pnlClass } from "@/lib/format";
import type { Candle, Fill, JournalEntry, Position } from "@/lib/types";
import { unwrap, useQuery } from "@/hooks/useQuery";
import { useSymbolInfo } from "@/hooks/useMarket";
import { Chart } from "@/components/Chart";
import { IndicatorLegend } from "@/components/IndicatorsMenu";
import { useIndicators } from "@/lib/chartPrefs";
import { JournalEditor } from "@/components/JournalEditor";
import { Card, EmptyState, SideBadge, Skeleton, cx } from "@/components/ui";

interface JournalData {
  position: Position | null;
  fills: Fill[];
  entry: JournalEntry | null;
  allTags: string[];
}

export function JournalView({ positionId }: { positionId: string }) {
  const { data, loading } = useQuery<JournalData>(`journal:${positionId}`, async (sb) => {
    const [position, fills, entry, tagRows] = await Promise.all([
      sb.from("positions").select("*").eq("id", positionId).maybeSingle().then(unwrap),
      sb.from("fills").select("*").eq("position_id", positionId).order("created_at").then(unwrap),
      sb.from("journal_entries").select("*").eq("position_id", positionId).maybeSingle().then(unwrap),
      sb.from("journal_entries").select("tags").then(unwrap),
    ]);
    const allTags = [...new Set(((tagRows ?? []) as { tags: string[] }[]).flatMap((r) => r.tags))].sort();
    return {
      position: position as Position | null,
      fills: (fills ?? []) as Fill[],
      entry: entry as JournalEntry | null,
      allTags,
    };
  });

  const p = data?.position;

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-3 lg:p-6">
      <Link href="/history" className="inline-flex h-10 items-center gap-1 text-sm text-muted hover:text-fg">
        <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2.5">
          <path d="m15 18-6-6 6-6" />
        </svg>
        History
      </Link>

      {loading && !data ? (
        <div className="space-y-4">
          <Skeleton className="h-28" />
          <Skeleton className="h-72" />
        </div>
      ) : !p ? (
        <Card>
          <EmptyState title="Trade not found" body="It may have been removed." />
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-5">
          <div className="space-y-4 lg:col-span-3">
            <TradeSummary position={p} />
            <TradeChart position={p} />
            <FillsCard position={p} fills={data.fills} />
          </div>
          <div className="lg:col-span-2">
            <Card className="p-4 lg:sticky lg:top-[4.5rem]">
              <JournalEditor key={p.id} position={p} initial={data.entry} allTags={data.allTags} />
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}

function TradeSummary({ position: p }: { position: Position }) {
  const info = useSymbolInfo(p.symbol);
  const qty = p.status === "closed" ? p.entry_qty : p.qty;
  const cost = p.avg_entry * p.closed_qty;
  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h1 className="text-xl font-bold">{baseAsset(p.symbol)}/USDT</h1>
          <SideBadge side={p.side} />
          {p.status === "open" && <span className="text-xs text-muted">Still open</span>}
        </div>
        <div className={cx("num text-xl font-bold", pnlClass(p.realized_pnl))}>
          {fmtSignedUsd(p.realized_pnl)}{" "}
          <span className="text-sm font-medium">{fmtPct(cost ? (p.realized_pnl / cost) * 100 : null)}</span>
        </div>
      </div>
      <div className="num mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        <Item label="Size" value={`${fmtQty(qty, info.qtyDecimals)} ${info.baseAsset}`} />
        <Item label="Avg entry" value={fmtPrice(p.avg_entry, info.priceDecimals)} />
        <Item label="Avg exit" value={fmtPrice(p.avg_exit, info.priceDecimals)} />
        <Item label="Notional" value={fmtUsd(p.avg_entry * qty)} />
        <Item label="Opened" value={fmtDateTime(p.opened_at)} />
        <Item label="Closed" value={fmtDateTime(p.closed_at)} />
        <Item label="Held" value={fmtDuration(p.opened_at, p.closed_at)} />
      </div>
    </Card>
  );
}

function Item({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-muted">{label}</div>
      <div className="font-medium">{value}</div>
    </div>
  );
}

/** Candles covering the trade with entry/exit lines, at a resolution that fits. */
function TradeChart({ position: p }: { position: Position }) {
  const info = useSymbolInfo(p.symbol);
  const indicators = useIndicators();
  const [candles, setCandles] = useState<Candle[] | null>(null);

  useEffect(() => {
    const open = new Date(p.opened_at).getTime();
    const close = p.closed_at ? new Date(p.closed_at).getTime() : Date.now();
    const span = Math.max(close - open, 60_000);
    // Show context around the trade: at least ~45 minutes on each side, even for quick scalps.
    const pad = Math.max(span * 0.6, 45 * 60_000);
    const want = (span + 2 * pad) / 1000;
    const interval: Interval = INTERVALS.find((i) => want / INTERVAL_SECONDS[i] <= 400) ?? "1d";
    const ctrl = new AbortController();
    fetchKlines(p.symbol, interval, { startTime: Math.floor(open - pad), limit: 500, signal: ctrl.signal })
      .then((c) => setCandles(c.filter((x) => x.time * 1000 <= close + pad)))
      .catch(() => {});
    return () => ctrl.abort();
  }, [p.symbol, p.opened_at, p.closed_at]);

  const lines = useMemo(
    () => [
      { price: p.avg_entry, color: "#6d8cff", title: "Entry" },
      ...(p.avg_exit ? [{ price: p.avg_exit, color: p.realized_pnl >= 0 ? "#16c784" : "#ea3943", title: "Exit" }] : []),
    ],
    [p.avg_entry, p.avg_exit, p.realized_pnl],
  );

  return (
    <Card className="overflow-hidden">
      <div className="relative h-64 sm:h-80">
        <IndicatorLegend cfg={indicators} />
        <Chart fit indicators={indicators} history={candles} last={null} priceDecimals={info.priceDecimals} tickSize={info.tickSize} lines={lines} />
        {!candles && (
          <div className="absolute inset-0 grid place-items-center">
            <Skeleton className="h-3/4 w-11/12" />
          </div>
        )}
      </div>
    </Card>
  );
}

function FillsCard({ position: p, fills }: { position: Position; fills: Fill[] }) {
  const info = useSymbolInfo(p.symbol);
  return (
    <Card className="overflow-hidden">
      <div className="border-b border-line px-4 py-3 text-sm font-semibold">Executions</div>
      <ul className="num divide-y divide-line text-sm">
        {fills.map((f) => (
          <li key={f.id} className="flex items-center justify-between gap-3 px-4 py-3">
            <div className="flex items-center gap-2">
              <SideBadge side={f.side} />
              <span>
                {fmtQty(f.qty, info.qtyDecimals)} @ {fmtPrice(f.price, info.priceDecimals)}
              </span>
            </div>
            <div className="text-right">
              {f.realized_pnl !== 0 && (
                <div className={cx("font-medium", pnlClass(f.realized_pnl))}>{fmtSignedUsd(f.realized_pnl)}</div>
              )}
              <div className="text-xs text-muted">{fmtDateTime(f.created_at)}</div>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}
