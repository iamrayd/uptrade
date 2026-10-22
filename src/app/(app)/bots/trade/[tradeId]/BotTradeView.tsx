"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { fetchKlines, INTERVAL_SECONDS, INTERVALS, type Interval } from "@/lib/binance";
import { useBotTrade } from "@/hooks/useBots";
import { usePrices, useSymbolInfo } from "@/hooks/useMarket";
import { EXIT_LABEL, botUnrealized, fmtR, priceToR } from "@/lib/bots";
import { DEFAULT_INDICATORS, type IndicatorConfig } from "@/lib/indicators";
import { baseAsset, fmtDateTime, fmtDuration, fmtPrice, fmtQty, fmtSignedUsd, fmtUsd, pnlClass } from "@/lib/format";
import type { BotTrade } from "@/lib/types";
import { Chart, type ChartLine } from "@/components/Chart";
import { ExitBadge, RulesText, TfBadge } from "@/components/BotBits";
import { LevBadge } from "@/components/PositionsList";
import { Card, EmptyState, SideBadge, Skeleton, cx } from "@/components/ui";

/** Chart overlays matching what each strategy looked at. */
const STRATEGY_INDICATORS: Record<string, IndicatorConfig> = {
  ema_trend: {
    ...DEFAULT_INDICATORS,
    ma1: { on: true, type: "EMA", period: 9 },
    ma2: { on: true, type: "EMA", period: 21 },
    ma3: { on: true, type: "EMA", period: 200 },
  },
  bb_rsi: { ...DEFAULT_INDICATORS, ma1: { ...DEFAULT_INDICATORS.ma1, on: false }, bb: { on: true, period: 20, mult: 2 }, rsi: { on: true, period: 14 } },
  donchian: { ...DEFAULT_INDICATORS, ma1: { ...DEFAULT_INDICATORS.ma1, on: false } },
  macd_adx: { ...DEFAULT_INDICATORS, ma1: { ...DEFAULT_INDICATORS.ma1, on: false }, macd: { on: true, fast: 12, slow: 26, signal: 9 } },
  supertrend: { ...DEFAULT_INDICATORS, ma1: { ...DEFAULT_INDICATORS.ma1, on: false } },
};

export function BotTradeView({ tradeId }: { tradeId: string }) {
  const { data, loading } = useBotTrade(tradeId);
  const t = data?.trade;

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-3 lg:p-6">
      {t ? (
        <Link href={`/bots/${t.account_id}`} className="inline-flex h-10 items-center gap-1 text-sm text-muted hover:text-fg">
          <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path d="m15 18-6-6 6-6" />
          </svg>
          {data?.strategy?.name ?? t.strategy} · {t.timeframe}
        </Link>
      ) : (
        <div className="h-10" />
      )}
      {loading && !data ? (
        <Skeleton className="h-96" />
      ) : !t ? (
        <Card>
          <EmptyState title="Trade not found" />
        </Card>
      ) : (
        <TradeJournal t={t} strategyName={data?.strategy?.name ?? t.strategy} rules={data?.strategy?.rules ?? null} />
      )}
    </div>
  );
}

