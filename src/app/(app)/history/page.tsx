"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useHistory } from "@/hooks/useTrading";
import { useSymbolInfos } from "@/hooks/useMarket";
import { baseAsset, fmtDateTime, fmtDuration, fmtPct, fmtPrice, fmtQty, fmtSignedUsd, pnlClass } from "@/lib/format";
import type { HistoryRow } from "@/lib/types";
import { LevBadge, ListSkeleton } from "@/components/PositionsList";
import { LiqBadge } from "@/components/ui";
import { netPnl, usedMargin } from "@/lib/pnl";
import { Card, EmptyState, SideBadge, cx } from "@/components/ui";

/** Net return on the margin committed (ROE). */
const returnPct = (r: HistoryRow) => {
  const m = usedMargin(r);
  return m ? (netPnl(r) / m) * 100 : null;
};

export default function HistoryPage() {
  const { data: rows, loading } = useHistory();
  const [symbol, setSymbol] = useState("all");
  const [tag, setTag] = useState("all");
  const [outcome, setOutcome] = useState<"all" | "win" | "loss">("all");

  const symbols = useMemo(() => [...new Set((rows ?? []).map((r) => r.symbol))].sort(), [rows]);
  const tags = useMemo(() => [...new Set((rows ?? []).flatMap((r) => r.journal?.tags ?? []))].sort(), [rows]);
  const infos = useSymbolInfos(symbols);

  const filtered = useMemo(
    () =>
      (rows ?? []).filter(
        (r) =>
          (symbol === "all" || r.symbol === symbol) &&
          (tag === "all" || r.journal?.tags.includes(tag)) &&
          (outcome === "all" || (outcome === "win" ? netPnl(r) > 0 : netPnl(r) <= 0)),
      ),
    [rows, symbol, tag, outcome],
  );

  const stats = useMemo(() => {
    const wins = filtered.filter((r) => netPnl(r) > 0);
    const losses = filtered.filter((r) => netPnl(r) <= 0);
    const sum = (l: HistoryRow[]) => l.reduce((a, r) => a + netPnl(r), 0);
    const grossWin = sum(wins);
    const grossLoss = Math.abs(sum(losses));
    return {
      total: sum(filtered),
      count: filtered.length,
      winRate: filtered.length ? (wins.length / filtered.length) * 100 : null,
      avgWin: wins.length ? grossWin / wins.length : null,
      avgLoss: losses.length ? -grossLoss / losses.length : null,
      profitFactor: grossLoss ? grossWin / grossLoss : null,
    };
  }, [filtered]);

  const selectCls = "h-10 rounded-lg border border-line bg-panel px-3 text-sm outline-none focus:border-accent";

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-3 lg:p-6">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Trade history</h1>
          <p className="text-sm text-muted">Closed positions. Tap one to journal it.</p>
        </div>
      </div>

      <Card className="num grid grid-cols-2 gap-4 p-4 sm:grid-cols-3 lg:grid-cols-6">
        <Kpi label="Net PnL" value={fmtSignedUsd(stats.total)} cls={pnlClass(stats.total)} />
        <Kpi label="Trades" value={String(stats.count)} />
        <Kpi label="Win rate" value={stats.winRate == null ? "—" : `${stats.winRate.toFixed(0)}%`} />
        <Kpi label="Avg win" value={fmtSignedUsd(stats.avgWin)} cls={pnlClass(stats.avgWin)} />
        <Kpi label="Avg loss" value={fmtSignedUsd(stats.avgLoss)} cls={pnlClass(stats.avgLoss)} />
        <Kpi label="Profit factor" value={stats.profitFactor == null ? "—" : stats.profitFactor.toFixed(2)} />
      </Card>

      <div className="flex flex-wrap gap-2">
        <select value={symbol} onChange={(e) => setSymbol(e.target.value)} className={selectCls} aria-label="Filter by market">
          <option value="all">All markets</option>
          {symbols.map((s) => (
            <option key={s} value={s}>
              {baseAsset(s)}
            </option>
          ))}
        </select>
        <select value={tag} onChange={(e) => setTag(e.target.value)} className={selectCls} aria-label="Filter by setup tag">
          <option value="all">All setups</option>
          {tags.map((t) => (
            <option key={t} value={t}>
              #{t}
            </option>
          ))}
        </select>
        <select
          value={outcome}
          onChange={(e) => setOutcome(e.target.value as typeof outcome)}
          className={selectCls}
          aria-label="Filter by outcome"
        >
          <option value="all">Wins & losses</option>
          <option value="win">Wins</option>
          <option value="loss">Losses</option>
        </select>
      </div>

      <Card className="overflow-hidden">
        {loading && !rows ? (
          <ListSkeleton />
        ) : !filtered.length ? (
          <EmptyState
            title={rows?.length ? "No trades match these filters" : "No closed trades yet"}
            body={rows?.length ? "Try clearing a filter." : "When you close a position it shows up here, ready to journal."}
          />
        ) : (
          <>
            <ul className="divide-y divide-line md:hidden">
              {filtered.map((r) => {
                const info = infos[r.symbol];
                return (
                  <li key={r.id}>
                    <Link href={`/journal/${r.id}`} className="block p-4 active:bg-panel-2">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold">{baseAsset(r.symbol)}</span>
                          <SideBadge side={r.side} />
                          <LevBadge leverage={r.leverage} />
                          {r.close_reason === "liquidated" && <LiqBadge />}
                        </div>
                        <div className={cx("num font-semibold", pnlClass(netPnl(r)))}>
                          {fmtSignedUsd(netPnl(r))} <span className="text-xs font-normal">{fmtPct(returnPct(r))}</span>
                        </div>
                      </div>
                      <div className="num mt-2 flex justify-between text-xs text-muted">
                        <span>
                          {fmtPrice(r.avg_entry, info?.priceDecimals)} → {fmtPrice(r.avg_exit, info?.priceDecimals)}
                        </span>
                        <span>{fmtDateTime(r.closed_at)}</span>
                      </div>
                      <JournalChips row={r} />
                    </Link>
                  </li>
                );
              })}
            </ul>

            <div className="hidden overflow-x-auto md:block">
              <table className="num w-full text-sm">
                <thead className="text-left text-xs text-muted">
                  <tr className="border-b border-line">
                    <th className="px-4 py-2.5 font-medium">Market</th>
                    <th className="px-4 py-2.5 font-medium text-right">Size</th>
                    <th className="px-4 py-2.5 font-medium text-right">Entry</th>
                    <th className="px-4 py-2.5 font-medium text-right">Exit</th>
                    <th className="px-4 py-2.5 font-medium text-right">Net PnL</th>
                    <th className="px-4 py-2.5 font-medium text-right">Held</th>
                    <th className="px-4 py-2.5 font-medium text-right">Closed</th>
                    <th className="px-4 py-2.5 font-medium">Journal</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((r) => {
                    const info = infos[r.symbol];
                    return (
                      <tr key={r.id} className="border-b border-line/60 last:border-0 hover:bg-panel-2/50">
                        <td className="px-4 py-3">
                          <Link href={`/journal/${r.id}`} className="flex items-center gap-2">
                            <span className="font-semibold">{baseAsset(r.symbol)}</span>
                            <SideBadge side={r.side} />
                          <LevBadge leverage={r.leverage} />
                          {r.close_reason === "liquidated" && <LiqBadge />}
                          </Link>
                        </td>
                        <td className="px-4 py-3 text-right">{fmtQty(r.entry_qty, info?.qtyDecimals)}</td>
                        <td className="px-4 py-3 text-right">{fmtPrice(r.avg_entry, info?.priceDecimals)}</td>
                        <td className="px-4 py-3 text-right">{fmtPrice(r.avg_exit, info?.priceDecimals)}</td>
                        <td className={cx("px-4 py-3 text-right font-semibold", pnlClass(netPnl(r)))}>
                          {fmtSignedUsd(netPnl(r))} <span className="text-xs font-normal">{fmtPct(returnPct(r))}</span>
                        </td>
                        <td className="px-4 py-3 text-right text-muted">{fmtDuration(r.opened_at, r.closed_at)}</td>
                        <td className="px-4 py-3 text-right text-muted">{fmtDateTime(r.closed_at)}</td>
                        <td className="px-4 py-3">
                          <Link href={`/journal/${r.id}`} className="block">
                            {r.journal ? (
                              <JournalChips row={r} inline />
                            ) : (
                              <span className="text-xs text-accent">Add notes →</span>
                            )}
                          </Link>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}

function Kpi({ label, value, cls }: { label: string; value: string; cls?: string }) {
  return (
    <div>
      <div className="text-xs text-muted">{label}</div>
      <div className={cx("text-base font-semibold", cls)}>{value}</div>
    </div>
  );
}

function JournalChips({ row, inline }: { row: HistoryRow; inline?: boolean }) {
  const j = row.journal;
  if (!j) return inline ? null : <div className="mt-2 text-xs text-accent">Add notes →</div>;
  return (
    <div className={cx("flex flex-wrap items-center gap-1", !inline && "mt-2")}>
      {j.rating ? <span className="text-xs text-amber-400">{"★".repeat(j.rating)}</span> : null}
      {j.tags.slice(0, 3).map((t) => (
        <span key={t} className="rounded bg-accent-soft px-1.5 py-0.5 text-[11px] text-accent">
          #{t}
        </span>
      ))}
      {j.notes && !j.tags.length && <span className="text-xs text-muted">Notes</span>}
    </div>
  );
}
