"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useBotsOverview } from "@/hooks/useBots";
import { usePrices } from "@/hooks/useMarket";
import { createClient } from "@/lib/supabase/client";
import { bumpData, toast } from "@/lib/store";
import { BOT_GOAL, BOT_SYMBOLS, BOT_TIMEFRAMES, botEquity, fmtR } from "@/lib/bots";
import { baseAsset, fmtDateTime, fmtPct, fmtSignedUsd, fmtUsd, pnlClass } from "@/lib/format";
import type { BotAccount, BotTrade } from "@/lib/types";
import { HealthPill, Kpi, runnerHealth } from "@/components/BotBits";
import { Button, Card, EmptyState, SideBadge, Skeleton, cx } from "@/components/ui";

export function BotsView() {
  const { data, loading, error } = useBotsOverview();
  const prices = usePrices(BOT_SYMBOLS);
  const [busy, setBusy] = useState(false);

  const rows = useMemo(() => {
    if (!data) return [];
    return data.accounts.map((a) => {
      const open = data.openTrades.filter((t) => t.account_id === a.id);
      const closed = data.closedTrades.filter((t) => t.account_id === a.id);
      const equity = botEquity(a, open, prices);
      const wins = closed.filter((t) => (t.net_pnl ?? 0) > 0).length;
      return {
        a,
        open,
        equity,
        ret: ((equity - a.start_balance) / a.start_balance) * 100,
        trades: closed.length,
        winRate: closed.length ? (wins / closed.length) * 100 : null,
      };
    });
  }, [data, prices]);

  async function setEnabled(enabled: boolean) {
    setBusy(true);
    try {
      const sb = createClient();
      const { data: u } = await sb.auth.getUser();
      if (!u.user) throw new Error("Not signed in");
      const { error: e } = await sb.from("bot_settings").upsert({ user_id: u.user.id, enabled, updated_at: new Date().toISOString() });
      if (e) throw new Error(e.message);
      toast("success", enabled ? "Bots enabled" : "Bots paused", enabled ? "The accounts are created within a minute of the next run." : "Open trades are still managed until they exit.");
      bumpData();
    } catch (e) {
      toast("error", "Couldn't update bots", (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (loading && !data)
    return (
      <div className="mx-auto max-w-6xl space-y-4 p-3 lg:p-6">
        <Skeleton className="h-24" />
        <Skeleton className="h-96" />
      </div>
    );

  if (error && !data)
    return (
      <div className="mx-auto max-w-3xl p-3 lg:p-6">
        <Card>
          <EmptyState
            title="Bot tables not found"
            body={/does not exist|schema cache/i.test(error) ? "Run supabase/bot.sql in the Supabase SQL Editor. See docs/strategies/SETUP.md." : error}
          />
        </Card>
      </div>
    );

  const d = data!;
  const health = runnerHealth(d.runtime);
  const totalStart = rows.reduce((s, r) => s + r.a.start_balance, 0);
  const totalEq = rows.reduce((s, r) => s + r.equity, 0);
  const best = [...rows].sort((x, y) => y.equity - x.equity)[0];
  const closedAll = d.closedTrades;
  const winsAll = closedAll.filter((t) => (t.net_pnl ?? 0) > 0).length;
  const busted = rows.filter((r) => r.a.status === "busted").length;
  const byKey = new Map(rows.map((r) => [`${r.a.strategy}:${r.a.timeframe}`, r]));

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-3 lg:p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Strategy bots</h1>
          <p className="text-sm text-muted">
            Every strategy × 6 timeframes (the news-aware ones next to their plain twins), each a separate ${d.settings?.start_balance ?? 100} paper account trading {BOT_SYMBOLS.map(baseAsset).join(" / ")}.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/bots/insights" className="inline-flex h-9 items-center rounded-lg border border-line px-3 text-sm font-semibold hover:bg-panel-2">
            AI analysis
          </Link>
          <HealthPill rt={d.runtime} />
          {d.settings && (
            <Button size="sm" variant={d.settings.enabled ? "outline" : "primary"} loading={busy} onClick={() => setEnabled(!d.settings!.enabled)}>
              {d.settings.enabled ? "Pause new entries" : "Resume"}
            </Button>
          )}
        </div>
      </div>

      {!d.settings ? (
        <Card className="p-5">
          <h2 className="font-semibold">Start the strategy test</h2>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted">
            <li>Creates isolated accounts, one per strategy and timeframe, with $100 each.</li>
            <li>Each trade risks 2% of that account&apos;s equity with leverage of at most 20x, and its liquidation price always sits beyond the stop.</li>
            <li>Every entry, stop move and exit is written up with the reason and the indicator readings.</li>
          </ul>
          <Button className="mt-4" loading={busy} onClick={() => setEnabled(true)}>
            Start bots
          </Button>
        </Card>
      ) : health.state === "never" || health.state === "stale" ? (
        <Card className="border-amber-400/40 p-4 text-sm">
          <div className="font-semibold text-amber-400">The bot runner isn&apos;t running</div>
          <p className="mt-1 text-muted">
            Bots trade from a Supabase cron job that runs every minute. Deploy the <code>bot-tick</code> function and schedule it (docs/strategies/SETUP.md). Nothing
            trades until it runs.
          </p>
        </Card>
      ) : health.state === "error" ? (
        <Card className="border-amber-400/40 p-4 text-sm">
          <div className="font-semibold text-amber-400">Last run reported an error</div>
          <p className="mt-1 break-words text-muted">{d.runtime?.last_error}</p>
        </Card>
      ) : null}

      {rows.length > 0 && (
        <>
          <Card className="num grid grid-cols-2 gap-4 p-4 sm:grid-cols-3 lg:grid-cols-6">
            <Kpi label={`All ${rows.length} accounts`} value={fmtUsd(totalEq)} sub={`from ${fmtUsd(totalStart)}`} />
            <Kpi label="Net" value={fmtSignedUsd(totalEq - totalStart)} cls={pnlClass(totalEq - totalStart)} sub={fmtPct(totalStart ? ((totalEq - totalStart) / totalStart) * 100 : null)} />
            <Kpi label="Closed trades" value={String(closedAll.length)} sub={closedAll.length ? `${((winsAll / closedAll.length) * 100).toFixed(0)}% winners` : undefined} />
            <Kpi label="Open trades" value={String(d.openTrades.length)} />
            <Kpi label="Best account" value={best ? fmtUsd(best.equity) : "—"} cls={pnlClass(best ? best.ret : 0)} sub={best ? `${nameOf(d, best.a.strategy)} · ${best.a.timeframe}` : undefined} />
            <Kpi label="Busted" value={String(busted)} sub="under $10 left" />
          </Card>

          <GoalCard best={best} />

          <div className="space-y-3">
            {d.strategies
              .filter((s) => rows.some((r) => r.a.strategy === s.key))
              .map((s) => (
                <Card key={s.key} className="p-4">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <h2 className="font-semibold">{s.name}</h2>
                    <span className="text-xs text-faint">v{s.version}</span>
                  </div>
                  <p className="mt-0.5 text-sm text-muted">{s.summary}</p>
                  <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-6">
                    {BOT_TIMEFRAMES.map((tf) => {
                      const r = byKey.get(`${s.key}:${tf}`);
                      if (!r) return <div key={tf} className="rounded-lg border border-dashed border-line p-2 text-xs text-faint">{tf}</div>;
                      return <Cell key={tf} tf={tf} r={r} />;
                    })}
                  </div>
                </Card>
              ))}
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <OpenTrades trades={d.openTrades} prices={prices} />
            <Activity data={d} />
          </div>
        </>
      )}
    </div>
  );
}

function nameOf(d: { strategies: { key: string; name: string }[] }, key: string) {
  return d.strategies.find((s) => s.key === key)?.name ?? key;
}

type Row = { a: BotAccount; open: BotTrade[]; equity: number; ret: number; trades: number; winRate: number | null };

function Cell({ tf, r }: { tf: string; r: Row }) {
  const bg = r.ret > 0.05 ? "bg-up-soft" : r.ret < -0.05 ? "bg-down-soft" : "bg-panel-2";
  return (
    <Link href={`/bots/${r.a.id}`} className={cx("num block rounded-lg p-2 transition hover:ring-1 hover:ring-accent", bg)}>
      <div className="flex items-center justify-between text-xs">
        <span className="font-bold text-fg">{tf}</span>
        {r.a.status === "busted" ? <span className="text-amber-400">busted</span> : r.open.length ? <span className="text-accent">{r.open.length} open</span> : null}
      </div>
      <div className="mt-1 text-sm font-semibold">{fmtUsd(r.equity)}</div>
      <div className={cx("text-xs", pnlClass(r.ret))}>{fmtPct(r.ret)}</div>
      <div className="text-[11px] text-faint">
        {r.trades} trades{r.winRate != null ? ` · ${r.winRate.toFixed(0)}%` : ""}
      </div>
    </Link>
  );
}

function GoalCard({ best }: { best: Row | undefined }) {
  if (!best) return null;
  const pct = Math.max(0, Math.min(100, ((best.equity - best.a.start_balance) / (BOT_GOAL - best.a.start_balance)) * 100));
  return (
    <Card className="p-4">
      <div className="flex items-baseline justify-between text-sm">
        <span className="font-semibold">Goal: ${best.a.start_balance} → ${BOT_GOAL}</span>
        <span className="num text-muted">
          best account {fmtUsd(best.equity)} · {pct.toFixed(0)}% of the way
        </span>
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-panel-2" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
        <div className="h-full rounded-full bg-amber-400" style={{ width: `${pct}%` }} />
      </div>
      <p className="mt-2 text-xs text-faint">
        A 5× month is a stretch target, not the plan. Risk stays at 2% per trade, so a bad week can&apos;t wipe an account.
      </p>
    </Card>
  );
}

function OpenTrades({ trades, prices }: { trades: BotTrade[]; prices: Record<string, number> }) {
  return (
    <Card className="overflow-hidden">
      <div className="border-b border-line px-4 py-3 text-sm font-semibold">Open trades</div>
      {!trades.length ? (
        <EmptyState title="No open trades" body="Bots wait for their setups. Most bars produce no signal." />
      ) : (
        <ul className="num divide-y divide-line text-sm">
          {trades.map((t) => {
            const mark = prices[t.symbol];
            const pnl = mark == null ? null : Math.max((t.side === "long" ? mark - t.entry_price : t.entry_price - mark) * t.qty, -t.margin);
            return (
              <li key={t.id}>
                <Link href={`/bots/trade/${t.id}`} className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-panel-2/50">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold">{baseAsset(t.symbol)}</span>
                    <SideBadge side={t.side} />
                    <span className="text-xs text-muted">
                      {t.strategy} · {t.timeframe}
                    </span>
                  </div>
                  <div className={cx("font-semibold", pnlClass(pnl))}>{fmtSignedUsd(pnl)}</div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

function Activity({ data }: { data: { events: { id: number; kind: string; message: string; created_at: string; trade_id: string | null }[]; closedTrades: BotTrade[] } }) {
  const r = new Map(data.closedTrades.map((t) => [t.id, t.r_multiple]));
  return (
    <Card className="overflow-hidden">
      <div className="border-b border-line px-4 py-3 text-sm font-semibold">Recent activity</div>
      {!data.events.length ? (
        <EmptyState title="Nothing yet" body="Entries, exits and stop moves show up here." />
      ) : (
        <ul className="max-h-[420px] divide-y divide-line overflow-y-auto text-sm">
          {data.events.map((e) => {
            const inner = (
              <>
                <div className="flex items-center justify-between gap-2 text-xs">
                  <span className={cx("font-semibold uppercase", e.kind === "error" ? "text-down" : e.kind === "opened" ? "text-accent" : "text-muted")}>
                    {e.kind.replace("_", " ")}
                    {e.kind === "closed" && e.trade_id && r.get(e.trade_id) != null ? ` · ${fmtR(r.get(e.trade_id))}` : ""}
                  </span>
                  <span className="text-faint">{fmtDateTime(e.created_at)}</span>
                </div>
                <div className="mt-0.5 line-clamp-2 text-muted">{e.message}</div>
              </>
            );
            return (
              <li key={e.id}>
                {e.trade_id ? (
                  <Link href={`/bots/trade/${e.trade_id}`} className="block px-4 py-2.5 hover:bg-panel-2/50">
                    {inner}
                  </Link>
                ) : (
                  <div className="px-4 py-2.5">{inner}</div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
