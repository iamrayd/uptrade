"use client";

import { useState } from "react";
import type { SymbolInfo } from "@/lib/binance";
import { placeOrder } from "@/lib/actions";
import { setLeverage, useLeverage } from "@/lib/chartPrefs";
import { floorToStep, fmtPrice, fmtQty, fmtSignedUsd, fmtUsd, pnlClass } from "@/lib/format";
import { MAKER_FEE, MAX_LEVERAGE, TAKER_FEE, previewFill } from "@/lib/pnl";
import { toast } from "@/lib/store";
import type { OrderType, Position, Side } from "@/lib/types";
import { Button, Segmented, cx } from "./ui";

const PCTS = [0.25, 0.5, 0.75, 1];
const LEV_PRESETS = [1, 5, 10, 20, 50, 100, 125];

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
  const savedLev = useLeverage();

  const base = info.baseAsset;
  const dir = side === "buy" ? "long" : "short";
  // Adding to an open position always uses that position's leverage (as on exchanges).
  const lockedLev = position && position.side === dir ? position.leverage : null;
  const lev = lockedLev ?? savedLev;

  const limit = parseFloat(limitPrice) || undefined;
  const execPrice = type === "market" ? price : limit;
  // A limit order that would cross the book fills now at market as taker.
  const marketable =
    type === "limit" && limit != null && price != null && (side === "buy" ? limit >= price : limit <= price);
  const fillPrice = marketable ? price : execPrice;
  const feeRate = type === "market" || marketable ? TAKER_FEE : MAKER_FEE;

  const amt = parseFloat(amount) || 0;
  // In USDT mode the amount is the margin you commit; size = margin × leverage / price.
  const qty = fillPrice
    ? floorToStep(sizeMode === "qty" ? amt : (amt * lev) / fillPrice, info.stepSize, info.qtyDecimals)
    : 0;

  const preview = fillPrice && qty > 0 ? previewFill(side, qty, fillPrice, position, lev, feeRate) : null;
  const opposite = position && position.side !== dir ? position : undefined;
  const bal = balance ?? 0;

  let problem: string | null = null;
  if (!execPrice) problem = type === "limit" ? "Enter a limit price" : "Waiting for price…";
  else if (amt > 0 && qty <= 0) problem = `Minimum size is ${info.stepSize} ${base}`;
  else if (!amt) problem = "Enter an amount";
  else if (preview && preview.marginNeeded + preview.fee > bal + preview.cashReturned + 1e-8) problem = "Not enough balance";

  const switchType = (t: OrderType) => {
    setType(t);
    if (t === "limit" && !limitPrice && price) setLimitPrice(price.toFixed(info.priceDecimals));
  };

  const setPct = (p: number) => {
    setSizeMode("usdt");
    // Leave room for the opening fee (charged on notional = margin × leverage).
    const margin = (bal * p) / (1 + lev * feeRate);
    setAmount((Math.floor(margin * 100) / 100).toString());
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
        marketPrice: price,
        leverage: lev,
      });
      const verb = side === "buy" ? "Bought" : "Sold";
      if (order.status === "filled") {
        toast(
          "success",
          `${verb} ${fmtQty(qty, info.qtyDecimals)} ${base} · ${lev}x`,
          `@ ${fmtPrice(order.fill_price, info.priceDecimals)} · fee ${fmtUsd(order.fee)}`,
        );
      } else {
        toast("info", `Limit ${side} placed · ${lev}x`, `${fmtQty(qty, info.qtyDecimals)} ${base} @ ${fmtPrice(execPrice, info.priceDecimals)}`);
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

      <LeverageControl value={lev} locked={lockedLev != null} />

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
          {marketable && (
            <span className="mt-1.5 block text-xs text-amber-400">
              This price is already reached, so it fills now at market as a taker order.
            </span>
          )}
        </label>
      ) : (
        <div className="flex items-center justify-between rounded-lg bg-bg px-3 py-2.5 text-sm">
          <span className="text-muted">Market price</span>
          <span className="num font-semibold">{price ? fmtPrice(price, info.priceDecimals) : "—"}</span>
        </div>
      )}

      <div>
        <div className="mb-1.5 flex items-center justify-between text-xs text-muted">
          <span>{sizeMode === "usdt" ? "Margin" : "Size"}</span>
          <button
            type="button"
            onClick={() => {
              // Convert so switching units keeps the same order.
              if (fillPrice && amt) {
                setAmount(sizeMode === "usdt" ? String(qty) : ((qty * fillPrice) / lev).toFixed(2));
              }
              setSizeMode(sizeMode === "usdt" ? "qty" : "usdt");
            }}
            className="text-accent"
          >
            Enter {sizeMode === "usdt" ? `size in ${base}` : "margin in USDT"}
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
        <Row label="Size">
          {qty > 0 && fillPrice ? (
            <>
              {fmtQty(qty, info.qtyDecimals)} {base} <span className="text-muted">≈ {fmtUsd(qty * fillPrice)}</span>
            </>
          ) : (
            "—"
          )}
        </Row>
        {preview && preview.openQty > 0 && <Row label={`Margin (${preview.leverage}x)`}>{fmtUsd(preview.marginNeeded)}</Row>}
        <Row label={`Fee (${feeRate === 0 ? "maker 0%" : "taker 0.02%"})`}>{preview ? fmtUsd(preview.fee) : "—"}</Row>
        {preview && preview.closeQty > 0 && (
          <Row label={`Est. PnL closing ${preview.closingSide}`}>
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
        {preview?.resulting && (
          <Row label="Est. liquidation price">
            <span className="text-amber-400">
              {preview.resulting.liq ? fmtPrice(preview.resulting.liq, info.priceDecimals) : "None"}
            </span>
          </Row>
        )}
      </dl>

      <Button
        size="lg"
        variant={side === "buy" ? "buy" : "sell"}
        className="w-full"
        loading={busy}
        disabled={!!problem}
        onClick={submit}
      >
        {problem ?? `${type === "limit" && !marketable ? "Place limit " : ""}${side === "buy" ? "Buy / Long" : "Sell / Short"} ${base} · ${lev}x`}
      </Button>
      {type === "limit" && !marketable && (
        <p className="text-center text-xs text-faint">
          Limit orders fill while UpTrade is open, and catch up on missed fills the next time you open it.
        </p>
      )}
    </div>
  );
}

