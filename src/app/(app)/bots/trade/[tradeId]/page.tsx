import type { Metadata } from "next";
import { BotTradeView } from "./BotTradeView";

export const metadata: Metadata = { title: "Bot trade" };

export default async function BotTradePage({ params }: PageProps<"/bots/trade/[tradeId]">) {
  const { tradeId } = await params;
  return <BotTradeView tradeId={tradeId} />;
}