function TradeJournal({ t, strategyName, rules }: { t: BotTrade; strategyName: string; rules: string | null }) {
  const info = useSymbolInfo(t.symbol);
  const dp = info.priceDecimals;
  const prices = usePrices(t.status === "open" ? [t.symbol] : []);
  const mark = prices[t.symbol];
  const net = t.status === "closed" ? t.net_pnl : botUnrealized(t, mark) - t.entry_fee;
  const stopDist = Math.abs(t.entry_price - t.initial_stop);
  const notional = t.qty * t.entry_price;
  const rr = t.take_profit != null && stopDist ? Math.abs(t.take_profit - t.entry_price) / stopDist : null;
  const equityAtEntry = t.risk_pct > 0 ? t.risk_usd / t.risk_pct : null;

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <h1 className="mr-1 text-xl font-bold">{baseAsset(t.symbol)}/USDT</h1>
            <SideBadge side={t.side} />
            <LevBadge leverage={t.leverage} />
            <TfBadge tf={t.timeframe} />
            {t.status === "open" ? <span className="text-xs text-accent">Open</span> : <ExitBadge reason={t.exit_reason} />}
          </div>
          <div className={cx("num text-right text-xl font-bold", pnlClass(net))}>
            {fmtSignedUsd(net)} <span className="text-sm font-medium">{t.status === "closed" ? fmtR(t.r_multiple) : fmtR(net != null && t.risk_usd ? net / t.risk_usd : null)}</span>
            <div className="text-xs font-normal text-muted">{t.status === "closed" ? "net of fees · R = net ÷ planned risk" : "unrealized, after entry fee"}</div>
          </div>
        </div>
        <div className="mt-1 text-sm text-muted">
          {strategyName} · opened {fmtDateTime(t.opened_at)}
          {t.closed_at && ` · closed ${fmtDateTime(t.closed_at)} · held ${fmtDuration(t.opened_at, t.closed_at)}`}
        </div>
      </Card>

      <TradeChart t={t} />

      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="1 · Why it entered">
          <p className="text-sm leading-relaxed">{t.entry_reason}</p>
          <p className="mt-2 text-xs text-faint">
            Signal on the {t.timeframe} bar that opened {fmtDateTime(t.signal_bar_time)} (decided on its close, so no repainting). Filled at market{" "}
            {fmtDateTime(t.opened_at)}.
          </p>
        </Section>

        <Section title="2 · Indicators at the signal">
          <dl className="num grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
            {Object.entries(t.entry_indicators).map(([k, v]) => (
              <div key={k} className="flex justify-between gap-2 border-b border-line/50 pb-1">
                <dt className="text-muted">{k}</dt>
                <dd className="font-medium">{Math.abs(v) >= 1 ? +v.toFixed(Math.max(0, dp)) : +v.toPrecision(5)}</dd>
              </div>
            ))}
          </dl>
        </Section>

        <Section title="3 · Risk management">
          <dl className="num space-y-1.5 text-sm">
            <Row k="Entry" v={fmtPrice(t.entry_price, dp)} />
            <Row k="Initial stop" v={`${fmtPrice(t.initial_stop, dp)} (${((stopDist / t.entry_price) * 100).toFixed(2)}% away)`} />
            <Row k="Target" v={t.take_profit != null ? `${fmtPrice(t.take_profit, dp)} (${rr?.toFixed(2)}R)` : "None: trailing exit"} />
            <Row k="Planned risk" v={`${fmtUsd(t.risk_usd)} = ${(t.risk_pct * 100).toFixed(2)}% of ${equityAtEntry ? fmtUsd(equityAtEntry) : "equity"}`} />
            <Row k="Size" v={`${fmtQty(t.qty, info.qtyDecimals)} ${info.baseAsset} · ${fmtUsd(notional)} notional`} />
            <Row k="Leverage / margin" v={`${t.leverage}x · ${fmtUsd(t.margin)} isolated`} />
            <Row k="Liquidation" v={t.liq_price > 0 ? fmtPrice(t.liq_price, dp) : "None"} cls="text-amber-400" />
            <Row k="Entry fee" v={fmtUsd(t.entry_fee)} />
          </dl>
          {t.sizing_notes.length > 0 && (
            <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-muted">
              {t.sizing_notes.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          )}
        </Section>

        <Section title={t.status === "closed" ? "4 · Management & exit" : "4 · Management"}>
          <dl className="num space-y-1.5 text-sm">
            <Row k="Current stop" v={`${fmtPrice(t.stop_price, dp)}${t.trailed ? " (trailed)" : ""}`} />
            <Row k="Best price (MFE)" v={`${fmtPrice(t.mfe_price, dp)} · ${fmtR(priceToR(t, t.mfe_price))}`} />
            <Row k="Worst price (MAE)" v={`${fmtPrice(t.mae_price, dp)} · ${fmtR(priceToR(t, t.mae_price))}`} />
            {t.status === "closed" && (
              <>
                <Row k="Exit" v={`${fmtPrice(t.exit_price, dp)} · ${t.exit_reason ? EXIT_LABEL[t.exit_reason] : ""}`} />
                <Row k="Price PnL" v={fmtSignedUsd(t.realized_pnl)} cls={pnlClass(t.realized_pnl)} />
                <Row k="Fees" v={fmtUsd(t.entry_fee + (t.exit_fee ?? 0))} />
                <Row k="Net" v={`${fmtSignedUsd(t.net_pnl)} · ${fmtR(t.r_multiple)}`} cls={pnlClass(t.net_pnl)} />
              </>
            )}
          </dl>
          {t.exit_note && <p className="mt-3 text-sm text-muted">{t.exit_note}</p>}
          {t.stop_history.length > 0 && <StopMoves moves={t.stop_history} dp={dp} />}
          {t.status === "closed" && <Lesson t={t} />}
        </Section>
      </div>

      {rules && (
        <Section title="Strategy rules">
          <RulesText text={rules} />
        </Section>
      )}
    </div>
  );
}

function StopMoves({ moves, dp }: { moves: BotTrade["stop_history"]; dp: number }) {
  const [all, setAll] = useState(false);
  const shown = all || moves.length <= 6 ? moves : [...moves.slice(0, 2), null, ...moves.slice(-3)];
  return (
    <div className="mt-3">
      <div className="flex items-baseline justify-between text-xs font-semibold text-muted">
        <span>Stop moves ({moves.length})</span>
        {moves.length > 6 && (
          <button className="font-normal text-accent" onClick={() => setAll((v) => !v)}>
            {all ? "Show fewer" : "Show all"}
          </button>
        )}
      </div>
      <ol className="num mt-1 space-y-1 text-xs text-muted">
        {shown.map((s, i) =>
          s ? (
            <li key={i}>
              {fmtDateTime(s.at)}: {fmtPrice(s.from, dp)} → {fmtPrice(s.to, dp)}. {s.note}
            </li>
          ) : (
            <li key={i} className="text-faint">
              … {moves.length - 5} more
            </li>
          ),
        )}
      </ol>
    </div>
  );
}

