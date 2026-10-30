// Backtests all 5 strategies × 6 timeframes on BTC/ETH/SOL with real Binance history.
// The "+ News" twins are skipped: there is no news history, so they would only repeat their originals.
//
//   npm run backtest                 # last 365 days, every signal traded (the raw strategies)
//   npm run backtest -- --days 180
//   npm run backtest -- --gate 65 --discipline    # as the live bots trade: confluence gate + cooldown + risk cut
//
// Needs internet access to data-api.binance.vision. Candles are cached in
// scripts/.cache so re-runs are fast. Writes docs/backtests/latest.md and .json.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { STRATEGIES } from "../supabase/functions/_shared/bot/strategies.ts";
import { backtest, type BtResult } from "../supabase/functions/_shared/bot/backtest.ts";
import { binanceMarket } from "../supabase/functions/_shared/bot/io.ts";
import { SYMBOLS, TF_SECONDS, TIMEFRAMES, type Candle } from "../supabase/functions/_shared/bot/types.ts";
import { align, history } from "./lib/history.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "docs", "backtests");

const argDays = process.argv.indexOf("--days");
const DAYS = argDays > 0 ? Number(process.argv[argDays + 1]) : 365;
const argGate = process.argv.indexOf("--gate");
const GATE = argGate > 0 ? Number(process.argv[argGate + 1]) : undefined;
const DISCIPLINE = process.argv.includes("--discipline");
const SETTINGS = { riskPct: 0.02, maxLeverage: 20, slots: SYMBOLS.length };
const START_BALANCE = 100;
const WARMUP_BARS = 600;

const pct = (n: number | null) => (n == null ? "—" : `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`);
const num = (n: number | null, d = 2) => (n == null ? "—" : n.toFixed(d));

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
    for (const strat of STRATEGIES.filter((s) => !s.newsAware)) {
      const t0 = Date.now();
      const r = backtest({ strategy: strat, timeframe: tf, candlesBySymbol: data, filters, settings: SETTINGS, startBalance: START_BALANCE, from: start, minConfluence: GATE, discipline: DISCIPLINE });
      results.push(r);
      console.log(`  ${strat.key.padEnd(11)} ${tf.padEnd(4)} ${pct(r.returnPct).padStart(9)}  ${String(r.trades).padStart(4)} trades  DD ${r.maxDrawdownPct.toFixed(1)}%  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    }
  }

  mkdirSync(OUT, { recursive: true });
  const ranked = [...results].sort((x, y) => y.returnPct - x.returnPct);
  const lines = [
    `# Backtest: ${DAYS} days to ${new Date(end * 1000).toISOString().slice(0, 10)}`,
    "",
    `$${START_BALANCE} per setup, ${SETTINGS.riskPct * 100}% risk per trade, max ${SETTINGS.maxLeverage}x, ${SYMBOLS.join(" / ")}. MEXC-style fees (taker 0.02%, maker 0%).`,
    GATE != null || DISCIPLINE ? `Entry rules: ${GATE != null ? `confluence gate ≥ ${GATE}/100` : "no confluence gate"}${DISCIPLINE ? ", cooldown after losses and smaller risk while the account is down" : ""}.` : "Entry rules: every signal is traded (no confluence gate, no discipline).",
    "Stops and targets are checked on each timeframe's own bars (stop first when a bar touches both). Entries fill at the next bar's open.",
    "",
    "| # | Strategy | TF | Return | Final | Trades | Win % | PF | Avg R | Max DD | +Months | Worst month | Liq |",
    "|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...ranked.map((r, i) =>
      `| ${i + 1} | ${r.strategy} | ${r.timeframe} | ${pct(r.returnPct)} | $${r.finalEquity.toFixed(2)} | ${r.trades} | ${num(r.winRate, 0)} | ${num(r.profitFactor)} | ${num(r.avgR)} | ${r.maxDrawdownPct.toFixed(1)}% | ${r.positiveMonths == null ? "—" : `${Math.round(r.positiveMonths * 100)}%`} | ${pct(r.worstMonthPct)} | ${r.liquidations}${r.busted ? " 💀" : ""} |`,
    ),
    "",
    "Past results don't predict future ones. A setup only counts as promising if it was profitable across most months, not because of one lucky streak.",
  ];
  writeFileSync(join(OUT, "latest.md"), lines.join("\n") + "\n");
  writeFileSync(
    join(OUT, "latest.json"),
    JSON.stringify({ days: DAYS, start, end, settings: SETTINGS, results: results.map((r) => ({ ...r, tradeList: undefined, equityCurve: undefined })) }, null, 2),
  );
  console.log(`\nWrote ${join("docs", "backtests", "latest.md")}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
