// Binance history for the backtest scripts, cached in scripts/.cache so re-runs are fast.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { binanceMarket } from "../../supabase/functions/_shared/bot/io.ts";
import { TF_SECONDS, type Candle, type Timeframe } from "../../supabase/functions/_shared/bot/types.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CACHE = join(ROOT, "scripts", ".cache");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function history(symbol: string, tf: Timeframe, fromSec: number, toSec: number): Promise<Candle[]> {
  mkdirSync(CACHE, { recursive: true });
  const file = join(CACHE, `${symbol}_${tf}_${fromSec}_${toSec}.json`);
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")) as Candle[];
  const out: Candle[] = [];
  let start = fromSec * 1000;
  while (start < toSec * 1000) {
    const page = await binanceMarket.klines(symbol, tf, { startTime: start, limit: 1000 });
    if (!page.length) break;
    for (const c of page) if (c.time < toSec && (!out.length || c.time > out[out.length - 1].time)) out.push(c);
    const next = page[page.length - 1].time * 1000 + TF_SECONDS[tf] * 1000;
    if (next <= start) break;
    start = next;
    await sleep(120);
  }
  writeFileSync(file, JSON.stringify(out));
  return out;
}

/** Keeps only timestamps every symbol has, so bars line up. */
export function align(bySym: Record<string, Candle[]>) {
  const sets = Object.values(bySym).map((l) => new Set(l.map((c) => c.time)));
  const common = (t: number) => sets.every((s) => s.has(t));
  return Object.fromEntries(Object.entries(bySym).map(([s, l]) => [s, l.filter((c) => common(c.time))]));
}
