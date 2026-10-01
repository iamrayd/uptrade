"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { INTERVALS, MARKET_COOKIE, type Interval } from "@/lib/binance";
import { baseAsset, fmtPrice, fmtQty } from "@/lib/format";
import { summarizeEquity } from "@/lib/pnl";
import type { Side } from "@/lib/types";
import { useAccount, useOpenOrders, useOpenPositions } from "@/hooks/useTrading";
import { useKlines, usePrices, useSymbolInfo, useSymbolInfos } from "@/hooks/useMarket";
import { AccountSummary } from "@/components/AccountSummary";
import { Chart, type ChartLine } from "@/components/Chart";
import { OrderPanel } from "@/components/OrderPanel";
import { OrdersList } from "@/components/OrdersList";
import { PositionsList } from "@/components/PositionsList";
import { SymbolPicker } from "@/components/SymbolPicker";
import { IndicatorLegend, IndicatorsMenu } from "@/components/IndicatorsMenu";
import { useIndicators } from "@/lib/chartPrefs";
import { Button, Card, LiveDot, Sheet, Skeleton, cx } from "@/components/ui";

export function TradeView({ initialSymbol, initialInterval }: { initialSymbol: string; initialInterval: Interval }) {
  const [symbol, setSymbol] = useState(initialSymbol);
  const [interval, setIntervalTf] = useState<Interval>(initialInterval);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [sheetSide, setSheetSide] = useState<Side | null>(null);
  const [tab, setTab] = useState<"positions" | "orders">("positions");

  // Keep URL + a cookie in sync so refresh, back-navigation and the next visit land on the same market.
  useEffect(() => {
    document.cookie = `${MARKET_COOKIE}=${symbol}:${interval}; path=/; max-age=31536000; samesite=lax`;
    window.history.replaceState(null, "", `/trade?s=${symbol}&tf=${interval}`);
  }, [symbol, interval]);

  const info = useSymbolInfo(symbol);
  const indicators = useIndicators();
  const [indOpen, setIndOpen] = useState(false);
  const extraPanes = Number(indicators.rsi.on) + Number(indicators.macd.on);
  const { history, last, error: chartError, status } = useKlines(symbol, interval);
  const { data: account } = useAccount();
  const { data: positions, loading: posLoading } = useOpenPositions();
  const { data: orders, loading: ordLoading } = useOpenOrders();

  const watched = useMemo(
    () => [symbol, ...(positions ?? []).map((p) => p.symbol), ...(orders ?? []).map((o) => o.symbol)],
    [symbol, positions, orders],
  );
  const prices = usePrices(watched);
  const infos = useSymbolInfos(watched);
  const price = prices[symbol] ?? last?.close;
  const position = positions?.find((p) => p.symbol === symbol);

  const summary = account ? summarizeEquity(account.balance, positions ?? [], prices) : null;

  const lines = useMemo<ChartLine[]>(() => {
    const out: ChartLine[] = [];
    if (position)
      out.push({
        price: position.avg_entry,
        color: position.side === "long" ? "#16c784" : "#ea3943",
        title: `${position.side === "long" ? "Long" : "Short"} ${fmtQty(position.qty, info.qtyDecimals)}`,
      });
    (orders ?? [])
      .filter((o) => o.symbol === symbol && o.limit_price)
      .forEach((o) =>
        out.push({
          price: o.limit_price!,
          color: "#6d8cff",
          title: `Limit ${o.side}`,
          dashed: true,
        }),
      );
    return out;
  }, [position, orders, symbol, info.qtyDecimals]);

  const selectSymbol = useCallback((s: string) => {
    setSymbol(s);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  return (
    <div className="mx-auto max-w-[1600px] p-3 lg:p-4">
      <div className="grid gap-3 lg:grid-cols-12 lg:gap-4">
        {/* ── Left: market + chart + positions ── */}
        <section className="min-w-0 space-y-3 lg:col-span-8 lg:space-y-4 xl:col-span-9">
          <Card className="overflow-hidden">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-3 py-2.5 sm:px-4">
              <button
                onClick={() => setPickerOpen(true)}
                className="-ml-1 flex h-10 items-center gap-1.5 rounded-lg px-1.5 text-lg font-bold hover:bg-panel-2"
                aria-label="Change market"
              >
                {baseAsset(symbol)}
                <span className="text-sm font-medium text-muted">/USDT</span>
                <svg viewBox="0 0 24 24" className="size-4 text-muted" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="m6 9 6 6 6-6" />
                </svg>
              </button>
              <div className="num text-lg font-semibold">{price ? fmtPrice(price, info.priceDecimals) : <Skeleton className="h-6 w-24" />}</div>
              <LiveDot status={status} />
              <button
                onClick={() => setIndOpen(true)}
                className="flex h-9 items-center gap-1.5 rounded-md border border-line px-2.5 text-sm font-medium text-muted hover:bg-panel-2 hover:text-fg"
              >
                <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M3 17l5-6 4 4 8-9" />
                </svg>
                Indicators
              </button>
              <div className="scrollbar-none -mx-1 ml-auto flex w-full overflow-x-auto sm:w-auto">
                {INTERVALS.map((tf) => (
                  <button
                    key={tf}
                    onClick={() => setIntervalTf(tf)}
                    className={cx(
                      "h-9 min-w-11 rounded-md px-2.5 text-sm font-medium",
                      tf === interval ? "bg-panel-2 text-fg" : "text-muted hover:text-fg",
                    )}
                  >
                    {tf}
                  </button>
                ))}
              </div>
            </div>
            <div
              className={cx(
                "relative min-h-[280px]",
                extraPanes === 0 && "h-[45dvh] lg:h-[540px]",
                extraPanes === 1 && "h-[56dvh] lg:h-[640px]",
                extraPanes === 2 && "h-[66dvh] lg:h-[740px]",
              )}
            >
              <IndicatorLegend cfg={indicators} />
              <Chart
                indicators={indicators}
                history={history}
                last={last}
                priceDecimals={info.priceDecimals}
                tickSize={info.tickSize}
                lines={lines}
              />
              {!history && !chartError && (
                <div className="absolute inset-0 grid place-items-center">
                  <Skeleton className="h-3/4 w-11/12" />
                </div>
              )}
              {chartError && (
                <div className="absolute inset-0 grid place-items-center text-sm text-muted">{chartError}</div>
              )}
            </div>
          </Card>

          <Card className="p-4 lg:hidden">
            <AccountSummary summary={summary} />
          </Card>

          <Card className="overflow-hidden">
            <div className="flex border-b border-line px-2" role="tablist">
              {(
                [
                  ["positions", "Positions", positions?.length],
                  ["orders", "Open orders", orders?.length],
                ] as const
              ).map(([key, label, count]) => (
                <button
                  key={key}
                  role="tab"
                  aria-selected={tab === key}
                  onClick={() => setTab(key)}
                  className={cx(
                    "relative h-12 px-3 text-sm font-semibold transition",
                    tab === key ? "text-fg" : "text-muted hover:text-fg",
                  )}
                >
                  {label}
                  {count ? <span className="ml-1.5 rounded-full bg-panel-2 px-1.5 py-0.5 text-xs">{count}</span> : null}
                  {tab === key && <span className="absolute inset-x-3 bottom-0 h-0.5 rounded-full bg-accent" />}
                </button>
              ))}
            </div>
            {tab === "positions" ? (
              <PositionsList
                positions={positions}
                prices={prices}
                infos={infos}
                loading={posLoading}
                onSelectSymbol={selectSymbol}
              />
            ) : (
              <OrdersList orders={orders} prices={prices} infos={infos} loading={ordLoading} onSelectSymbol={selectSymbol} />
            )}
          </Card>
        </section>

        {/* ── Right (desktop): account + order form ── */}
        <aside className="hidden lg:col-span-4 lg:block xl:col-span-3">
          <div className="sticky top-[4.5rem] space-y-4">
            <Card className="p-4">
              <AccountSummary summary={summary} compact />
            </Card>
            <Card className="p-4">
              <OrderPanel key={symbol} info={info} price={price} balance={account?.balance} position={position} />
            </Card>
          </div>
        </aside>
      </div>

      {/* ── Phone: sticky buy/sell bar above the tab bar ── */}
      <div className="fixed inset-x-0 bottom-[calc(4rem+env(safe-area-inset-bottom))] z-30 border-t border-line bg-bg/95 p-3 backdrop-blur lg:hidden">
        <div className="grid grid-cols-2 gap-3">
          <Button variant="buy" size="lg" onClick={() => setSheetSide("buy")}>
            Buy / Long
          </Button>
          <Button variant="sell" size="lg" onClick={() => setSheetSide("sell")}>
            Sell / Short
          </Button>
        </div>
      </div>
      {/* Spacer so content isn't hidden behind the bar on phones. */}
      <div className="h-20 lg:hidden" />

      <Sheet
        open={sheetSide !== null}
        onClose={() => setSheetSide(null)}
        title={
          <span>
            {baseAsset(symbol)}/USDT{" "}
            <span className="num ml-1 text-sm font-normal text-muted">{price ? fmtPrice(price, info.priceDecimals) : ""}</span>
          </span>
        }
      >
        <div className="p-4">
          {sheetSide && (
            <OrderPanel
              key={`${symbol}-${sheetSide}`}
              info={info}
              price={price}
              balance={account?.balance}
              position={position}
              initialSide={sheetSide}
              onDone={() => setSheetSide(null)}
            />
          )}
        </div>
      </Sheet>

      <SymbolPicker open={pickerOpen} onClose={() => setPickerOpen(false)} current={symbol} onSelect={selectSymbol} />
      <IndicatorsMenu open={indOpen} onClose={() => setIndOpen(false)} cfg={indicators} />
    </div>
  );
}
