"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { cx } from "./ui";

// Getting around the Bots section: two top-level pages (tabs), and a trail on the pages under them.

const SECTIONS = [
  { href: "/bots", label: "Overview" },
  { href: "/bots/insights", label: "Analysis" },
];

/** The two top-level pages of the Bots section. */
export function BotsTabs() {
  const path = usePathname();
  return (
    <nav aria-label="Bots sections" className="flex gap-1 border-b border-line">
      {SECTIONS.map((s) => {
        const active = path === s.href;
        return (
          <Link
            key={s.href}
            href={s.href}
            aria-current={active ? "page" : undefined}
            className={cx(
              "-mb-px inline-flex h-11 items-center border-b-2 px-3 text-sm font-semibold transition-colors",
              "focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent",
              active ? "border-accent text-fg" : "border-transparent text-muted hover:text-fg",
            )}
          >
            {s.label}
          </Link>
        );
      })}
    </nav>
  );
}

/** Where this page sits: each step links back up, the last one is the page itself. */
export function Crumbs({ trail }: { trail: { label: ReactNode; href?: string }[] }) {
  return (
    <nav aria-label="Breadcrumb" className="flex min-h-10 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-sm">
      {trail.map((c, i) => (
        <span key={i} className="inline-flex items-center gap-1.5">
          {i > 0 && (
            <svg viewBox="0 0 24 24" className="size-3.5 text-faint" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden>
              <path d="m9 6 6 6-6 6" />
            </svg>
          )}
          {c.href ? (
            <Link href={c.href} className="rounded text-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
              {c.label}
            </Link>
          ) : (
            <span aria-current="page" className="font-semibold text-fg">
              {c.label}
            </span>
          )}
        </span>
      ))}
    </nav>
  );
}

/** The few terms the bot pages use, in plain words. Closed by default; one tap opens it. */
export function Glossary() {
  const terms: [string, string][] = [
    ["R", "The result of a trade measured against what it risked. +2R made twice the amount risked; −1R lost exactly the amount risked. It lets you compare trades of different sizes."],
    ["Avg R", "The average result per trade, in R. Above zero means the rule set makes money per trade; below zero means it loses."],
    ["Win rate", "The share of closed trades that made money. A rule set aiming for 2R can be profitable with a win rate just over a third."],
    ["Profit factor", "Money won divided by money lost. Above 1 is profitable; 1.3 or more is solid."],
    ["Busted", "The account fell under $10, too little to trade. It stops opening trades."],
    ["Enough trades", "30 closed trades. With fewer, a good or bad result is mostly luck."],
  ];
  return (
    <details className="group rounded-xl border border-line bg-panel">
      <summary className="flex h-11 cursor-pointer list-none items-center justify-between rounded-xl px-4 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent [&::-webkit-details-marker]:hidden">
        What the numbers mean
        <svg viewBox="0 0 24 24" className="size-4 text-muted transition-transform group-open:rotate-180" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden>
          <path d="m6 9 6 6 6-6" />
        </svg>
      </summary>
      <dl className="grid gap-x-8 gap-y-3 border-t border-line px-4 py-4 text-sm sm:grid-cols-2">
        {terms.map(([term, text]) => (
          <div key={term}>
            <dt className="font-semibold">{term}</dt>
            <dd className="mt-0.5 leading-relaxed text-muted">{text}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}
