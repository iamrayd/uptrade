"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useBotsOverview } from "@/hooks/useBots";
import { usePrices } from "@/hooks/useMarket";
import { createClient } from "@/lib/supabase/client";
import { bumpData, toast } from "@/lib/store";
import { BOT_SYMBOLS, BOT_TIMEFRAMES, ENOUGH_TRADES, botEquity, fmtR } from "@/lib/bots";
import { baseAsset, fmtDateTime, fmtPct, fmtSignedUsd, fmtUsd, pnlClass } from "@/lib/format";
import type { BotAccount, BotEvent, BotStrategy, BotTrade } from "@/lib/types";
import { HealthPill, Kpi, runnerHealth } from "@/components/BotBits";
import { BotsTabs, Glossary } from "@/components/BotNav";
import { Button, Card, EmptyState, SideBadge, Skeleton, cx } from "@/components/ui";

type Row = { a: BotAccount; open: BotTrade[]; closed: BotTrade[]; equity: number; ret: number; winRate: number | null };

export function BotsView() {
  const { data, loading, error } = useBotsOverview();
  const prices = usePrices(BOT_SYMBOLS);
  const [busy, setBusy] = useState(false);

  const rows = useMemo<Row[]>(() => {
    if (!data) return [];
    return data.accounts.map((a) => {
      const open = data.openTrades.filter((t) => t.account_id === a.id);
      const closed = data.closedTrades.filter((t) => t.account_id === a.id);
      const equity = botEquity(a, open, prices);
      const wins = closed.filter((t) => (t.net_pnl ?? 0) > 0).length;
      return { a, open, closed, equity, ret: ((equity - a.start_balance) / a.start_balance) * 100, winRate: closed.length ? (wins / closed.length) * 100 : null };
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
      toast("success", enabled ? "Bots started" : "New entries paused", enabled ? "The accounts appear within a minute." : "Open trades are still managed until they exit.");
      bumpData();
    } catch (e) {
      toast("error", "Couldn't update bots", (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (loading && !data)
    return (
      <Page>
        <Skeleton className="h-24" />
        <Skeleton className="h-96" />
      </Page>
    );

  if (error && !data)
    return (
      <Page>
        <Card>
          <EmptyState
            title="Bot tables not found"
            body={/does not exist|schema cache/i.test(error) ? "Run supabase/bot.sql in the Supabase SQL Editor. See docs/strategies/SETUP.md." : error}
          />
        </Card>
      </Page>
    );

  const d = data!;
  const health = runnerHealth(d.runtime);
  const totalStart = rows.reduce((s, r) => s + r.a.start_balance, 0);
  const totalEq = rows.reduce((s, r) => s + r.equity, 0);
  const closedAll = d.closedTrades;
  const winsAll = closedAll.filter((t) => (t.net_pnl ?? 0) > 0).length;
  const busted = rows.filter((r) => r.a.status === "busted").length;
  const name = (key: string) => d.strategies.find((s) => s.key === key)?.name ?? key;
  // Only the rule sets that have accounts: an older one left in the table is not shown.
  const ruleSets = d.strategies.filter((s) => rows.some((r) => r.a.strategy === s.key));

  return (
    <Page>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-2xl">
          <h1 className="text-xl font-bold tracking-tight">Strategy bots</h1>
          <p className="mt-0.5 text-sm text-muted">
            {ruleSets.length || 5} rule sets trade {BOT_SYMBOLS.map(baseAsset).join(", ")} on their own, each on {BOT_TIMEFRAMES.join(", ")} charts with a separate $
            {d.settings?.start_balance ?? 100} paper account. Every signal is traded.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <HealthPill rt={d.runtime} />
          {d.settings && (
            <Button size="sm" variant={d.settings.enabled ? "outline" : "primary"} loading={busy} onClick={() => setEnabled(!d.settings!.enabled)}>
              {d.settings.enabled ? "Pause new entries" : "Resume entries"}
            </Button>
          )}
        </div>
      </div>

      <BotsTabs />

      {!d.settings ? (
        <Card className="p-5">
          <h2 className="font-semibold">Start the bots</h2>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted">
            <li>Creates 15 separate paper accounts, one per rule set and chart timeframe, with $100 each.</li>
            <li>Every signal a rule set gives is traded. Nothing filters or holds back an entry.</li>
            <li>Each trade risks 2% of its account, with a stop that is always hit before liquidation.</li>
            <li>Every entry, stop move and exit is written up with the reason.</li>
          </ul>
          <Button className="mt-4" loading={busy} onClick={() => setEnabled(true)}>
            Start bots
          </Button>
        </Card>
      ) : health.state === "never" || health.state === "stale" ? (
        <Notice title="The bots are not running">
          They trade from a Supabase job that runs every minute, and it {health.state === "never" ? "has never run" : "has stopped"}. Deploy the <code>bot-tick</code> function and
          schedule it (docs/strategies/SETUP.md). Nothing trades until it runs.
        </Notice>
      ) : health.state === "error" ? (
        <Notice title="The last run reported an error">{d.runtime?.last_error}</Notice>
      ) : !d.settings.enabled ? (
        <Notice title="New entries are paused">Open trades are still managed until they exit. Resume entries to let the bots open new ones.</Notice>
      ) : null}

      {rows.length > 0 && (
        <>
          <Card className="num grid grid-cols-2 gap-x-4 gap-y-5 p-4 lg:grid-cols-4">
            <Kpi label="Value of all accounts" value={<span className="text-xl">{fmtUsd(totalEq)}</span>} sub={`started with ${fmtUsd(totalStart)}`} />
            <Kpi
              label="Profit or loss"
              value={<span className="text-xl">{fmtSignedUsd(totalEq - totalStart)}</span>}
              cls={pnlClass(totalEq - totalStart)}
              sub={fmtPct(totalStart ? ((totalEq - totalStart) / totalStart) * 100 : null)}
            />
            <Kpi
              label="Closed trades"
              value={<span className="text-xl">{closedAll.length}</span>}
              sub={closedAll.length ? `${((winsAll / closedAll.length) * 100).toFixed(0)}% made money` : "none yet"}
            />
            <Kpi label="Open now" value={<span className="text-xl">{d.openTrades.length}</span>} sub={busted ? `${busted} account${busted > 1 ? "s" : ""} busted` : `${rows.length} accounts`} />
          </Card>

          <Scoreboard ruleSets={ruleSets} rows={rows} />

          <Glossary />

          <div className="grid gap-4 lg:grid-cols-2">
            <OpenTrades trades={d.openTrades} prices={prices} name={name} />
            <Activity events={d.events} closed={d.closedTrades} />
          </div>
        </>
      )}
    </Page>
  );
}

function Page({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto max-w-6xl space-y-4 p-3 lg:p-6">{children}</div>;
}

function Notice({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card className="border-amber-400/40 p-4 text-sm">
      <div className="font-semibold text-amber-400">{title}</div>
      <p className="mt-1 break-words text-muted">{children}</p>
    </Card>
  );
}

// ───────────────────────── Scoreboard ─────────────────────────

/** Each rule set over its timeframes, best result first. One row answers: is it making money, and is that more than luck yet? */
function Scoreboard({ ruleSets, rows }: { ruleSets: BotStrategy[]; rows: Row[] }) {
  const board = ruleSets
    .map((s) => {
      const mine = rows.filter((r) => r.a.strategy === s.key);
      const closed = mine.flatMap((r) => r.closed);
      const withR = closed.filter((t) => t.r_multiple != null);
      const wins = closed.filter((t) => (t.net_pnl ?? 0) > 0).length;
      return {
        s,
        mine,
        trades: closed.length,
        net: mine.reduce((x, r) => x + r.equity - r.a.start_balance, 0),
        avgR: withR.length ? withR.reduce((x, t) => x + t.r_multiple!, 0) / withR.length : null,
        winRate: closed.length ? (wins / closed.length) * 100 : null,
      };
    })
    .sort((x, y) => y.net - x.net);
  const cols = "md:grid-cols-[minmax(0,1.5fr)_repeat(3,minmax(0,1fr))_minmax(0,1.2fr)]";

  return (
    <Card className="overflow-hidden">
      <div className="border-b border-line px-4 py-3">
        <h2 className="text-sm font-semibold">Scoreboard</h2>
        <p className="mt-0.5 text-xs text-muted">Best result first. Tap an account to see its trades.</p>
      </div>
      <div className={cx("hidden gap-3 border-b border-line px-4 py-2 text-xs text-muted md:grid", cols)}>
        <span>Rule set</span>
        {BOT_TIMEFRAMES.map((tf) => (
          <span key={tf}>{tf} chart</span>
        ))}
        <span>All three together</span>
      </div>
      <ul className="divide-y divide-line">
        {board.map((b) => (
          <li key={b.s.key} className={cx("grid gap-3 px-4 py-4", cols)}>
            <div className="min-w-0">
              <h3 className="font-semibold">{b.s.name}</h3>
              <p className="mt-0.5 text-xs leading-relaxed text-muted">{b.s.summary}</p>
            </div>
            <div className="grid grid-cols-3 gap-2 md:contents">
              {BOT_TIMEFRAMES.map((tf) => {
                const r = b.mine.find((x) => x.a.timeframe === tf);
                return r ? <Cell key={tf} tf={tf} r={r} /> : <div key={tf} className="rounded-lg border border-dashed border-line p-2 text-xs text-faint">{tf}: not traded</div>;
              })}
            </div>
            <div className="num min-w-0">
              <div className="flex items-baseline justify-between gap-2">
                <span className={cx("text-base font-semibold", pnlClass(b.net))}>{fmtSignedUsd(b.net)}</span>
                <span className="text-xs text-muted">
                  {b.trades ? `${fmtR(b.avgR)} a trade, ${b.winRate!.toFixed(0)}% won` : "no closed trades"}
                </span>
              </div>
              <Enough trades={b.trades} />
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** How far a rule set is from having enough closed trades to judge it. */
function Enough({ trades }: { trades: number }) {
  const done = trades >= ENOUGH_TRADES;
  const pct = Math.min(100, (trades / ENOUGH_TRADES) * 100);
  return (
    <div className="mt-2">
      <div className="h-1.5 overflow-hidden rounded-full bg-panel-2" role="progressbar" aria-label="Closed trades toward enough to judge" aria-valuenow={Math.min(trades, ENOUGH_TRADES)} aria-valuemin={0} aria-valuemax={ENOUGH_TRADES}>
        <div className={cx("h-full rounded-full", done ? "bg-accent" : "bg-muted")} style={{ width: `${pct}%` }} />
      </div>
      <div className="mt-1 text-[11px] text-faint">{done ? `${trades} trades: enough to judge` : `${trades} of ${ENOUGH_TRADES} trades needed to judge`}</div>
    </div>
  );
}

function Cell({ tf, r }: { tf: string; r: Row }) {
  const bg = r.ret > 0.05 ? "bg-up-soft" : r.ret < -0.05 ? "bg-down-soft" : "bg-panel-2";
  return (
    <Link
      href={`/bots/${r.a.id}`}
      aria-label={`${tf} account: ${fmtUsd(r.equity)}, ${fmtPct(r.ret)}, ${r.closed.length} trades`}
      className={cx("num block rounded-lg p-2 transition hover:ring-1 hover:ring-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent", bg)}
    >
      <div className="flex items-center justify-between gap-1 text-[11px]">
        <span className="font-bold text-fg md:hidden">{tf}</span>
        {r.a.status === "busted" ? <span className="text-amber-400">busted</span> : r.open.length ? <span className="text-accent">{r.open.length} open</span> : <span className="hidden md:inline">&nbsp;</span>}
      </div>
      <div className={cx("text-sm font-semibold", pnlClass(r.ret))}>{fmtPct(r.ret)}</div>
      <div className="text-[11px] text-muted">{fmtUsd(r.equity)}</div>
      <div className="text-[11px] text-faint">
        {r.closed.length} trade{r.closed.length === 1 ? "" : "s"}
        {r.winRate != null ? `, ${r.winRate.toFixed(0)}% won` : ""}
      </div>
    </Link>
  );
}

// ───────────────────────── Open trades and activity ─────────────────────────

function OpenTrades({ trades, prices, name }: { trades: BotTrade[]; prices: Record<string, number>; name: (k: string) => string }) {
  return (
    <Card className="overflow-hidden">
      <div className="border-b border-line px-4 py-3 text-sm font-semibold">Open trades</div>
      {!trades.length ? (
        <EmptyState title="No open trades" body="A trade opens when a rule set gives a signal at the close of a bar. On 15m charts that is checked every quarter hour." />
      ) : (
        <ul className="num max-h-[420px] divide-y divide-line overflow-y-auto text-sm">
          {trades.map((t) => {
            const mark = prices[t.symbol];
            const pnl = mark == null ? null : Math.max((t.side === "long" ? mark - t.entry_price : t.entry_price - mark) * t.qty, -t.margin);
            return (
              <li key={t.id}>
                <Link href={`/bots/trade/${t.id}`} className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-panel-2/50">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold">{baseAsset(t.symbol)}</span>
                      <SideBadge side={t.side} />
                    </div>
                    <div className="mt-0.5 truncate text-xs text-muted">
                      {name(t.strategy)}, {t.timeframe} chart
                    </div>
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

const FILTERS = [
  { key: "all", label: "All" },
  { key: "opened", label: "Opened" },
  { key: "closed", label: "Closed" },
  { key: "skipped", label: "Not opened" },
  { key: "error", label: "Errors" },
] as const;
const KIND_LABEL: Record<string, string> = { opened: "Opened", closed: "Closed", skipped: "Not opened", error: "Error" };

function Activity({ events, closed }: { events: BotEvent[]; closed: BotTrade[] }) {
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["key"]>("all");
  const r = new Map(closed.map((t) => [t.id, t.r_multiple]));
  const shown = events.filter((e) => filter === "all" || e.kind === filter);
  return (
    <Card className="overflow-hidden">
      <div className="border-b border-line px-4 py-3">
        <div className="text-sm font-semibold">Recent activity</div>
        <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label="Show">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              aria-pressed={filter === f.key}
              onClick={() => setFilter(f.key)}
              className={cx(
                "h-8 rounded-full border px-3 text-xs font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
                filter === f.key ? "border-accent bg-accent-soft text-accent" : "border-line text-muted hover:text-fg",
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>
      {!shown.length ? (
        <EmptyState
          title={filter === "all" ? "Nothing yet" : filter === "skipped" ? "Every signal was opened" : `No ${filter === "error" ? "errors" : `${filter} trades`} lately`}
          body={filter === "skipped" ? "A signal is only left out when the account is busted, the price already moved past the stop or target, or the order would be too small." : "Entries and exits show up here as they happen."}
        />
      ) : (
        <ul className="max-h-[420px] divide-y divide-line overflow-y-auto text-sm">
          {shown.map((e) => {
            const inner = (
              <>
                <div className="flex items-center justify-between gap-2 text-xs">
                  <span className={cx("font-semibold", e.kind === "error" ? "text-down" : e.kind === "opened" ? "text-accent" : e.kind === "skipped" ? "text-amber-400" : "text-muted")}>
                    {KIND_LABEL[e.kind] ?? e.kind.replace("_", " ")}
                    {e.symbol ? ` ${baseAsset(e.symbol)}` : ""}
                    {e.timeframe ? `, ${e.timeframe}` : ""}
                    {e.kind === "closed" && e.trade_id && r.get(e.trade_id) != null ? `, ${fmtR(r.get(e.trade_id))}` : ""}
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