function LeverageControl({ value, locked }: { value: number; locked: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border border-line">
      <button
        type="button"
        disabled={locked}
        onClick={() => setOpen(!open)}
        className="flex h-11 w-full items-center justify-between px-3 text-sm disabled:cursor-default"
      >
        <span className="text-muted">Leverage · Isolated</span>
        <span className="flex items-center gap-1.5">
          <span className={cx("num font-bold", value >= 50 ? "text-amber-400" : "text-fg")}>{value}x</span>
          {locked ? (
            <span className="text-xs text-faint">(open position)</span>
          ) : (
            <svg viewBox="0 0 24 24" className={cx("size-4 text-muted transition", open && "rotate-180")} fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="m6 9 6 6 6-6" />
            </svg>
          )}
        </span>
      </button>
      {open && !locked && (
        <div className="space-y-3 border-t border-line p-3">
          <div className="flex items-center gap-3">
            <button
              type="button"
              aria-label="Decrease leverage"
              onClick={() => setLeverage(value - 1)}
              className="grid size-10 shrink-0 place-items-center rounded-md border border-line text-lg hover:bg-panel-2"
            >
              −
            </button>
            <input
              type="range"
              min={1}
              max={MAX_LEVERAGE}
              value={value}
              onChange={(e) => setLeverage(Number(e.target.value))}
              className="w-full accent-[var(--color-accent)]"
              aria-label="Leverage"
            />
            <button
              type="button"
              aria-label="Increase leverage"
              onClick={() => setLeverage(value + 1)}
              className="grid size-10 shrink-0 place-items-center rounded-md border border-line text-lg hover:bg-panel-2"
            >
              +
            </button>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {LEV_PRESETS.map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => setLeverage(n)}
                className={cx(
                  "h-8 min-w-11 rounded-md border px-2 text-xs font-semibold",
                  n === value ? "border-accent bg-accent-soft text-accent" : "border-line text-muted hover:text-fg",
                )}
              >
                {n}x
              </button>
            ))}
          </div>
          {value >= 50 && (
            <p className="text-xs text-amber-400">
              At {value}x, a move of about {(((1 / value - 0.005) / 0.995) * 100).toFixed(2)}% against you liquidates
              the position.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-muted">{label}</dt>
      <dd className="num text-right font-medium">{children}</dd>
    </div>
  );
}
