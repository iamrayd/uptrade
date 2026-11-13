// Backtests the five live rule sets on 15m, 1h and 4h for BTC/ETH/SOL with real Binance history.
// Every signal is traded, exactly as the live bots do.
//
//   npm run backtest                         # last 365 days, fees only (what the paper accounts charge)
//   npm run backtest -- --days 180
//   npm run backtest -- --slip 0.05          # also charge 0.05% slippage on every taker fill
//   npm run backtest -- --all                # all ten candidate rule sets, not only the live five
//
// Needs internet access to data-api.binance.vision. Candles are cached in
// scripts/.cache so re-runs are fast. Writes docs/backtests/latest.md and .json.
// For the fixed-period run the selection was made on, see scripts/experiments/v3-select.ts.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CANDIDATES, STRATEGIES } from "../supabase/functions/_shared/bot/strategies.ts";
import { backtest, type BtResult } from "../supabase/functions/_shared/bot/backtest.ts";
import { binanceMarket } from "../supabase/functions/_shared/bot/io.ts";
import { SYMBOLS, TF_SECONDS, TIMEFRAMES, type Candle } from "../supabase/functions/_shared/bot/types.ts";
import { align, history } from "./lib/history.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "docs", "backtests");

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? Number(process.argv[i + 1]) : undefined;
};
const DAYS = arg("--days") ?? 365;
/** Slippage per taker fill, given in percent on the command line (0.05 = 0.05%). */
const SLIP = (arg("--slip") ?? 0) / 100;
const LIST = process.argv.includes("--all") ? CANDIDATES : STRATEGIES;
const SETTINGS = { riskPct: 0.02, maxLeverage: 20, slots: SYMBOLS.length };
const START_BALANCE = 100;
const WARMUP_BARS = 600;
if (![DAYS, SLIP].every(Number.isFinite)) throw new Error("--days and --slip need a number");

const pct = (n: number | null) => (n == null ? "—" : `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`);
const num = (n: number | null, d = 2) => (n == null ? "—" : n.toFixed(d));
const signed = (n: number | null, d = 2) => (n == null ? "—" : `${n >= 0 ? "+" : ""}${n.toFixed(d)}`);

async function main() {
  // Align "now" to the last closed daily bar so every timeframe ends at the same instant.
  const end = Math.floor(Date.now() / 1000 / 86400) * 86400;
  const start = end - DAYS * 86400;
  console.log(`Backtest ${new Date(start * 1000).toISOString().slice(0, 10)} → ${new Date(end * 1000).toISOString().slice(0, 10)} (${DAYS} days)`);

  const filters = await binanceMarket.symbolFilters(SYMBOLS);
  const results: BtResult[] = [];

  for (const tf of TIMEFRAMES) {
    const from = start - WARMUP_BARS * TF_SECONDS[tf];
    const bySym: Record<string, Candle[]> = {};
    for (const s of SYMBOLS) {
      process.stdout.write(`  fetching ${s} ${tf}… `);
      bySym[s] = await history(s, tf, from, end);
      console.log(bySym[s].length);
    }
    const data = align(bySym);
    for (const strat of LIST) {
      const t0 = Date.now();
      const r = backtest({ strategy: strat, timeframe: tf, candlesBySymbol: data, filters, settings: SETTINGS, startBalance: START_BALANCE, from: start, slippage: SLIP });
      results.push(r);
      console.log(`  ${strat.key.padEnd(18)} ${tf.padEnd(4)} avg R ${signed(r.avgR, 3).padStart(7)}  ${String(r.trades).padStart(4)} trades  $ ${signed(r.netUsd).padStart(8)}  DD ${r.maxDrawdownPct.toFixed(1)}%  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    }
  }

  mkdirSync(OUT, { recursive: true });
  const ranked = [...results].sort((x, y) => (y.avgR ?? -Infinity) - (x.avgR ?? -Infinity));
  const lines = [
    `# Backtest: ${DAYS} days to ${new Date(end * 1000).toISOString().slice(0, 10)}`,
    "",
    `$${START_BALANCE} per setup, ${SETTINGS.riskPct * 100}% risk per trade, max ${SETTINGS.maxLeverage}x, ${SYMBOLS.join(" / ")}. Fees: taker 0.02%, maker 0%.`,
    `Costs: ${SLIP ? `${(SLIP * 100).toFixed(3)}% slippage on every taker fill` : "no slippage (paper fills)"}. Entries are market orders at the next bar's open. Every signal is traded.`,
    "Stops and targets are checked on each timeframe's own bars (stop first when a bar touches both).",
    "",
    "R = net PnL ÷ the risk planned for that trade. Ranked by average R. A busted account (💀) stops trading, so its trade count covers only part of the period.",
    "",
    "| # | Strategy | TF | Trades | Win % | Avg R | Total R | PF | Net $ | Return | Max DD | +Months | Worst month | Liq |",
    "|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...ranked.map(
      (r, i) =>
        `| ${i + 1} | ${r.strategy} | ${r.timeframe} | ${r.trades} | ${num(r.winRate, 0)} | ${signed(r.avgR, 3)} | ${signed(r.totalR, 1)} | ${num(r.profitFactor)} | ${signed(r.netUsd)} | ${pct(r.returnPct)} | ${r.maxDrawdownPct.toFixed(1)}% | ${r.positiveMonths == null ? "—" : `${Math.round(r.positiveMonths * 100)}%`} | ${pct(r.worstMonthPct)} | ${r.liquidations}${r.busted ? " 💀" : ""} |`,
    ),
    "",
    "Past results don't predict future ones. A setup only counts as promising if it was profitable across most months, not because of one lucky streak.",
  ];
  writeFileSync(join(OUT, "latest.md"), lines.join("\n") + "\n");
  writeFileSync(join(OUT, "latest.json"), JSON.stringify({ days: DAYS, start, end, settings: SETTINGS, slippage: SLIP, results: results.map((r) => ({ ...r, tradeList: undefined, equityCurve: undefined })) }, null, 2));
  console.log(`\nWrote ${join("docs", "backtests", "latest.md")}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
