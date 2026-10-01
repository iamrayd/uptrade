import type { Candle } from "./types";

// Binance public market-data mirrors: no API key, CORS-enabled.
export const BINANCE_REST = "https://data-api.binance.vision/api/v3";
export const BINANCE_WS = "wss://data-stream.binance.vision";

export const INTERVALS = ["1m", "5m", "15m", "1h", "4h", "1d"] as const;
export type Interval = (typeof INTERVALS)[number];

export const INTERVAL_SECONDS: Record<Interval, number> = {
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "1h": 3600,
  "4h": 14400,
  "1d": 86400,
};

export const POPULAR_SYMBOLS = [
  "BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "DOGEUSDT", "ADAUSDT", "AVAXUSDT",
  "LINKUSDT", "DOTUSDT", "TRXUSDT", "LTCUSDT", "SUIUSDT", "NEARUSDT", "APTUSDT", "ATOMUSDT",
  "ARBUSDT", "OPUSDT", "INJUSDT", "PEPEUSDT", "SHIBUSDT", "TONUSDT", "UNIUSDT", "AAVEUSDT",
];

export const DEFAULT_SYMBOL = "BTCUSDT";
export const MARKET_COOKIE = "uptrade_market";

type RawKline = [number, string, string, string, string, string, ...unknown[]];

function parseKline(k: RawKline): Candle {
  return { time: Math.floor(k[0] / 1000), open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] };
}

export async function fetchKlines(
  symbol: string,
  interval: Interval,
  opts: { startTime?: number; limit?: number; signal?: AbortSignal } = {},
): Promise<Candle[]> {
  const params = new URLSearchParams({ symbol, interval, limit: String(opts.limit ?? 500) });
  if (opts.startTime) params.set("startTime", String(opts.startTime));
  const res = await fetch(`${BINANCE_REST}/klines?${params}`, { signal: opts.signal });
  if (!res.ok) throw new Error(`Binance klines ${res.status}`);
  return ((await res.json()) as RawKline[]).map(parseKline);
}

/**
 * Replays candles since `sinceIso` and returns the time (ISO) of the first one
 * matching `hit`, or null. One request: picks the finest interval (1m → 1h → 1d)
 * whose 1000 bars reach back far enough. Used for offline limit fills and liquidations.
 */
export async function findFirstCandle(symbol: string, sinceIso: string, hit: (c: Candle) => boolean) {
  const start = new Date(sinceIso).getTime();
  const ageMin = (Date.now() - start) / 60000;
  if (ageMin < 1) return null;
  const interval: Interval = ageMin <= 1000 ? "1m" : ageMin <= 1000 * 60 ? "1h" : "1d";
  const candles = await fetchKlines(symbol, interval, { startTime: start, limit: 1000 });
  const c = candles.find(hit);
  return c ? new Date(Math.max(c.time * 1000, start)).toISOString() : null;
}

export function parseWsKline(k: { t: number; o: string; h: string; l: string; c: string; v: string }): Candle {
  return { time: Math.floor(k.t / 1000), open: +k.o, high: +k.h, low: +k.l, close: +k.c, volume: +k.v };
}

// ── Symbol metadata (tick/step sizes for formatting and qty rounding) ──

export interface SymbolInfo {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  tickSize: number;
  stepSize: number;
  priceDecimals: number;
  qtyDecimals: number;
}

const symbolCache = new Map<string, SymbolInfo>();
let symbolsPromise: Promise<void> | null = null;

function decimalsOf(step: string) {
  const trimmed = step.replace(/0+$/, "");
  const dot = trimmed.indexOf(".");
  return dot === -1 ? 0 : trimmed.length - dot - 1;
}

interface RawSymbol {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  filters: { filterType: string; tickSize?: string; stepSize?: string }[];
}

function toInfo(s: RawSymbol): SymbolInfo {
  const price = s.filters.find((f) => f.filterType === "PRICE_FILTER");
  const lot = s.filters.find((f) => f.filterType === "LOT_SIZE");
  const tick = price?.tickSize ?? "0.01";
  const step = lot?.stepSize ?? "0.00001";
  return {
    symbol: s.symbol,
    baseAsset: s.baseAsset,
    quoteAsset: s.quoteAsset,
    tickSize: +tick,
    stepSize: +step,
    priceDecimals: decimalsOf(tick),
    qtyDecimals: decimalsOf(step),
  };
}

async function loadSymbols(symbols: string[]) {
  const res = await fetch(`${BINANCE_REST}/exchangeInfo?symbols=${encodeURIComponent(JSON.stringify(symbols))}`);
  if (!res.ok) throw new Error(`Binance exchangeInfo ${res.status}`);
  const data = (await res.json()) as { symbols: RawSymbol[] };
  data.symbols.forEach((s) => symbolCache.set(s.symbol, toInfo(s)));
}

export async function getSymbolInfo(symbol: string): Promise<SymbolInfo> {
  const cached = symbolCache.get(symbol);
  if (cached) return cached;
  if (POPULAR_SYMBOLS.includes(symbol)) {
    symbolsPromise ??= loadSymbols(POPULAR_SYMBOLS).catch((e) => {
      symbolsPromise = null;
      throw e;
    });
    await symbolsPromise;
  } else {
    await loadSymbols([symbol]);
  }
  const info = symbolCache.get(symbol);
  if (!info) throw new Error(`Unknown symbol ${symbol}`);
  return info;
}

export function fallbackInfo(symbol: string): SymbolInfo {
  const base = symbol.replace(/USDT$/, "");
  return { symbol, baseAsset: base, quoteAsset: "USDT", tickSize: 0.01, stepSize: 0.00001, priceDecimals: 2, qtyDecimals: 5 };
}

/** Checks a user-typed symbol exists and is trading against USDT. */
export async function lookupSymbol(raw: string): Promise<SymbolInfo | null> {
  const symbol = raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!symbol) return null;
  const full = symbol.endsWith("USDT") ? symbol : `${symbol}USDT`;
  try {
    return await getSymbolInfo(full);
  } catch {
    return null;
  }
}

export interface Ticker24h {
  symbol: string;
  lastPrice: number;
  changePct: number;
}

export async function fetch24h(symbols: string[]): Promise<Ticker24h[]> {
  const res = await fetch(`${BINANCE_REST}/ticker/24hr?type=MINI&symbols=${encodeURIComponent(JSON.stringify(symbols))}`);
  if (!res.ok) throw new Error(`Binance ticker ${res.status}`);
  const data = (await res.json()) as { symbol: string; lastPrice: string; openPrice: string }[];
  return data.map((t) => ({
    symbol: t.symbol,
    lastPrice: +t.lastPrice,
    changePct: +t.openPrice ? ((+t.lastPrice - +t.openPrice) / +t.openPrice) * 100 : 0,
  }));
}
