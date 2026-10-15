import type { Metadata } from "next";
import { BotAccountView } from "./BotAccountView";

export const metadata: Metadata = { title: "Bot account" };

export default async function BotAccountPage({ params }: PageProps<"/bots/[accountId]">) {
  const { accountId } = await params;
  return <BotAccountView accountId={accountId} />;
}
