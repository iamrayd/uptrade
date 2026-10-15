import type { Metadata } from "next";
import { BotsView } from "./BotsView";

export const metadata: Metadata = { title: "Bots" };

export default function BotsPage() {
  return <BotsView />;
}
