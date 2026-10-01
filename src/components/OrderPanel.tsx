"use client";

import { useState } from "react";
import type { SymbolInfo } from "@/lib/binance";
import { placeOrder } from "@/lib/actions";
import { floorToStep, fmtPrice, fmtQty, fmtSignedUsd, fmtUsd, pnlClass } from "@/lib/format";
import { previewFill } from "@/lib/pnl";
import { toast } from "@/lib/store";
import type { OrderType, Position, Side } from "@/lib/types";
import { Button, Segmented, cx } from "./ui";

const PCTS = [0.25, 0.5, 0.75, 1];

export function OrderPanel({
  info,
  price,
  balance,
  position,
  initialSide = "buy",
  onDone,
}: {
  info: SymbolInfo;
  price: number | undefined;
  balance: number | undefined;
  position: Position | undefined;
  initialSide?: Side;
  onDone?: () => void;
}) {
  const [side, setSide] = useState<Side>(initialSide);
  const [type, setType] = useState<OrderType>("market");
  const [sizeMode, setSizeMode] = useState<"usdt" | "qty">("usdt");
  const [amount, setAmount] = useState("");
  const [limitPrice, setLimitPrice] = useState("");
  const [busy, setBusy] = useState(false);

  const base = info.baseAsset;
  const execPrice = type === "market" ? price : parseFloat(limitPrice) || undefined;
  const amt = parseFloat(amount) || 0;
  const qty = execPrice
    ? floorToStep(sizeMode === "qty" ? amt : amt / execPrice, info.stepSize, info.qtyDecimals)
    : 0;

  const preview = execPrice && qty > 0 ? previewFill(side, qty, execPrice, position) : null;
  const opposite = position && position.side !== (side === "buy" ? "long" : "short") ? position : undefined;
  const bal = balance ?? 0;

  let problem: string | null = null;
  if (!execPrice) problem = type === "limit" ? "Enter a limit price" : "Waiting for price…";
  else if (amt > 0 && qty <= 0) problem = `Minimum size is ${info.stepSize} ${base}`;
  else if (!amt) problem = "Enter an amount";
  else if (preview && preview.cashNeeded > bal + preview.cashReturned + 1e-8) problem = "Not enough balance";

  const switchType = (t: OrderType) => {
    setType(t);
    if (t === "limit" && !limitPrice && price) setLimitPrice(price.toFixed(info.priceDecimals));
  };

  const setPct = (p: number) => {
    if (!execPrice) return;
    setSizeMode("usdt");
    // Leave a hair of room so rounding never trips "insufficient balance".
    setAmount((Math.floor(bal * p * 100) / 100).toString());
  };

  const closeAll = () => {
    if (!opposite) return;
    setSizeMode("qty");
    setAmount(String(opposite.qty));
  };

  async function submit() {
    if (problem || !execPrice) return;
    setBusy(true);
    try {
      const order = await placeOrder({
        symbol: info.symbol,
        side,
        type,
        qty,
        limitPrice: type === "limit" ? execPrice : undefined,
        marketPrice: type === "market" ? execPrice : undefined,
      });
      const verb = side === "buy" ? "Bought" : "Sold";
      if (order.status === "filled") {
        toast("success", `${verb} ${fmtQty(qty, info.qtyDecimals)} ${base}`, `@ ${fmtPrice(order.fill_price, info.priceDecimals)}`);
      } else {
        toast("info", `Limit ${side} placed`, `${fmtQty(qty, info.qtyDecimals)} ${base} @ ${fmtPrice(execPrice, info.priceDecimals)}`);
      }
      setAmount("");
      onDone?.();
    } catch (e) {
      toast("error", "Order failed", (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const inputCls =
    "num h-12 w-full rounded-lg border border-line bg-bg pl-3 pr-16 text-base outline-none focus:border-accent";

  return (
    <div className="space-y-4">
      <Segmented
        value={side}
        onChange={setSide}
        options={[
          { value: "buy", label: "Buy / Long", activeClass: "bg-up text-white" },
          { value: "sell", label: "Sell / Short", activeClass: "bg-down text-white" },
        ]}
      />

      <Segmented
        size="sm"
        value={type}
        onChange={switchType}
        options={[
          { value: "market", label: "Market" },
          { value: "limit", label: "Limit" },
        ]}
      />

      {type === "limit" ? (
        <label className="block">
          <span className="mb-1.5 flex justify-between text-xs text-muted">
            <span>Limit price</span>
            {price && (
              <button type="button" onClick={() => setLimitPrice(price.toFixed(info.priceDecimals))} className="text-accent">
                Use last {fmtPrice(price, info.priceDecimals)}
              </button>
            )}
          </span>
          <div className="relative">
            <input
              inputMode="decimal"
              value={limitPrice}
              onChange={(e) => setLimitPrice(e.target.value.replace(",", "."))}
              placeholder="0.00"
              className={inputCls}
            />
            <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm text-muted">USDT</span>
          </div>
        </label>
      ) : (
        <div className="flex items-center justify-between rounded-lg bg-bg px-3 py-2.5 text-sm">
          <span className="text-muted">Market price</span>
          <span className="num font-semibold">{price ? fmtPrice(price, info.priceDecimals) : "—"}</span>
        </div>
      )}

      <div>
        <div className="mb-1.5 flex items-center justify-between text-xs text-muted">
          <span>Amount</span>
          <button
            type="button"
            onClick={() => {
              // Convert the current value so switching units doesn't lose the order size.
              if (execPrice && amt) {
                setAmount(sizeMode === "usdt" ? String(qty) : (qty * execPrice).toFixed(2));
              }
              setSizeMode(sizeMode === "usdt" ? "qty" : "usdt");
            }}
            className="text-accent"
          >
            Enter in {sizeMode === "usdt" ? base : "USDT"}
          </button>
        </div>
        <div className="relative">
          <input
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(",", "."))}
            placeholder="0"
            className={inputCls}
          />
          <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm text-muted">
            {sizeMode === "usdt" ? "USDT" : base}
          </span>
        </div>
        <div className="mt-2 grid grid-cols-4 gap-2">
          {PCTS.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setPct(p)}
              className="h-9 rounded-md border border-line text-xs font-medium text-muted hover:bg-panel-2 hover:text-fg"
            >
              {p * 100}%
            </button>
          ))}
        </div>
        {opposite && (
          <button
            type="button"
            onClick={closeAll}
            className="mt-2 h-9 w-full rounded-md border border-line text-xs font-medium text-muted hover:bg-panel-2 hover:text-fg"
          >
            Close entire {opposite.side} ({fmtQty(opposite.qty, info.qtyDecimals)} {base})
          </button>
        )}
      </div>

      <dl className="space-y-1.5 rounded-lg bg-bg p-3 text-sm">
        <Row label="Available">{fmtUsd(balance)}</Row>
        <Row label="Size">{qty > 0 ? `${fmtQty(qty, info.qtyDecimals)} ${base}` : "—"}</Row>
        <Row label={preview && preview.closeQty > 0 && !preview.openQty ? "Proceeds" : "Cost"}>
          {preview ? fmtUsd(preview.openQty > 0 ? preview.cashNeeded : preview.cashReturned) : "—"}
        </Row>
        {preview && preview.closeQty > 0 && (
          <Row label={`Est. PnL (closing ${preview.closingSide})`}>
            <span className={pnlClass(preview.estPnl)}>{fmtSignedUsd(preview.estPnl)}</span>
          </Row>
        )}
        <Row label="Position after">
          {preview ? (
            preview.resulting ? (
              <span className={preview.resulting.side === "long" ? "text-up" : "text-down"}>
                {preview.resulting.side} {fmtQty(preview.resulting.qty, info.qtyDecimals)} {base}
              </span>
            ) : (
              <span className="text-muted">Flat</span>
            )
          ) : position ? (
            <span className="text-muted">
              {position.side} {fmtQty(position.qty, info.qtyDecimals)}
            </span>
          ) : (
            "—"
          )}
        </Row>
      </dl>

      <Button
        size="lg"
        variant={side === "buy" ? "buy" : "sell"}
        className="w-full"
        loading={busy}
        disabled={!!problem}
        onClick={submit}
      >
        {problem ?? `${type === "limit" ? "Place limit " : ""}${side === "buy" ? "Buy" : "Sell"} ${base}`}
      </Button>
      {type === "limit" && (
        <p className="text-center text-xs text-faint">
          Limit orders fill while UpTrade is open, and catch up on missed fills the next time you open it.
        </p>
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-muted">{label}</dt>
      <dd className={cx("num text-right font-medium")}>{children}</dd>
    </div>
  );
}
