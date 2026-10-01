"use client";

import { fmtSignedUsd, fmtUsd, pnlClass } from "@/lib/format";
import type { EquitySummary } from "@/lib/pnl";
import { Skeleton, cx } from "./ui";

export function AccountSummary({ summary, className }: { summary: EquitySummary | null; className?: string }) {
  const items = summary
    ? [
        { label: "Equity", value: fmtUsd(summary.equity), strong: true },
        { label: "Available", value: fmtUsd(summary.balance) },
        { label: "In positions", value: fmtUsd(summary.inPositions) },
        { label: "Unrealized", value: fmtSignedUsd(summary.unrealized), cls: pnlClass(summary.unrealized) },
      ]
    : null;
  return (
    <div className={cx("num grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4", className)}>
      {items
        ? items.map((i) => (
            <div key={i.label} className="min-w-0">
              <div className="text-xs text-muted">{i.label}</div>
              <div className={cx("truncate", i.strong ? "text-lg font-bold" : "text-base font-semibold", i.cls)}>{i.value}</div>
            </div>
          ))
        : Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-10" />)}
    </div>
  );
}
