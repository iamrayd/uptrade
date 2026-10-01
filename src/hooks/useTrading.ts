"use client";

import { useEffect, useState } from "react";
import type { User } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";
import type { Account, BalanceAdjustment, HistoryRow, Order, Position } from "@/lib/types";
import { unwrap, useQuery } from "./useQuery";

export function useUser() {
  const [user, setUser] = useState<User | null>(null);
  useEffect(() => {
    const sb = createClient();
    sb.auth.getUser().then(({ data }) => setUser(data.user));
    const { data } = sb.auth.onAuthStateChange((_e, session) => setUser(session?.user ?? null));
    return () => data.subscription.unsubscribe();
  }, []);
  return user;
}

export function useAccount() {
  return useQuery("account", async (sb) =>
    unwrap(await sb.from("accounts").select("*").maybeSingle()) as Account | null,
  );
}

export function useOpenPositions() {
  return useQuery("positions:open", async (sb) =>
    unwrap(await sb.from("positions").select("*").eq("status", "open").order("opened_at", { ascending: false })) as Position[],
  );
}

export function useOpenOrders() {
  return useQuery("orders:open", async (sb) =>
    unwrap(await sb.from("orders").select("*").eq("status", "open").order("created_at", { ascending: false })) as Order[],
  );
}

export function useHistory() {
  return useQuery("positions:closed", async (sb) => {
    const rows = unwrap(
      await sb
        .from("positions")
        .select("*, journal:journal_entries(tags, rating, notes)")
        .eq("status", "closed")
        .order("closed_at", { ascending: false })
        .limit(500),
    ) as (Position & { journal: HistoryRow["journal"] | HistoryRow["journal"][] })[];
    // PostgREST returns a 1:1 embed as an object, but be tolerant of arrays.
    return rows.map((r) => ({ ...r, journal: Array.isArray(r.journal) ? (r.journal[0] ?? null) : r.journal })) as HistoryRow[];
  });
}

export function useAdjustments() {
  return useQuery("adjustments", async (sb) =>
    unwrap(await sb.from("balance_adjustments").select("*").order("created_at", { ascending: false }).limit(100)) as BalanceAdjustment[],
  );
}

export function useRecentOrders() {
  return useQuery("orders:recent", async (sb) =>
    unwrap(
      await sb.from("orders").select("*").neq("status", "open").order("created_at", { ascending: false }).limit(50),
    ) as Order[],
  );
}
