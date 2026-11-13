"use client";

import Link from "next/link";
import { useState } from "react";
import { useBotInsights } from "@/hooks/useBots";
import { fmtR } from "@/lib/bots";
import { baseAsset, fmtDateTime, fmtPct, fmtSignedUsd, pnlClass } from "@/lib/format";
import type { BotReport, BotReportKind, BotSetupStats, BotStrategyRow, BotTimingRow, BotVerdict } from "@/lib/types";
import { AnalysisChat } from "@/components/AnalysisChat";
import { TfBadge } from "@/components/BotBits";
import { BotsTabs, Glossary } from "@/components/BotNav";
import { Card, EmptyState, Segmented, Skeleton, cx } from "@/components/ui";

const KINDS: { value: BotReportKind; label: string }[] = [
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
  { value: "hourly", label: "Hourly" },
];

const VERDICT: Record<BotVerdict, { label: string; cls: string }> = {
  live_ready: { label: "Ready for a small live test", cls: "bg-up-soft text-up" },
  promising: { label: "Promising", cls: "bg-accent-soft text-accent" },
  unproven: { label: "Unproven", cls: "bg-panel-2 text-muted" },
  needs_data: { label: "Needs more trades", cls: "bg-panel-2 text-faint" },
  avoid: { label: "Avoid", cls: "bg-down-soft text-down" },
};

