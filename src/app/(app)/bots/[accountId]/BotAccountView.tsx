"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useBotAccount } from "@/hooks/useBots";
import { usePrices } from "@/hooks/useMarket";
import { AGGRO_KEY, BOT_GOAL, BOT_SYMBOLS, botEquity, botStats, botUnrealized, fmtR, playbookCellLabel, playbookSlope, playbookSummary, type PlaybookRow } from "@/lib/bots";
import { createClient } from "@/lib/supabase/client";
import { bumpData, toast } from "@/lib/store";
import type { BotAccount } from "@/lib/types";
import { baseAsset, fmtDateTime, fmtDuration, fmtPct, fmtPrice, fmtSignedUsd, fmtUsd, pnlClass } from "@/lib/format";
import { EquityChart } from "@/components/EquityChart";
import { ExitBadge, Kpi, RulesText, TfBadge } from "@/components/BotBits";
import { LevBadge } from "@/components/PositionsList";
import { Card, ConfirmButton, EmptyState, SideBadge, Skeleton, cx } from "@/components/ui";

const priceDp = (p: number) => (p >= 1000 ? 2 : p >= 10 ? 3 : 4);

export function BotAccountView({ accountId }: { accountId: string }) {
  const { data, loading } = useBotAccount(accountId);
  const prices = usePrices(BOT_SYMBOLS);
  const [showLog, setShowLog] = useState(false);

  const a = data?.account;
  const open = useMemo(() => (data?.trades ?? []).filter((t) => t.status === "open"), [data]);
  const closed = useMemo(() => (data?.trades ?? []).filter((t) => t.status === "closed"), [data]);
  const isAggro = a?.strategy === AGGRO_KEY;
  // An aggressive account starts again at its starting balance with every life, so its numbers are those of the current life.
  const closedNow = useMemo(() => (a && isAggro ? closed.filter((t) => (t.life ?? 1) === a.life) : closed), [a, isAggro, closed]);
  const stats = useMemo(() => (a ? botStats(a.start_balance, closedNow, (isAggro && a.life_started_at) || a.created_at) : null), [a, isAggro, closedNow]);

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
                {isAggro && <span className="rounded bg-panel-2 px-1.5 py-0.5 text-[11px] font-bold text-muted">LIFE {a.life}</span>}
                {isAggro && <Redeploy account={a} />}
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
              <Kpi label="Closed trades" value={String(stats.trades)} sub={isAggro ? `life ${a.life}` : undefined} />
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
                              {t.aggro && <span className="text-xs text-muted">{t.aggro.src}</span>}
                              {isAggro && (t.life ?? 1) !== a.life && <span className="text-xs text-faint">life {t.life ?? 1}</span>}
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
              {isAggro && <PlaybookCard account={a} />}
              {isAggro && <LivesCard account={a} />}
              {data.strategy && (
                <Card className="p-4">
                  <div className="mb-2 text-sm font-semibold">Rules</div>
                  <RulesText text={data.strategy.rules} />
                  <p className="mt-3 text-xs text-faint">
                    {isAggro
                      ? "Sizing: the playbook sets the risk of each trade from what it expects of the signal. Leverage stays at the lowest that fits a third of the equity as margin (20x max by default), so the risk actually taken can be lower. Each trade's page shows its exact numbers."
                      : "Sizing: each trade risks a fixed share of this account's equity (2% by default) from entry to stop, fees included, at the lowest leverage (20x max by default) that fits a third of the equity as margin. Each trade's page shows its exact numbers."}
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

/** Ends the current life and starts the next at the starting balance, keeping the playbook. The next bot run carries it out. */
function Redeploy({ account }: { account: BotAccount }) {
  const [busy, setBusy] = useState(false);
  if (account.redeploy_requested_at) return <span className="text-xs text-amber-400">Redeploy requested: the next life starts within a minute</span>;

  async function request() {
    setBusy(true);
    try {
      const { error } = await createClient().rpc("bot_request_redeploy", { p_account_id: account.id });
      if (error) throw new Error(/Could not find the function|schema cache/i.test(error.message) ? "Database is out of date. Re-run supabase/bot.sql in the Supabase SQL Editor." : error.message);
      toast("success", "Redeploy requested", "The next bot run closes what is open, writes this life's post-mortem and starts the next life. The playbook is kept.");
      bumpData();
    } catch (e) {
      toast("error", "Couldn't redeploy", (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return <ConfirmButton label="Redeploy" confirmLabel={account.status === "busted" ? "Start next life?" : "End this life?"} loading={busy} onConfirm={request} />;
}

function PlaybookRows({ rows }: { rows: PlaybookRow[] }) {
  return (
    <ul className="num mt-1 space-y-0.5 text-xs">
      {rows.map((r) => (
        <li key={r.key} className="flex items-baseline justify-between gap-2">
          <span className="text-muted">{playbookCellLabel(r.key)}</span>
          <span className="shrink-0">
            <span className={pnlClass(r.avgR)}>{fmtR(r.avgR)}</span> <span className="text-faint">· {r.n}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/** What the account has learned so far: each rule set's record, the contexts that paid and the ones that cost. */
function PlaybookCard({ account }: { account: BotAccount }) {
  const pb = account.playbook;
  const sum = playbookSummary(pb);
  const cal = playbookSlope(pb);
  const day = pb?.day && pb.day.life === account.life ? pb.day : null;
  return (
    <Card className="p-4">
      <div className="flex items-baseline justify-between">
        <div className="text-sm font-semibold">Playbook</div>
        {pb && <span className="text-xs text-faint">{pb.learned} outcomes learned live</span>}
      </div>
      {!pb ? (
        <p className="mt-2 text-sm text-muted">The playbook is created by the first bot run.</p>
      ) : (
        <>
          <p className="mt-1 text-xs text-muted">
            Average result in R of every signal seen in a context, traded or not (after slippage; the number after the dot is the sample count). It starts from a replay of
            the past year and keeps learning.
          </p>
          {cal && (
            <p className="mt-2 text-xs text-muted">
              Checked against {cal.checked} outcomes, signals averaged <span className={pnlClass(cal.avgR)}>{fmtR(cal.avgR)}</span>.{" "}
              {cal.slope < 0
                ? `A good record has lately been followed by worse results (slope ${cal.slope.toFixed(2)}), so the playbook bets against the record.`
                : `A good record has kept paying (slope ${cal.slope.toFixed(2)}), so the playbook bets with it.`}
            </p>
          )}
          {day && <p className="mt-2 text-xs text-faint">Today started at {fmtUsd(day.start)} ({day.date} UTC): entries stop at +10% or −15% on the day.</p>}
          <div className="mt-3 text-xs font-semibold text-muted">Rule sets</div>
          <PlaybookRows rows={sum.ruleSets} />
          {sum.best.length > 0 && (
            <>
              <div className="mt-3 text-xs font-semibold text-muted">Best contexts</div>
              <PlaybookRows rows={sum.best} />
              <div className="mt-3 text-xs font-semibold text-muted">Worst contexts</div>
              <PlaybookRows rows={sum.worst} />
            </>
          )}
        </>
      )}
    </Card>
  );
}

/** The lives that have ended, newest first, each with its post-mortem. */
function LivesCard({ account }: { account: BotAccount }) {
  const lives = [...(account.playbook?.lives ?? [])].sort((x, y) => y.life - x.life);
  return (
    <Card className="p-4">
      <div className="text-sm font-semibold">Lives</div>
      {!lives.length ? (
        <p className="mt-2 text-sm text-muted">
          Life {account.life} is the first. When the account busts (under $10), Redeploy starts the next life at {fmtUsd(account.start_balance)} with the playbook kept.
        </p>
      ) : (
        <ul className="mt-2 space-y-3 text-sm">
          {lives.map((l) => (
            <li key={l.life}>
              <div className="num flex items-baseline justify-between gap-2 text-xs">
                <span className="font-semibold">
                  Life {l.life} · {l.cause}
                </span>
                <span className="text-faint">
                  {l.trades} trades · peak {fmtUsd(l.peak)} · ended {fmtUsd(l.end)} · {fmtDateTime(l.ended_at)}
                </span>
              </div>
              <p className="mt-0.5 text-xs text-muted">{l.summary}</p>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
