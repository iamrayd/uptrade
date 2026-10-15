"use client";

import { Fragment, type ReactNode } from "react";
import type { BotExitReason, BotRuntime } from "@/lib/types";
import { EXIT_LABEL } from "@/lib/bots";
import { cx } from "./ui";

/** Renders the small markdown subset used in strategy rules: paragraphs, "- " lists, **bold**, *italic*. */
export function RulesText({ text }: { text: string }) {
  const inline = (s: string): ReactNode[] =>
    s.split(/(\*\*[^*]+\*\*|\*[^*]+\*)/g).map((part, i) =>
      part.startsWith("**") ? (
        <strong key={i} className="font-semibold text-fg">{part.slice(2, -2)}</strong>
      ) : part.startsWith("*") && part.length > 2 ? (
        <em key={i}>{part.slice(1, -1)}</em>
      ) : (
        <Fragment key={i}>{part}</Fragment>
      ),
    );
  const blocks = text.split(/\n\s*\n/);
  return (
    <div className="space-y-3 text-sm leading-relaxed text-muted">
      {blocks.map((b, i) => {
        const lines = b.split("\n");
        const head = lines[0].startsWith("- ") ? null : lines[0];
        const items = lines.filter((l) => l.startsWith("- "));
        return (
          <div key={i}>
            {head && <p>{inline(head)}</p>}
            {items.length > 0 && (
              <ul className="mt-1 list-disc space-y-1 pl-5">
                {items.map((l, j) => (
                  <li key={j}>{inline(l.slice(2))}</li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function ExitBadge({ reason }: { reason: BotExitReason | null }) {
  if (!reason) return null;
  const good = reason === "take_profit";
  const bad = reason === "stop_loss" || reason === "liquidation";
  return (
    <span
      className={cx(
        "inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-semibold",
        good ? "bg-up-soft text-up" : bad ? "bg-down-soft text-down" : "bg-panel-2 text-muted",
        reason === "liquidation" && "bg-amber-400/15 text-amber-400",
      )}
    >
      {EXIT_LABEL[reason]}
    </span>
  );
}

export function TfBadge({ tf }: { tf: string }) {
  return <span className="rounded bg-accent-soft px-1.5 py-0.5 text-[11px] font-bold text-accent">{tf}</span>;
}

export function Kpi({ label, value, cls, sub }: { label: string; value: ReactNode; cls?: string; sub?: ReactNode }) {
  return (
    <div>
      <div className="text-xs text-muted">{label}</div>
      <div className={cx("text-base font-semibold", cls)}>{value}</div>
      {sub && <div className="text-xs text-faint">{sub}</div>}
    </div>
  );
}

/** Is the runner alive? It should run every minute. */
export function runnerHealth(rt: BotRuntime | null | undefined, now = Date.now()) {
  if (!rt?.last_started_at) return { state: "never" as const, label: "Never run", ageMin: null };
  const ageMin = (now - new Date(rt.last_started_at).getTime()) / 60000;
  if (ageMin > 5) return { state: "stale" as const, label: `Last run ${Math.round(ageMin)} min ago`, ageMin };
  if (rt.last_error) return { state: "error" as const, label: "Running with errors", ageMin };
  return { state: "ok" as const, label: "Running", ageMin };
}

export function HealthPill({ rt }: { rt: BotRuntime | null | undefined }) {
  const h = runnerHealth(rt);
  const color = h.state === "ok" ? "bg-up" : h.state === "error" ? "bg-amber-400" : "bg-down";
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-line px-2.5 py-1 text-xs text-muted" title={rt?.last_error ?? undefined}>
      <span className={cx("size-2 rounded-full", color)} />
      {h.label}
    </span>
  );
}
