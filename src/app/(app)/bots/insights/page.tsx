import type { Metadata } from "next";
import { InsightsView } from "./InsightsView";

export const metadata: Metadata = { title: "Bot analysis" };

export default function BotInsightsPage() {
  return <InsightsView />;
}
