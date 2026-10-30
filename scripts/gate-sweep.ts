// Measures the entry gate (confluence score) and the discipline rules on real history, so the
// default threshold is chosen from data and checked on a period it was not chosen on.
//
//   node scripts/gate-sweep.ts                  # 365 days, split into an older and a newer half
//   node scripts/gate-sweep.ts --days 540
//
// Needs internet access to data-api.binance.vision. Candles are cached in scripts/.cache.

import { STRATEGIES } from "../supabase/functions/_shared/bot/strategies.ts";
import { backtest, type BtResult } from "../supabase/functions/_shared/bot/backtest.ts";
import { binanceMarket } from "../supabase/functions/_shared/bot/io.ts";
import { SYMBOLS, TF_SECONDS, TIMEFRAMES, type Candle, type Timeframe } from "../supabase/functions/_shared/bot/types.ts";
import { align, history } from "./lib/history.ts";

const argDays = process.argv.indexOf("--days");
const DAYS = argDays > 0 ? Number(process.argv[argDays + 1]) : 365;
const SETTINGS = { riskPct: 0.02, maxLeverage: 20, slots: SYMBOLS.length };
const START_BALANCE = 100;
const WARMUP_BARS = 600;

interface Variant {
  name: string;
  minConfluence?: number;
  discipline?: boolean;
}
const VARIANTS: Variant[] = [
  { name: "baseline (no gate)" },
  { name: "gate 50", minConfluence: 50 },
  { name: "gate 65", minConfluence: 65 },
  { name: "gate 75", minConfluence: 75 },
  { name: "gate 65 + discipline", minConfluence: 65, discipline: true },
  { name: "gate 75 + discipline", minConfluence: 75, discipline: true },
];

interface Agg {
  setups: number;
  trades: number;
  sumR: number;
  grossWin: number;
  grossLoss: number;
  profitable: number;
  busted: number;
  meanReturn: number;
}
const empty = (): Agg => ({ setups: 0, trades: 0, sumR: 0, grossWin: 0, grossLoss: 0, profitable: 0, busted: 0, meanReturn: 0 });
function add(a: Agg, r: BtResult) {
  a.setups++;
  a.trades += r.trades;
  for (const t of r.tradeList) {
    a.sumR += t.r;
    if (t.net > 0) a.grossWin += t.net;
    else a.grossLoss -= t.net;
  }
  if (r.returnPct > 0) a.profitable++;
  if (r.busted) a.busted++;
  a.meanReturn += r.returnPct;
}
const line = (name: string, a: Agg) =>
  `${name.padEnd(24)} ${String(a.trades).padStart(6)} trades  avgR ${(a.sumR / Math.max(a.trades, 1)).toFixed(3).padStart(7)}  PF ${(a.grossLoss ? a.grossWin / a.grossLoss : 0).toFixed(2)}  ` +
  `profitable ${String(a.profitable).padStart(2)}/${a.setups}  busted ${String(a.busted).padStart(2)}  mean return ${(a.meanReturn / Math.max(a.setups, 1)).toFixed(1).padStart(6)}%`;

async function main() {
  const end = Math.floor(Date.now() / 1000 / 86400) * 86400;
  const start = end - DAYS * 86400;
  const mid = start + Math.floor((DAYS * 86400) / 2);
  console.log(`Gate sweep ${new Date(start * 1000).toISOString().slice(0, 10)} → ${new Date(end * 1000).toISOString().slice(0, 10)}; older half to ${new Date(mid * 1000).toISOString().slice(0, 10)}`);
  const filters = await binanceMarket.symbolFilters(SYMBOLS);
  const windows = { older: new Map<string, Agg>(), newer: new Map<string, Agg>(), all: new Map<string, Agg>() };
  const byTf = new Map<string, Map<string, Agg>>();

  for (const tf of TIMEFRAMES) {
    const from = start - WARMUP_BARS * TF_SECONDS[tf as Timeframe];
    const bySym: Record<string, Candle[]> = {};
    for (const s of SYMBOLS) bySym[s] = await history(s, tf, from, end);
    const data = align(bySym);
    for (const strat of STRATEGIES.filter((s) => !s.newsAware)) {
      for (const v of VARIANTS) {
        const common = { strategy: strat, timeframe: tf, candlesBySymbol: data, filters, settings: SETTINGS, startBalance: START_BALANCE, minConfluence: v.minConfluence, discipline: v.discipline };
        const win = (m: Map<string, Agg>, r: BtResult) => add(m.get(v.name) ?? m.set(v.name, empty()).get(v.name)!, r);
        const first = backtest({ ...common, from: start });
        // The older half is judged on trades that closed before the midpoint; the newer half is a fresh run that starts there.
        const older = { ...first, tradeList: first.tradeList.filter((t) => t.exitTime < mid) };
        older.trades = older.tradeList.length;
        older.returnPct = older.tradeList.reduce((x, t) => x + t.net, 0) / START_BALANCE * 100;
        const newer = backtest({ ...common, from: mid });
        win(windows.all, first);
        win(windows.older, older as BtResult);
        win(windows.newer, newer);
        const m = byTf.get(tf) ?? new Map<string, Agg>();
        add(m.get(v.name) ?? m.set(v.name, empty()).get(v.name)!, first);
        byTf.set(tf, m);
      }
    }
    console.log(`  done ${tf}`);
  }

  for (const [title, m] of [["OLDER half (where a threshold is chosen)", windows.older], ["NEWER half (never used to choose)", windows.newer], ["WHOLE year", windows.all]] as const) {
    console.log(`\n${title}`);
    for (const v of VARIANTS) console.log("  " + line(v.name, m.get(v.name)!));
  }
  console.log("\nBy timeframe, whole year (baseline vs gate 65 + discipline)");
  for (const tf of TIMEFRAMES) {
    const m = byTf.get(tf)!;
    console.log("  " + tf.padEnd(4), line("baseline", m.get("baseline (no gate)")!).slice(25), "|", line("g65+disc", m.get("gate 65 + discipline")!).slice(25));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
