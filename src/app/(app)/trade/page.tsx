import type { Metadata } from "next";
import { cookies } from "next/headers";
import { DEFAULT_SYMBOL, INTERVALS, MARKET_COOKIE, type Interval } from "@/lib/binance";
import { TradeView } from "./TradeView";

export const metadata: Metadata = { title: "Trade" };

const cleanSymbol = (s: unknown) => (typeof s === "string" ? s.toUpperCase().replace(/[^A-Z0-9]/g, "") : "");
const cleanInterval = (tf: unknown) =>
  typeof tf === "string" && (INTERVALS as readonly string[]).includes(tf) ? (tf as Interval) : null;

export default async function TradePage({ searchParams }: PageProps<"/trade">) {
  const sp = await searchParams;
  // Fall back to the last market viewed (cookie) when opening plain /trade.
  const [savedS, savedTf] = ((await cookies()).get(MARKET_COOKIE)?.value ?? "").split(":");
  const symbol = cleanSymbol(sp.s) || cleanSymbol(savedS) || DEFAULT_SYMBOL;
  const interval = cleanInterval(sp.tf) ?? cleanInterval(savedTf) ?? "15m";
  return <TradeView initialSymbol={symbol} initialInterval={interval} />;
}
