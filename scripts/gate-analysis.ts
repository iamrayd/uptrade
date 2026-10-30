// Which confirming checks actually predict a trade's outcome? Runs every raw strategy over a year of
// real history with no gate, records the confluence reading of each trade, and reports average R by
// score bucket and by check, split into an older and a newer half so a pattern that only held in one
// half is visible. Use it to decide the checks' weights and the gate threshold from data, not taste.
//
//   node scripts/gate-analysis.ts            # 365 days
//   node scripts/gate-analysis.ts --days 540
//
// Needs internet access to data-api.binance.vision. Candles are cached in scripts/.cache.

import { STRATEGIES } from "../supabase/functions/_shared/bot/strategies.ts";
import { backtest, type BtTrade } from "../supabase/functions/_shared/bot/backtest.ts";
import { binanceMarket } from "../supabase/functions/_shared/bot/io.ts";
import { SYMBOLS, TF_SECONDS, TIMEFRAMES, type Candle } from "../supabase/functions/_shared/bot/types.ts";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { align, history } from "./lib/history.ts";

const argDays = process.argv.indexOf("--days");
const DAYS = argDays > 0 ? Number(process.argv[argDays + 1]) : 365;
const SETTINGS = { riskPct: 0.02, maxLeverage: 20, slots: SYMBOLS.length };
const WARMUP_BARS = 600;

type Row = BtTrade & { strategy: string; timeframe: string };

const avg = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN);
const f = (n: number, d = 3) => (Number.isFinite(n) ? (n >= 0 ? "+" : "") + n.toFixed(d) : "  n/a");
function pf(xs: number[]) {
  const w = xs.filter((x) => x > 0).reduce((s, x) => s + x, 0);
  const l = -xs.filter((x) => x <= 0).reduce((s, x) => s + x, 0);
  return l ? w / l : NaN;
}
const line = (name: string, rows: Row[]) => `${name.padEnd(28)} n=${String(rows.length).padStart(6)}  avgR ${f(avg(rows.map((r) => r.r)))}  PF ${Number.isFinite(pf(rows.map((r) => r.r))) ? pf(rows.map((r) => r.r)).toFixed(2) : " n/a"}  win ${Number.isFinite(avg(rows.map((r) => (r.net > 0 ? 1 : 0)))) ? (avg(rows.map((r) => (r.net > 0 ? 100 : 0)))).toFixed(0) : "n/a"}%`;

async function main() {
  const end = Math.floor(Date.now() / 1000 / 86400) * 86400;
  const start = end - DAYS * 86400;
  const mid = start + Math.floor((DAYS * 86400) / 2);
  const filters = await binanceMarket.symbolFilters(SYMBOLS);
  let rows: Row[] = [];
  const dump = `scripts/.cache/gate-rows-${DAYS}d.json`;
  if (existsSync(dump)) rows = JSON.parse(readFileSync(dump, "utf8"));
  else for (const tf of TIMEFRAMES) {
    const from = start - WARMUP_BARS * TF_SECONDS[tf];
    const bySym: Record<string, Candle[]> = {};
    for (const s of SYMBOLS) bySym[s] = await history(s, tf, from, end);
    const data = align(bySym);
    for (const strat of STRATEGIES.filter((s) => !s.newsAware)) {
      const r = backtest({ strategy: strat, timeframe: tf, candlesBySymbol: data, filters, settings: SETTINGS, startBalance: 100, from: start, trackConfluence: true });
      for (const t of r.tradeList) if (t.cf) rows.push({ ...t, strategy: strat.key, timeframe: tf });
    }
    console.log(`  done ${tf}: ${rows.length} trades so far`);
  }
  if (!existsSync(dump)) writeFileSync(dump, JSON.stringify(rows));

  const groups: [string, (r: Row) => boolean][] = [
    ["all", () => true],
    ["5m-30m", (r) => ["5m", "15m", "30m"].includes(r.timeframe)],
    ["1h-1d", (r) => ["1h", "4h", "1d"].includes(r.timeframe)],
    ["trend strategies", (r) => r.strategy !== "bb_rsi"],
    ["bb_rsi (fade)", (r) => r.strategy === "bb_rsi"],
  ];
  const halves: [string, (r: Row) => boolean][] = [
    ["older", (r) => r.exitTime < mid],
    ["newer", (r) => r.exitTime >= mid],
  ];

  for (const [gname, g] of groups) {
    const pool = rows.filter(g);
    console.log(`\n=== ${gname} (${pool.length} trades) ===`);
    console.log("-- by confluence score");
    for (const [lo, hi] of [[0, 40], [40, 55], [55, 65], [65, 75], [75, 85], [85, 101]]) {
      const b = pool.filter((r) => r.cf!.score >= lo && r.cf!.score < hi);
      console.log("  " + line(`score ${lo}-${hi - 1}`, b) + "   | " + halves.map(([n, h]) => `${n} ${f(avg(b.filter(h).map((r) => r.r)))} (${b.filter(h).length})`).join("  "));
    }
    console.log("-- by check (pass vs fail)");
    const keys = [...new Set(pool.flatMap((r) => Object.keys(r.cf!.checks)))].sort();
    for (const k of keys) {
      const has = pool.filter((r) => k in r.cf!.checks);
      const pass = has.filter((r) => r.cf!.checks[k]);
      const fail = has.filter((r) => !r.cf!.checks[k]);
      if (pass.length < 30 || fail.length < 30) continue;
      const d = (h: (r: Row) => boolean) => avg(pass.filter(h).map((r) => r.r)) - avg(fail.filter(h).map((r) => r.r));
      console.log(
        `  ${k.padEnd(14)} pass ${f(avg(pass.map((r) => r.r)))} (${String(pass.length).padStart(5)})  fail ${f(avg(fail.map((r) => r.r)))} (${String(fail.length).padStart(5)})  lift ${f(avg(pass.map((r) => r.r)) - avg(fail.map((r) => r.r)))}   older ${f(d(halves[0][1]))}  newer ${f(d(halves[1][1]))}`,
      );
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
