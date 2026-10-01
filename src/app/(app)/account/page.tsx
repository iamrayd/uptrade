"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { adjustBalance } from "@/lib/actions";
import { fmtDateTime, fmtSignedUsd, fmtUsd, pnlClass } from "@/lib/format";
import { summarizeEquity } from "@/lib/pnl";
import { toast } from "@/lib/store";
import { createClient } from "@/lib/supabase/client";
import { useAccount, useAdjustments, useOpenPositions, useUser } from "@/hooks/useTrading";
import { usePrices } from "@/hooks/useMarket";
import { AccountSummary } from "@/components/AccountSummary";
import { ListSkeleton } from "@/components/PositionsList";
import { Button, Card, EmptyState, Segmented, cx } from "@/components/ui";

const PRESETS = [100, 500, 1000, 5000];

export default function AccountPage() {
  const router = useRouter();
  const user = useUser();
  const { data: account } = useAccount();
  const { data: positions } = useOpenPositions();
  const { data: log, loading: logLoading } = useAdjustments();
  const prices = usePrices((positions ?? []).map((p) => p.symbol));
  const summary = account ? summarizeEquity(account.balance, positions ?? [], prices) : null;

  const [dir, setDir] = useState<"add" | "deduct">("add");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const value = parseFloat(amount) || 0;
  const tooMuch = dir === "deduct" && account && value > account.balance;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!value || tooMuch) return;
    setBusy(true);
    try {
      const signed = dir === "add" ? value : -value;
      const acc = await adjustBalance(signed, note);
      toast("success", dir === "add" ? "Funds added" : "Funds deducted", `${fmtSignedUsd(signed)} · Balance ${fmtUsd(acc.balance)}`);
      setAmount("");
      setNote("");
    } catch (err) {
      toast("error", "Couldn't update balance", (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    await createClient().auth.signOut();
    router.replace("/login");
    router.refresh();
  }

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-3 lg:p-6">
      <div>
        <h1 className="text-xl font-bold tracking-tight">Account</h1>
        <p className="text-sm text-muted">{user?.email ?? " "}</p>
      </div>

      <Card className="p-4">
        <AccountSummary summary={summary} />
      </Card>

      <div className="grid gap-4 md:grid-cols-5">
        <Card className="p-4 md:col-span-2">
          <h2 className="mb-1 text-base font-semibold">Adjust balance</h2>
          <p className="mb-4 text-sm text-muted">Add or remove paper funds whenever you like. Every change is logged.</p>
          <form onSubmit={submit} className="space-y-3">
            <Segmented
              value={dir}
              onChange={setDir}
              options={[
                { value: "add", label: "Add", activeClass: "bg-up text-white" },
                { value: "deduct", label: "Deduct", activeClass: "bg-down text-white" },
              ]}
            />
            <div className="relative">
              <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-muted">$</span>
              <input
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value.replace(",", "."))}
                placeholder="0.00"
                className="num h-12 w-full rounded-lg border border-line bg-bg pl-7 pr-3 text-base outline-none focus:border-accent"
                aria-label="Amount"
              />
            </div>
            <div className="grid grid-cols-4 gap-2">
              {PRESETS.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setAmount(String(p))}
                  className="h-9 rounded-md border border-line text-xs font-medium text-muted hover:bg-panel-2 hover:text-fg"
                >
                  ${p.toLocaleString()}
                </button>
              ))}
            </div>
            {dir === "deduct" && account && (
              <button
                type="button"
                onClick={() => setAmount(String(account.balance))}
                className="text-xs text-accent"
              >
                Deduct all available ({fmtUsd(account.balance)})
              </button>
            )}
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Note (optional)"
              maxLength={120}
              className="h-11 w-full rounded-lg border border-line bg-bg px-3 text-base outline-none focus:border-accent sm:text-sm"
            />
            {tooMuch && <p className="text-sm text-down">You only have {fmtUsd(account?.balance)} available.</p>}
            <Button
              type="submit"
              size="lg"
              variant={dir === "add" ? "buy" : "sell"}
              className="w-full"
              loading={busy}
              disabled={!value || !!tooMuch}
            >
              {dir === "add" ? "Add" : "Deduct"} {value ? fmtUsd(value) : "funds"}
            </Button>
          </form>
        </Card>

        <Card className="overflow-hidden md:col-span-3">
          <div className="border-b border-line px-4 py-3 text-base font-semibold">Balance log</div>
          {logLoading && !log ? (
            <ListSkeleton />
          ) : !log?.length ? (
            <EmptyState title="No balance changes yet" />
          ) : (
            <ul className="num max-h-[480px] divide-y divide-line overflow-y-auto">
              {log.map((a) => (
                <li key={a.id} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
                  <div className="min-w-0">
                    <div className="truncate">{a.note || (a.amount > 0 ? "Deposit" : "Withdrawal")}</div>
                    <div className="text-xs text-muted">{fmtDateTime(a.created_at)}</div>
                  </div>
                  <div className="text-right">
                    <div className={cx("font-semibold", pnlClass(a.amount))}>{fmtSignedUsd(a.amount)}</div>
                    <div className="text-xs text-muted">{fmtUsd(a.balance_after)}</div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card className="flex items-center justify-between p-4">
        <div>
          <div className="text-sm font-semibold">Sign out</div>
          <div className="text-xs text-muted">Your trades stay saved in Supabase.</div>
        </div>
        <Button variant="danger" size="sm" onClick={signOut}>
          Sign out
        </Button>
      </Card>
    </div>
  );
}