export function InsightsView() {
  const { data, loading, error } = useBotInsights();
  const [kind, setKind] = useState<BotReportKind>("daily");

  if (loading && !data)
    return (
      <Shell>
        <Skeleton className="h-24" />
        <Skeleton className="h-96" />
      </Shell>
    );
  if (error && !data)
    return (
      <Shell>
        <Card>
          <EmptyState
            title="Analysis tables not found"
            body={/does not exist|schema cache/i.test(error) ? "Re-run supabase/bot.sql in the Supabase SQL Editor. See docs/strategies/ANALYSIS.md." : error}
          />
        </Card>
      </Shell>
    );

  const d = data!;
  const name = (key: string) => d.strategies.find((s) => s.key === key)?.name ?? key;
  const report = d.reports[kind] ?? null;

  return (
    <Shell>
      <div className="max-w-2xl">
        <h1 className="text-xl font-bold tracking-tight">Strategy bots</h1>
        <p className="mt-0.5 text-sm text-muted">
          What the trades say so far: which rule sets earn, why the losers lost, and what to change. Updated every hour. It only measures; the bots keep trading every signal.
        </p>
      </div>

      <BotsTabs />

      {report?.data.strategies && <RuleSets rows={report.data.strategies} />}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold">Report</h2>
        <Segmented size="sm" className="w-full sm:w-80" value={kind} onChange={setKind} options={KINDS} />
      </div>

      {!report ? (
        <Card>
          <EmptyState
            title={`No ${kind} report yet`}
            body="Reports are written a few minutes after each period closes, once the bot-analyze function is scheduled (docs/strategies/ANALYSIS.md)."
          />
        </Card>
      ) : (
        <Report r={report} name={name} />
      )}

      <Glossary />

      <AnalysisChat />
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto max-w-6xl space-y-4 p-3 lg:p-6">{children}</div>;
}

// ───────────────────────── Rule sets ─────────────────────────

/** Each rule set over all its timeframes, all time: the table to drop and keep rule sets from. */
function RuleSets({ rows }: { rows: BotStrategyRow[] }) {
  return (
    <Card className="overflow-hidden">
      <div className="border-b border-line px-4 py-3">
        <div className="text-sm font-semibold">Rule sets, since the start</div>
        <p className="mt-0.5 text-xs text-muted">
          Each rule set over its three charts together, best first. This is the table to decide from: keep what stays above zero after 30 or more trades.
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="num w-full min-w-[520px] text-sm">
          <thead className="text-left text-xs text-muted">
            <tr>
              <th className="px-4 py-2 font-medium">Rule set</th>
              <th className="px-2 py-2 text-right font-medium">Trades</th>
              <th className="px-2 py-2 text-right font-medium">Win rate</th>
              <th className="px-2 py-2 text-right font-medium">Avg R</th>
              <th className="px-2 py-2 text-right font-medium">Profit factor</th>
              <th className="px-4 py-2 text-right font-medium">Net</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((r) => (
              <tr key={r.strategy}>
                <td className="px-4 py-2 font-semibold">{r.name}</td>
                <td className="px-2 py-2 text-right">
                  {r.trades}
                  {r.trades > 0 && r.trades < 30 && <span className="ml-1 text-xs text-faint">too few</span>}
                </td>
                <td className="px-2 py-2 text-right">{r.winRate == null ? "—" : `${r.winRate.toFixed(0)}%`}</td>
                <td className={cx("px-2 py-2 text-right font-semibold", pnlClass(r.avgR))}>{fmtR(r.avgR)}</td>
                <td className="px-2 py-2 text-right">{r.profitFactor == null ? "—" : r.profitFactor.toFixed(2)}</td>
                <td className={cx("px-4 py-2 text-right", pnlClass(r.netUsd))}>{r.trades ? fmtSignedUsd(r.netUsd) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// ───────────────────────── Report ─────────────────────────

function Report({ r, name }: { r: BotReport; name: (k: string) => string }) {
  const d = r.data;
  const n = r.narrative;
  const p = d.period;
  const label = (s: { strategy: string; timeframe: string | null }) => `${name(s.strategy)} ${s.timeframe ?? ""}`.trim();
  const span = `${fmtDateTime(r.period_start)} – ${fmtDateTime(r.period_end)}`;

  return (
    <>
      <Card className="p-4">
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
          <span>{span} (UTC periods)</span>
          <span className={cx("rounded px-1.5 py-0.5 font-semibold", r.ai_model ? "bg-accent-soft text-accent" : "bg-panel-2 text-muted")}>
            {r.ai_model ? `Written by Claude (${r.ai_model})` : "Template summary (no AI key set)"}
          </span>
        </div>
        {n && (
          <>
            <h2 className="mt-2 text-lg font-bold leading-snug">{n.headline}</h2>
            <div className="mt-2 space-y-2 text-sm leading-relaxed text-muted">
              {n.summary.map((x, i) => (
                <p key={i}>{x}</p>
              ))}
            </div>
          </>
        )}
        {r.ai_error && <p className="mt-2 text-xs text-amber-400">The AI write-up failed, so this is the template: {r.ai_error}</p>}
        <div className="num mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <Stat label="Closed trades" value={String(p.trades)} />
          <Stat label="Win rate" value={p.trades ? `${Math.round((p.wins / p.trades) * 100)}%` : "—"} />
          <Stat label="Net" value={fmtSignedUsd(p.netUsd)} cls={pnlClass(p.netUsd)} />
          <Stat label="Total R" value={fmtR(p.sumR)} cls={pnlClass(p.sumR)} />
        </div>
        <Buckets buckets={p.buckets} />
      </Card>

      <div className="grid gap-4 lg:grid-cols-3">
        <RankCard title="Best for real trading" hint="Readiness score: edge after slippage at 95% confidence, sample size, PF, consistency, drawdown." list={d.rankings.best} metric={(s) => `${s.score}/100`} name={name} />
        <RankCard title="Most effective" hint="Edge per trade you can count on: the 95% lower bound of R after slippage (10+ trades)." list={d.rankings.effective} metric={(s) => fmtR(s.lcbRSlip)} name={name} />
        <RankCard title="Highest return" hint="Account return so far. Check the verdict: a short lucky streak can top this list." list={d.rankings.highestReturn} metric={(s) => fmtPct(s.returnPct)} name={name} />
      </div>
      {n && n.ranking_notes.length > 0 && (
        <Card className="space-y-2 p-4 text-sm leading-relaxed text-muted">
          {n.ranking_notes.map((x, i) => (
            <p key={i}>{x}</p>
          ))}
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-4">
          <h2 className="font-semibold">Why trades lost</h2>
          {n && n.mistakes.length > 0 && (
            <ul className="mt-2 space-y-2 text-sm">
              {n.mistakes.map((m, i) => (
                <li key={i}>
                  <div className="font-medium">{m.title}</div>
                  <div className="text-muted">{m.detail}</div>
                </li>
              ))}
            </ul>
          )}
          <MistakeTable title="This period" rows={d.mistakes.period} />
          <MistakeTable title="All time" rows={d.mistakes.allTime} />
        </Card>
        <Card className="p-4">
          <h2 className="font-semibold">What to change</h2>
          {n && n.improvements.length > 0 ? (
            <ul className="mt-2 space-y-3 text-sm">
              {n.improvements.map((m, i) => (
                <li key={i}>
                  <div className="text-xs font-semibold text-accent">{m.scope}</div>
                  <div className="font-medium">{m.action}</div>
                  <div className="text-muted">{m.rationale}</div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-sm text-muted">No clear improvement yet: not enough losing trades share a cause.</p>
          )}
          {d.mistakes.bySetup.length > 0 && (
            <div className="mt-4">
              <div className="text-xs font-semibold text-muted">Most common loss reason per setup</div>
              <ul className="mt-1 divide-y divide-line text-xs">
                {d.mistakes.bySetup.map((m) => (
                  <li key={`${m.strategy}${m.timeframe}`} className="flex justify-between gap-2 py-1">
                    <span>{label(m)}</span>
                    <span className="text-muted">
                      {m.title} · {m.count}/{m.losses}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>
      </div>

      {d.mistakes.examples.length > 0 && (
        <Card className="overflow-hidden">
          <div className="border-b border-line px-4 py-3 text-sm font-semibold">Losing trades, reviewed</div>
          <ul className="divide-y divide-line text-sm">
            {d.mistakes.examples.map((e) => (
              <li key={e.tradeId}>
                <Link href={`/bots/trade/${e.tradeId}`} className="block px-4 py-3 hover:bg-panel-2/50">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="font-semibold text-fg">{baseAsset(e.symbol)}</span>
                    <span className={e.side === "long" ? "text-up" : "text-down"}>{e.side}</span>
                    <span className="text-muted">{label(e)}</span>
                    <span className="rounded bg-down-soft px-1.5 py-0.5 font-semibold text-down">{e.title}</span>
                    <span className="num ml-auto font-semibold text-down">{fmtR(e.r)}</span>
                  </div>
                  <div className="mt-1 text-muted">{e.why}</div>
                  <div className="mt-1 text-xs text-faint">Fix: {e.fix}</div>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card className="p-4">
        <h2 className="font-semibold">When the bots do well</h2>
        <p className="text-xs text-muted">All closed trades by entry time (UTC): average R per trade.</p>
        <div className="mt-3 grid gap-4 md:grid-cols-3">
          <TimingList title="Session" rows={d.timing.bySession} />
          <TimingList title="Weekday" rows={d.timing.byWeekday} />
          <TimingList title="Hour" rows={d.timing.byHour} />
        </div>
      </Card>

      <Card className="overflow-hidden">
        <div className="border-b border-line px-4 py-3 text-sm font-semibold">Every rule set and chart, scored</div>
        <div className="overflow-x-auto">
          <table className="num w-full min-w-[720px] text-sm">
            <thead className="text-xs text-muted">
              <tr className="text-right [&>th]:px-3 [&>th]:py-2 [&>th]:font-medium">
                <th className="text-left">Setup</th>
                <th>Score</th>
                <th>Trades</th>
                <th>Win %</th>
                <th>Avg R (slip)</th>
                <th>95% low R</th>
                <th>PF</th>
                <th>Max DD</th>
                <th>Return</th>
                <th className="text-left">Verdict</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {[...d.setups]
                .sort((a, b) => b.score - a.score)
                .map((s) => (
                  <tr key={`${s.strategy}${s.timeframe}`} className="text-right [&>td]:px-3 [&>td]:py-2">
                    <td className="text-left">{label(s)}</td>
                    <td className="font-semibold">{s.score}</td>
                    <td>{s.trades}</td>
                    <td>{s.winRate == null ? "—" : Math.round(s.winRate)}</td>
                    <td className={pnlClass(s.avgRSlip)}>{fmtR(s.avgRSlip)}</td>
                    <td className={pnlClass(s.lcbRSlip)}>{fmtR(s.lcbRSlip)}</td>
                    <td>{s.profitFactor == null ? "—" : s.profitFactor.toFixed(2)}</td>
                    <td>{s.maxDrawdownPct.toFixed(1)}%</td>
                    <td className={pnlClass(s.returnPct)}>{fmtPct(s.returnPct)}</td>
                    <td className="text-left">
                      <VerdictBadge v={s.verdict} title={s.verdictReason} />
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </Card>

      {n && n.caveats.length > 0 && (
        <ul className="list-disc space-y-1 pl-5 text-xs text-faint">
          {n.caveats.map((c, i) => (
            <li key={i}>{c}</li>
          ))}
        </ul>
      )}
    </>
  );
}

function Stat({ label, value, cls }: { label: string; value: string; cls?: string }) {
  return (
    <div>
      <div className="text-xs text-muted">{label}</div>
      <div className={cx("text-base font-semibold", cls)}>{value}</div>
    </div>
  );
}

function VerdictBadge({ v, title }: { v: BotVerdict; title?: string }) {
  return (
    <span title={title} className={cx("inline-block whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] font-semibold", VERDICT[v].cls)}>
      {VERDICT[v].label}
    </span>
  );
}

function Buckets({ buckets }: { buckets: BotReport["data"]["period"]["buckets"] }) {
  if (buckets.length < 2) return null;
  const max = Math.max(...buckets.map((b) => Math.abs(b.sumR)), 0.01);
  return (
    <div className="mt-4">
      <div className="text-xs text-muted">R by sub-period</div>
      <ul className="num mt-1 space-y-1 text-xs">
        {buckets.map((b) => (
          <li key={b.start} className="grid grid-cols-[7rem_1fr_4rem] items-center gap-2">
            <span className="truncate text-muted">{b.label}</span>
            <span className="relative h-2 rounded bg-panel-2">
              <span
                className={cx("absolute inset-y-0 left-0 rounded", b.sumR >= 0 ? "bg-up" : "bg-down")}
                style={{ width: `${(Math.abs(b.sumR) / max) * 100}%` }}
              />
            </span>
            <span className={cx("text-right", pnlClass(b.sumR))}>{fmtR(b.sumR)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function RankCard({ title, hint, list, metric, name }: { title: string; hint: string; list: BotSetupStats[]; metric: (s: BotSetupStats) => string; name: (k: string) => string }) {
  return (
    <Card className="p-4">
      <h2 className="font-semibold">{title}</h2>
      <p className="text-xs text-faint">{hint}</p>
      {!list.length ? (
        <p className="mt-3 text-sm text-muted">Not enough trades yet.</p>
      ) : (
        <ol className="mt-3 space-y-2 text-sm">
          {list.map((s, i) => (
            <li key={`${s.strategy}${s.timeframe}`} className="flex items-start gap-2">
              <span className="num w-4 text-faint">{i + 1}</span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate font-medium">{name(s.strategy)}</span>
                  <TfBadge tf={s.timeframe} />
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted">
                  <VerdictBadge v={s.verdict} title={s.verdictReason} />
                  <span className="num">{s.trades} trades</span>
                </div>
              </div>
              <span className="num font-semibold">{metric(s)}</span>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

function MistakeTable({ title, rows }: { title: string; rows: BotReport["data"]["mistakes"]["period"] }) {
  if (!rows.length) return null;
  return (
    <div className="mt-4">
      <div className="text-xs font-semibold text-muted">{title}</div>
      <ul className="num mt-1 divide-y divide-line text-xs">
        {rows.map((m) => (
          <li key={m.category} className="py-1.5">
            <div className="flex justify-between gap-2">
              <span className="font-medium text-fg">
                {m.title} <span className="text-faint">×{m.count}</span>
              </span>
              <span className="text-down">{fmtR(m.sumR)}</span>
            </div>
            <div className="text-faint">{m.fix}</div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function TimingList({ title, rows }: { title: string; rows: BotTimingRow[] }) {
  const max = Math.max(...rows.map((r) => Math.abs(r.avgR)), 0.01);
  return (
    <div>
      <div className="text-xs font-semibold text-muted">{title}</div>
      {!rows.length ? (
        <p className="mt-1 text-xs text-faint">No trades yet.</p>
      ) : (
        <ul className="num mt-1 space-y-1 text-xs">
          {rows.map((r) => (
            <li key={r.key} className="grid grid-cols-[3.5rem_1fr_3.5rem_2.5rem] items-center gap-2" title={`${r.trades} trades, ${Math.round(r.winRate)}% winners`}>
              <span className="text-muted">{r.key}</span>
              <span className="relative h-2 rounded bg-panel-2">
                <span className={cx("absolute inset-y-0 left-0 rounded", r.avgR >= 0 ? "bg-up" : "bg-down")} style={{ width: `${(Math.abs(r.avgR) / max) * 100}%` }} />
              </span>
              <span className={cx("text-right", pnlClass(r.avgR))}>{fmtR(r.avgR)}</span>
              <span className="text-right text-faint">{r.trades}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
