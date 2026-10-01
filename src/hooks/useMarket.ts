"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
  BINANCE_WS,
  fallbackInfo,
  fetchKlines,
  getSymbolInfo,
  parseWsKline,
  type Interval,
  type SymbolInfo,
} from "@/lib/binance";
import type { Candle } from "@/lib/types";
import { connectWs, type WsStatus } from "@/lib/ws";

// ───────────────────────── Ticker hub ─────────────────────────
// One combined miniTicker socket for every symbol any component cares about.
// Snapshots are throttled to ~4/s so lists don't re-render on every frame.

type Prices = Record<string, number>;

const hub = {
  counts: new Map<string, number>(),
  prices: {} as Prices,
  pending: {} as Prices,
  status: "connecting" as WsStatus,
  listeners: new Set<() => void>(),
  close: null as null | (() => void),
  flushTimer: undefined as ReturnType<typeof setTimeout> | undefined,
  rebuildTimer: undefined as ReturnType<typeof setTimeout> | undefined,
  streamKey: "",
};

function emit() {
  hub.listeners.forEach((l) => l());
}

function scheduleFlush() {
  if (hub.flushTimer) return;
  hub.flushTimer = setTimeout(() => {
    hub.flushTimer = undefined;
    hub.prices = { ...hub.prices, ...hub.pending };
    hub.pending = {};
    emit();
  }, 250);
}

function rebuildSocket() {
  clearTimeout(hub.rebuildTimer);
  hub.rebuildTimer = setTimeout(() => {
    const symbols = [...hub.counts.keys()].sort();
    const key = symbols.join(",");
    if (key === hub.streamKey) return;
    hub.streamKey = key;
    hub.close?.();
    hub.close = null;
    if (!symbols.length) return;
    const streams = symbols.map((s) => `${s.toLowerCase()}@miniTicker`).join("/");
    hub.close = connectWs(
      `${BINANCE_WS}/stream?streams=${streams}`,
      (msg) => {
        const d = (msg as { data?: { s: string; c: string } }).data;
        if (!d) return;
        hub.pending[d.s] = +d.c;
        scheduleFlush();
      },
      (s) => {
        hub.status = s;
        emit();
      },
    );
  }, 100);
}

function retain(symbols: string[]) {
  symbols.forEach((s) => hub.counts.set(s, (hub.counts.get(s) ?? 0) + 1));
  rebuildSocket();
  return () => {
    symbols.forEach((s) => {
      const n = (hub.counts.get(s) ?? 1) - 1;
      if (n <= 0) hub.counts.delete(s);
      else hub.counts.set(s, n);
    });
    rebuildSocket();
  };
}

const subscribeHub = (l: () => void) => {
  hub.listeners.add(l);
  return () => hub.listeners.delete(l);
};
const getPrices = () => hub.prices;
const getStatus = () => hub.status;
const EMPTY: Prices = {};

/** Live last prices for the given symbols (plus any others already streaming). */
export function usePrices(symbols: string[]) {
  const key = [...new Set(symbols)].sort().join(",");
  useEffect(() => {
    if (!key) return;
    return retain(key.split(","));
  }, [key]);
  return useSyncExternalStore(subscribeHub, getPrices, () => EMPTY);
}

export function useTickerStatus() {
  return useSyncExternalStore(subscribeHub, getStatus, () => "connecting" as WsStatus);
}

/** Seeds a price immediately (e.g. from the last candle) before the ticker stream speaks. */
export function seedPrice(symbol: string, price: number) {
  if (hub.prices[symbol] != null) return;
  hub.pending[symbol] = price;
  scheduleFlush();
}

// ───────────────────────── Candles ─────────────────────────

interface KlineState {
  key: string;
  history: Candle[] | null;
  last: Candle | null;
  error: string | null;
}

/** REST history, then a live kline stream that updates/appends the latest bar. */
export function useKlines(symbol: string, interval: Interval) {
  const key = `${symbol}:${interval}`;
  const [state, setState] = useState<KlineState>({ key, history: null, last: null, error: null });
  const [status, setStatus] = useState<WsStatus>("connecting");

  useEffect(() => {
    const ctrl = new AbortController();
    let close: (() => void) | null = null;

    fetchKlines(symbol, interval, { limit: 500, signal: ctrl.signal })
      .then((history) => {
        setState({ key, history, last: history.at(-1) ?? null, error: null });
        const lastBar = history.at(-1);
        if (lastBar) seedPrice(symbol, lastBar.close);
        close = connectWs(
          `${BINANCE_WS}/ws/${symbol.toLowerCase()}@kline_${interval}`,
          (msg) => {
            const k = (msg as { k?: Parameters<typeof parseWsKline>[0] }).k;
            if (k) setState((s) => (s.key === key ? { ...s, last: parseWsKline(k) } : s));
          },
          setStatus,
        );
      })
      .catch((e: Error) => {
        if (e.name !== "AbortError") setState({ key, history: null, last: null, error: "Couldn't load chart data." });
      });

    return () => {
      ctrl.abort();
      close?.();
    };
  }, [symbol, interval, key]);

  const fresh = state.key === key;
  return {
    history: fresh ? state.history : null,
    last: fresh ? state.last : null,
    error: fresh ? state.error : null,
    status,
  };
}

// ───────────────────────── Symbol metadata ─────────────────────────

export function useSymbolInfo(symbol: string): SymbolInfo {
  const fallback = useMemo(() => fallbackInfo(symbol), [symbol]);
  const [info, setInfo] = useState<SymbolInfo | null>(null);
  useEffect(() => {
    let alive = true;
    getSymbolInfo(symbol)
      .then((i) => alive && setInfo(i))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [symbol]);
  return info?.symbol === symbol ? info : fallback;
}

/** Info for many symbols at once (for formatting lists). */
export function useSymbolInfos(symbols: string[]): Record<string, SymbolInfo> {
  const key = [...new Set(symbols)].sort().join(",");
  const [infos, setInfos] = useState<Record<string, SymbolInfo>>({});
  useEffect(() => {
    if (!key) return;
    let alive = true;
    Promise.all(key.split(",").map((s) => getSymbolInfo(s).catch(() => fallbackInfo(s)))).then((list) => {
      if (alive) setInfos((prev) => ({ ...prev, ...Object.fromEntries(list.map((i) => [i.symbol, i])) }));
    });
    return () => {
      alive = false;
    };
  }, [key]);
  return useMemo(() => {
    const out: Record<string, SymbolInfo> = {};
    symbols.forEach((s) => (out[s] = infos[s] ?? fallbackInfo(s)));
    return out;
  }, [infos, symbols]);
}
