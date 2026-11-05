"use client";

import type { BotAccount, BotEvent, BotLesson, BotReport, BotReportKind, BotRuntime, BotSettings, BotStrategy, BotTrade } from "@/lib/types";
import { unwrap, useQuery } from "./useQuery";

export interface BotsOverview {
  settings: BotSettings | null;
  runtime: BotRuntime | null;
  strategies: BotStrategy[];
  accounts: BotAccount[];
  openTrades: BotTrade[];
  closedTrades: BotTrade[];
  events: BotEvent[];
}

const CLOSED_COLS =
  "id, account_id, strategy, timeframe, symbol, side, status, net_pnl, r_multiple, entry_fee, exit_fee, closed_at, opened_at, exit_reason";

/** Supabase returns at most 1000 rows per request whatever `.limit()` says, so larger lists are read in pages. */
const PAGE = 1000;

async function fetchClosed(sb: Parameters<Parameters<typeof useQuery>[1]>[0], cols: string, max: number, accountId?: string) {
  const out: BotTrade[] = [];
  while (out.length < max) {
    let q = sb.from("bot_trades").select(cols).eq("status", "closed");
    if (accountId) q = q.eq("account_id", accountId);
    // `id` breaks ties, so a page boundary can't repeat or drop trades that closed in the same instant.
    const rows = (unwrap(await q.order("closed_at", { ascending: false }).order("id").range(out.length, out.length + PAGE - 1)) ?? []) as unknown as BotTrade[];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out.slice(0, max);
}

export function useBotsOverview() {
  return useQuery<BotsOverview>("bots:overview", async (sb) => {
    const [settings, runtime, strategies, accounts, openTrades, closedTrades, events] = await Promise.all([
      sb.from("bot_settings").select("*").maybeSingle().then(unwrap),
      sb.from("bot_runtime").select("last_started_at, last_finished_at, last_error, runs").maybeSingle().then(unwrap),
      sb.from("bot_strategies").select("*").then(unwrap),
      sb.from("bot_accounts").select("*").then(unwrap),
      sb.from("bot_trades").select("*").eq("status", "open").then(unwrap),
      fetchClosed(sb, CLOSED_COLS, 20000),
      sb.from("bot_events").select("*").in("kind", ["opened", "closed", "error"]).order("created_at", { ascending: false }).limit(40).then(unwrap),
    ]);
    return {
      settings: settings as BotSettings | null,
      runtime: runtime as BotRuntime | null,
      strategies: (strategies ?? []) as BotStrategy[],
      accounts: (accounts ?? []) as BotAccount[],
      openTrades: (openTrades ?? []) as BotTrade[],
      closedTrades: (closedTrades ?? []) as BotTrade[],
      events: (events ?? []) as BotEvent[],
    };
  });
}

export interface BotAccountData {
  account: BotAccount | null;
  strategy: BotStrategy | null;
  trades: BotTrade[];
  events: BotEvent[];
}

export function useBotAccount(accountId: string) {
  return useQuery<BotAccountData>(`bots:account:${accountId}`, async (sb) => {
    const account = (await sb.from("bot_accounts").select("*").eq("id", accountId).maybeSingle().then(unwrap)) as BotAccount | null;
    if (!account) return { account: null, strategy: null, trades: [], events: [] };
    const [strategy, openTrades, closed, events] = await Promise.all([
      sb.from("bot_strategies").select("*").eq("key", account.strategy).maybeSingle().then(unwrap),
      sb.from("bot_trades").select("*").eq("account_id", accountId).eq("status", "open").then(unwrap),
      fetchClosed(sb, "*", 5000, accountId),
      sb.from("bot_events").select("*").eq("account_id", accountId).order("created_at", { ascending: false }).limit(60).then(unwrap),
    ]);
    const trades = [...((openTrades ?? []) as BotTrade[]), ...closed].sort((x, y) => +new Date(y.opened_at) - +new Date(x.opened_at));
    return { account, strategy: strategy as BotStrategy | null, trades, events: (events ?? []) as BotEvent[] };
  });
}

export function useBotTrade(tradeId: string) {
  return useQuery(`bots:trade:${tradeId}`, async (sb) => {
    const trade = (await sb.from("bot_trades").select("*").eq("id", tradeId).maybeSingle().then(unwrap)) as BotTrade | null;
    if (!trade) return { trade: null, strategy: null };
    const strategy = (await sb.from("bot_strategies").select("*").eq("key", trade.strategy).maybeSingle().then(unwrap)) as BotStrategy | null;
    return { trade, strategy };
  });
}

export interface BotInsights {
  settings: BotSettings | null;
  strategies: BotStrategy[];
  /** The latest report of each kind. */
  reports: Partial<Record<BotReportKind, BotReport>>;
  lessons: BotLesson[];
}

const REPORT_KINDS: BotReportKind[] = ["hourly", "daily", "weekly", "monthly"];

export function useBotInsights() {
  return useQuery<BotInsights>("bots:insights", async (sb) => {
    const [settings, strategies, lessons, ...latest] = await Promise.all([
      sb.from("bot_settings").select("*").maybeSingle().then(unwrap),
      sb.from("bot_strategies").select("key, name, version, summary").then(unwrap),
      sb.from("bot_lessons").select("*").order("created_at", { ascending: false }).then(unwrap),
      ...REPORT_KINDS.map((k) => sb.from("bot_reports").select("*").eq("kind", k).order("period_start", { ascending: false }).limit(1).maybeSingle().then(unwrap)),
    ]);
    const reports: BotInsights["reports"] = {};
    REPORT_KINDS.forEach((k, i) => {
      if (latest[i]) reports[k] = latest[i] as BotReport;
    });
    return {
      settings: settings as BotSettings | null,
      strategies: (strategies ?? []) as BotStrategy[],
      reports,
      lessons: (lessons ?? []) as BotLesson[],
    };
  });
}
