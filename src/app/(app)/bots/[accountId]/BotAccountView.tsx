"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useBotAccount } from "@/hooks/useBots";
import { usePrices } from "@/hooks/useMarket";
import { BOT_GOAL, BOT_SYMBOLS, botEquity, botStats, botUnrealized, fmtR } from "@/lib/bots";
import { baseAsset, fmtDateTime, fmtDuration, fmtPct, fmtPrice, fmtSignedUsd, fmtUsd, pnlClass } from "@/lib/format";
import { EquityChart } from "@/components/EquityChart";
import { ExitBadge, Kpi, RulesText, TfBadge } from "@/components/BotBits";
import { LevBadge } from "@/components/PositionsList";
import { Card, EmptyState, SideBadge, Skeleton, cx } from "@/components/ui";

const priceDp = (p: number) => (p >= 1000 ? 2 : p >= 10 ? 3 : 4);

export function BotAccountView({ accountId }: { accountId: string }) {
  const { data, loading } = useBotAccount(accountId);
  const prices = usePrices(BOT_SYMBOLS);
  const [showLog, setShowLog] = useState(false);

  const a = data?.account;
  const open = useMemo(() => (data?.trades ?? []).filter((t) => t.status === "open"), [data]);
  const closed = useMemo(() => (data?.trades ?? []).filter((t) => t.status === "closed"), [data]);
  const stats = useMemo(() => (a ? botStats(a.start_balance, closed, a.created_at) : null), [a, closed]);

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-3 lg:p-6">
      <Link href="/bots" className="inline-flex h-10 items-center gap-1 text-sm text-muted hover:text-fg">
        <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2.5">
          <path d="m15 18-6-6 6-6" />
        </svg>
        Bots
      </Link>

      {loading && !data ? (
        <Skeleton className="h-96" />
      ) : !a || !stats ? (
        <Card>
          <EmptyState title="Bot account not found" />
        </Card>
      ) : (
        <>
          <Card className="p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <h1 className="text-xl font-bold">{data.strategy?.name ?? a.strategy}</h1>
                <TfBadge tf={a.timeframe} />
                {a.status === "busted" && <span className="rounded bg-amber-400/15 px-1.5 py-0.5 text-[11px] font-bold text-amber-400">BUSTED</span>}
              </div>
              {(() => {
                const eq = botEquity(a, open, prices);
                return (
                  <div className="num text-right">
                    <div className="text-xl font-bold">{fmtUsd(eq)}</div>
                    <div className={cx("text-sm", pnlClass(eq - a.start_balance))}>
                      {fmtSignedUsd(eq - a.start_balance)} ({fmtPct(((eq - a.start_balance) / a.start_balance) * 100)})
                    </div>
                  </div>
                );
              })()}
            </div>
            <div className="num mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4 lg:grid-cols-7">
              <Kpi label="Closed trades" value={String(stats.trades)} />
              <Kpi label="Win rate" value={stats.winRate == null ? "—" : `${stats.winRate.toFixed(0)}%`} />
              <Kpi label="Profit factor" value={stats.profitFactor == null ? "—" : stats.profitFactor.toFixed(2)} />
              <Kpi label="Avg trade" value={fmtR(stats.avgR)} cls={pnlClass(stats.avgR)} />
              <Kpi label="Realized" value={fmtSignedUsd(stats.net)} cls={pnlClass(stats.net)} />
              <Kpi label="Max drawdown" value={`${stats.maxDrawdownPct.toFixed(1)}%`} sub="realized" />
              <Kpi label="Fees paid" value={fmtUsd(stats.fees)} />
            </div>
          </Card>

          <Card className="overflow-hidden">
            <div className="border-b border-line px-4 py-3 text-sm font-semibold">Realized equity</div>
            <div className="h-56 px-1 sm:h-64">
              {stats.curve.length > 1 ? (
                <EquityChart points={stats.curve} start={a.start_balance} goal={BOT_GOAL} />
              ) : (
                <EmptyState title="No closed trades yet" body="The curve starts at the first exit." />
              )}
            </div>
          </Card>

          <div className="grid gap-4 lg:grid-cols-5">
            <div className="space-y-4 lg:col-span-3">
              {open.length > 0 && (
                <Card className="overflow-hidden">
                  <div className="border-b border-line px-4 py-3 text-sm font-semibold">Open</div>
                  <ul className="num divide-y divide-line text-sm">
                    {open.map((t) => {
                      const u = botUnrealized(t, prices[t.symbol]);
                      return (
                        <li key={t.id}>
                          <Link href={`/bots/trade/${t.id}`} className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-panel-2/50">
                            <div className="flex items-center gap-2">
                              <span className="font-semibold">{baseAsset(t.symbol)}</span>
                              <SideBadge side={t.side} />
                              <LevBadge leverage={t.leverage} />
                              <span className="text-xs text-muted">
                                @ {fmtPrice(t.entry_price, priceDp(t.entry_price))} · stop {fmtPrice(t.stop_price, priceDp(t.entry_price))}
                              </span>
                            </div>
                            <span className={cx("font-semibold", pnlClass(u))}>{fmtSignedUsd(u)}</span>
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                </Card>
              )}

              <Card className="overflow-hidden">
                <div className="border-b border-line px-4 py-3 text-sm font-semibold">Closed trades</div>
                {!closed.length ? (
                  <EmptyState title="No closed trades yet" />
                ) : (
                  <ul className="num divide-y divide-line text-sm">
                    {closed.map((t) => (
                      <li key={t.id}>
                        <Link href={`/bots/trade/${t.id}`} className="block px-4 py-3 hover:bg-panel-2/50">
                          <div className="flex items-center justify-between gap-2">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="font-semibold">{baseAsset(t.symbol)}</span>
                              <SideBadge side={t.side} />
                              <LevBadge leverage={t.leverage} />
                              <ExitBadge reason={t.exit_reason} />
                            </div>
                            <div className={cx("text-right font-semibold", pnlClass(t.net_pnl))}>
                              {fmtSignedUsd(t.net_pnl)} <span className="text-xs font-normal">{fmtR(t.r_multiple)}</span>
                            </div>
                          </div>
                          <div className="mt-1 flex justify-between text-xs text-muted">
                            <span>
                              {fmtPrice(t.entry_price, priceDp(t.entry_price))} → {fmtPrice(t.exit_price, priceDp(t.entry_price))} · held {fmtDuration(t.opened_at, t.closed_at)}
                            </span>
                            <span>{fmtDateTime(t.closed_at)}</span>
                          </div>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </div>

            <div className="space-y-4 lg:col-span-2">
              {data.strategy && (
                <Card className="p-4">
                  <div className="mb-2 text-sm font-semibold">Rules</div>
                  <RulesText text={data.strategy.rules} />
                  <p className="mt-3 text-xs text-faint">
                    Sizing: each trade risks a fixed share of this account&apos;s equity (2% by default) from entry to stop, fees included, at the lowest leverage
                    (20x max by default) that fits a third of the equity as margin. Each trade&apos;s page shows its exact numbers.
                  </p>
                </Card>
              )}
              <Card className="overflow-hidden">
                <button className="flex w-full items-center justify-between px-4 py-3 text-sm font-semibold" onClick={() => setShowLog((v) => !v)}>
                  Bot log
                  <span className="text-xs font-normal text-muted">{showLog ? "Hide" : `Show ${data.events.length}`}</span>
                </button>
                {showLog && (
                  <ul className="max-h-[480px] divide-y divide-line overflow-y-auto border-t border-line text-sm">
                    {data.events.map((e) => (
                      <li key={e.id} className="px-4 py-2.5">
                        <div className="flex justify-between text-xs">
                          <span className={cx("font-semibold uppercase", e.kind === "error" ? "text-down" : "text-muted")}>
                            {e.kind.replace("_", " ")} {e.symbol ? `· ${baseAsset(e.symbol)}` : ""}
                          </span>
                          <span className="text-faint">{fmtDateTime(e.created_at)}</span>
                        </div>
                        <div className="mt-0.5 text-muted">{e.message}</div>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
