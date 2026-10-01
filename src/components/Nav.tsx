"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAccount, useOpenPositions } from "@/hooks/useTrading";
import { usePrices } from "@/hooks/useMarket";
import { fmtSignedUsd, fmtUsd, pnlClass } from "@/lib/format";
import { summarizeEquity } from "@/lib/pnl";
import { cx } from "./ui";

const TABS = [
  {
    href: "/trade",
    label: "Trade",
    icon: <path d="M4 19V9m6 10V5m6 14v-7m4 7H2" />,
  },
  {
    href: "/history",
    label: "History",
    icon: <path d="M12 8v4l3 2M3 12a9 9 0 1 0 3-6.7M3 4v4h4" />,
  },
  {
    href: "/account",
    label: "Account",
    icon: <path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 8a7 7 0 0 1 14 0" />,
  },
];

function isActive(path: string, href: string) {
  if (href === "/history") return path.startsWith("/history") || path.startsWith("/journal");
  return path.startsWith(href);
}

function Logo() {
  return (
    <Link href="/trade" className="flex items-center gap-2 font-bold tracking-tight">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/icon.svg" alt="" className="size-7 rounded-md" />
      <span>UpTrade</span>
    </Link>
  );
}

function EquityPill() {
  const { data: account } = useAccount();
  const { data: positions } = useOpenPositions();
  const prices = usePrices((positions ?? []).map((p) => p.symbol));
  if (!account) return null;
  const s = summarizeEquity(account.balance, positions ?? [], prices);
  return (
    <div className="num flex items-baseline gap-2 text-sm">
      <span className="text-muted">Equity</span>
      <span className="font-semibold">{fmtUsd(s.equity)}</span>
      {positions?.length ? <span className={cx("text-xs", pnlClass(s.unrealized))}>{fmtSignedUsd(s.unrealized)}</span> : null}
    </div>
  );
}

export function TopNav() {
  const path = usePathname();
  return (
    <header className="sticky top-0 z-40 border-b border-line bg-bg/85 backdrop-blur pt-[env(safe-area-inset-top)]">
      <div className="mx-auto flex h-14 max-w-[1600px] items-center gap-6 px-4">
        <Logo />
        <nav className="hidden items-center gap-1 lg:flex">
          {TABS.map((t) => (
            <Link
              key={t.href}
              href={t.href}
              className={cx(
                "rounded-lg px-3 py-2 text-sm font-medium transition",
                isActive(path, t.href) ? "bg-panel-2 text-fg" : "text-muted hover:text-fg",
              )}
            >
              {t.label}
            </Link>
          ))}
        </nav>
        <div className="ml-auto">
          <EquityPill />
        </div>
      </div>
    </header>
  );
}

export function BottomTabs() {
  const path = usePathname();
  return (
    <nav className="pb-safe fixed inset-x-0 bottom-0 z-40 border-t border-line bg-bg/95 backdrop-blur lg:hidden">
      <div className="grid h-16 grid-cols-3">
        {TABS.map((t) => {
          const active = isActive(path, t.href);
          return (
            <Link
              key={t.href}
              href={t.href}
              className={cx("flex flex-col items-center justify-center gap-1 text-[11px] font-medium", active ? "text-fg" : "text-faint")}
            >
              <svg viewBox="0 0 24 24" className="size-6" fill="none" stroke="currentColor" strokeWidth={active ? 2.2 : 1.8} strokeLinecap="round" strokeLinejoin="round">
                {t.icon}
              </svg>
              {t.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
