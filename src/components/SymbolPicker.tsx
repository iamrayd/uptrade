"use client";

import { useEffect, useMemo, useState } from "react";
import { POPULAR_SYMBOLS, fetch24h, lookupSymbol, type Ticker24h } from "@/lib/binance";
import { baseAsset, fmtPct, pnlClass } from "@/lib/format";
import { Sheet, Spinner, cx } from "./ui";

export function SymbolPicker({
  open,
  onClose,
  current,
  onSelect,
}: {
  open: boolean;
  onClose: () => void;
  current: string;
  onSelect: (symbol: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [stats, setStats] = useState<Record<string, Ticker24h>>({});
  const [looking, setLooking] = useState(false);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    if (!open) return;
    fetch24h(POPULAR_SYMBOLS)
      .then((list) => setStats(Object.fromEntries(list.map((t) => [t.symbol, t]))))
      .catch(() => {});
  }, [open]);

  const q = query.trim().toUpperCase();
  const list = useMemo(() => POPULAR_SYMBOLS.filter((s) => !q || s.includes(q)), [q]);

  const choose = (s: string) => {
    onSelect(s);
    setQuery("");
    setNotFound(false);
    onClose();
  };

  async function tryCustom(e: React.FormEvent) {
    e.preventDefault();
    if (list.length) return choose(list[0]);
    setLooking(true);
    setNotFound(false);
    const info = await lookupSymbol(q);
    setLooking(false);
    if (info) choose(info.symbol);
    else setNotFound(true);
  }

  return (
    <Sheet open={open} onClose={onClose} title="Select market">
      <form onSubmit={tryCustom} className="sticky top-[57px] z-10 border-b border-line bg-panel p-3">
        <input
          autoFocus
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setNotFound(false);
          }}
          placeholder="Search e.g. BTC, SOL, PEPE"
          className="h-11 w-full rounded-lg border border-line bg-bg px-3 text-base outline-none focus:border-accent"
          autoCapitalize="characters"
          autoCorrect="off"
        />
      </form>
      <ul className="p-2">
        {list.map((s) => {
          const t = stats[s];
          return (
            <li key={s}>
              <button
                onClick={() => choose(s)}
                className={cx(
                  "flex h-14 w-full items-center justify-between rounded-lg px-3 text-left hover:bg-panel-2",
                  s === current && "bg-accent-soft",
                )}
              >
                <span>
                  <span className="font-semibold">{baseAsset(s)}</span>
                  <span className="text-muted">/USDT</span>
                </span>
                <span className="num text-right">
                  <span className="block text-sm">{t ? t.lastPrice.toLocaleString("en-US", { maximumFractionDigits: 8 }) : "—"}</span>
                  <span className={cx("block text-xs", pnlClass(t?.changePct))}>{t ? fmtPct(t.changePct) : ""}</span>
                </span>
              </button>
            </li>
          );
        })}
        {!list.length && q && (
          <li className="px-3 py-6 text-center text-sm text-muted">
            {looking ? (
              <Spinner />
            ) : notFound ? (
              <>No USDT market found for “{q}”.</>
            ) : (
              <button onClick={tryCustom} className="text-accent underline-offset-2 hover:underline">
                Look up {q.endsWith("USDT") ? q : `${q}USDT`} on Binance
              </button>
            )}
          </li>
        )}
      </ul>
    </Sheet>
  );
}