/** The hourly analysis's post-mortem, or until then a one-line read derived from the numbers. */
function Lesson({ t }: { t: BotTrade }) {
  const rv = t.review;
  if (rv)
    return (
      <div className="mt-3 rounded-lg bg-panel-2 px-3 py-2 text-xs text-muted">
        <div className="font-semibold text-fg">Review: {rv.title}</div>
        <p className="mt-1">{rv.why}</p>
        {rv.flags.length > 0 && (
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-amber-400">
            {rv.flags.map((f, i) => (
              <li key={i}>{f}</li>
            ))}
          </ul>
        )}
        {rv.outcome === "loss" && <p className="mt-1">Fix: {rv.fix}</p>}
        {rv.afterExitR != null && (
          <p className="mt-1 text-faint">
            After the exit, price reached {fmtR(rv.afterExitR)} from the entry within {rv.afterExitBars} bars.
          </p>
        )}
      </div>
    );
  const mfeR = priceToR(t, t.mfe_price);
  const r = t.r_multiple ?? 0;
  let text: string;
  if (t.exit_reason === "take_profit") text = "Played out as planned: target reached.";
  else if (r < 0 && mfeR != null && mfeR >= 1) text = `Was up ${fmtR(mfeR)} before reversing into a loss. A breakeven rule at +1R would have saved it.`;
  else if (r < 0 && mfeR != null && mfeR < 0.25) text = "Went against the entry almost immediately: the signal had no follow-through.";
  else if (r > 0 && mfeR != null && mfeR - r > 1.5) text = `Gave back ${(mfeR - r).toFixed(1)}R from the peak. A tighter trail would have kept more.`;
  else if (r > 0) text = "A winning exit by the rules.";
  else text = "A loss within the planned risk. That's the cost of the strategy's edge.";
  return <p className="mt-3 rounded-lg bg-panel-2 px-3 py-2 text-xs text-muted">Review: {text}</p>;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card className="p-4">
      <h2 className="mb-3 text-sm font-semibold">{title}</h2>
      {children}
    </Card>
  );
}

function Row({ k, v, cls }: { k: string; v: string; cls?: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-muted">{k}</dt>
      <dd className={cx("text-right font-medium", cls)}>{v}</dd>
    </div>
  );
}

function TradeChart({ t }: { t: BotTrade }) {
  const info = useSymbolInfo(t.symbol);
  const [candles, setCandles] = useState<Candle[] | null>(null);

  useEffect(() => {
    const tf: Interval = (INTERVALS as readonly string[]).includes(t.timeframe) ? (t.timeframe as Interval) : "1h";
    const sec = INTERVAL_SECONDS[tf];
    const open = new Date(t.opened_at).getTime();
    const close = t.closed_at ? new Date(t.closed_at).getTime() : Date.now();
    const held = Math.ceil((close - open) / 1000 / sec);
    // Enough bars before entry for the strategy's indicators (EMA 200) plus the trade and some after.
    const before = 260;
    const after = Math.max(10, Math.ceil(held * 0.3));
    const limit = Math.min(1000, before + held + after);
    const ctrl = new AbortController();
    fetchKlines(t.symbol, tf, { startTime: open - before * sec * 1000, limit, signal: ctrl.signal })
      .then(setCandles)
      .catch(() => {});
    return () => ctrl.abort();
  }, [t.symbol, t.timeframe, t.opened_at, t.closed_at]);

  const lines = useMemo<ChartLine[]>(() => {
    const l: ChartLine[] = [{ price: t.entry_price, color: "#6d8cff", title: "Entry" }];
    l.push({ price: t.initial_stop, color: "#ea3943", title: "Stop", dashed: true });
    if (t.trailed && t.stop_price !== t.initial_stop) l.push({ price: t.stop_price, color: "#f59e0b", title: "Trail", dashed: true });
    if (t.take_profit != null) l.push({ price: t.take_profit, color: "#16c784", title: "Target", dashed: true });
    if (t.exit_price != null) l.push({ price: t.exit_price, color: (t.net_pnl ?? 0) >= 0 ? "#16c784" : "#ea3943", title: "Exit" });
    return l;
  }, [t]);

  return (
    <Card className="overflow-hidden">
      <div className="relative h-72 sm:h-96">
        <Chart fit indicators={STRATEGY_INDICATORS[t.strategy] ?? DEFAULT_INDICATORS} history={candles} last={null} priceDecimals={info.priceDecimals} tickSize={info.tickSize} lines={lines} />
        {!candles && (
          <div className="absolute inset-0 grid place-items-center">
            <Skeleton className="h-3/4 w-11/12" />
          </div>
        )}
      </div>
    </Card>
  );
}

type Candle = Awaited<ReturnType<typeof fetchKlines>>[number];
