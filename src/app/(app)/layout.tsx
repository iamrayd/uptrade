"use client";

import { BottomTabs, TopNav } from "@/components/Nav";
import { Toaster } from "@/components/Toaster";
import { useLimitMatcher } from "@/hooks/useLimitMatcher";

function LimitMatcher() {
  useLimitMatcher();
  return null;
}

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <TopNav />
      {/* Bottom padding clears the mobile tab bar (and the trade page's buy/sell bar). */}
      <main className="flex-1 pb-[calc(env(safe-area-inset-bottom)+5rem)] lg:pb-8">{children}</main>
      <BottomTabs />
      <LimitMatcher />
      <Toaster />
    </div>
  );
}
