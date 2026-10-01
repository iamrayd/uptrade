import type { Metadata } from "next";
import { JournalView } from "./JournalView";

export const metadata: Metadata = { title: "Journal" };

export default async function JournalPage({ params }: PageProps<"/journal/[positionId]">) {
  const { positionId } = await params;
  return <JournalView positionId={positionId} />;
}
