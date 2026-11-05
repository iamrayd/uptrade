// Backtests every strategy × 6 timeframes on BTC/ETH/SOL with real Binance history.
// The "+ News" twins are skipped: there is no news history, so they would only repeat their originals.
//
//   npm run backtest                         # last 365 days, every signal traded, fees only (the raw strategies)
//   npm run backtest -- --days 180
//   npm run backtest -- --slip 0.05          # charge 0.05% slippage on every taker fill
//   npm run backtest -- --maker              # enter with a limit at the signal close (off live; bar-level fill, so optimistic)
//   npm run backtest -- --gate 65 --slip 0.05 --discipline    # as the live bots trade
//
// The report keeps two things apart:
//   - R columns (trades, win %, avg R, total R) are the STRATEGY: always without discipline, so
//     strategies are compared on their own rules.
//   - $ columns (net $, return, drawdown, months) are the ACCOUNT: with --discipline they include the
//     cooldowns and risk cuts of the setup's timeframe; without it they are the same run as the R columns.
//
// Needs internet access to data-api.binance.vision. Candles are cached in
// scripts/.cache so re-runs are fast. Writes docs/backtests/latest.md and .json.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { STRATEGIES } from "../supabase/functions/_shared/bot/strategies.ts";
import { backtest, type BtResult } from "../supabase/functions/_shared/bot/backtest.ts";
import { binanceMarket } from "../supabase/functions/_shared/bot/io.ts";
import { isRetired } from "../supabase/functions/_shared/bot/tuning.ts";
import { SYMBOLS, TF_SECONDS, TIMEFRAMES, type Candle } from "../supabase/functions/_shared/bot/types.ts";
import { align, history } from "./lib/history.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "docs", "backtests");

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? Number(process.argv[i + 1]) : undefined;
};
const DAYS = arg("--days") ?? 365;
const GATE = arg("--gate");
/** Slippage per taker fill, given in percent on the command line (0.05 = 0.05%). */
const SLIP = (arg("--slip") ?? 0) / 100;
const MAKER = process.argv.includes("--maker");
const DISCIPLINE = process.argv.includes("--discipline");
const SETTINGS = { riskPct: 0.02, maxLeverage: 20, slots: SYMBOLS.length };
const START_BALANCE = 100;
const WARMUP_BARS = 600;
if (![DAYS, SLIP].every(Number.isFinite) || (GATE != null && !Number.isFinite(GATE))) throw new Error("--days, --gate and --slip need a number");

const pct = (n: number | null) => (n == null ? "—" : `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`);
const num = (n: number | null, d = 2) => (n == null ? "—" : n.toFixed(d));
const signed = (n: number | null, d = 2) => (n == null ? "—" : `${n >= 0 ? "+" : ""}${n.toFixed(d)}`);

async function main() {
  // Align "now" to the last closed daily bar so every timeframe ends at the same instant.
  const end = Math.floor(Date.now() / 1000 / 86400) * 86400;
  const start = end - DAYS * 86400;
  console.log(`Backtest ${new Date(start * 1000).toISOString().slice(0, 10)} → ${new Date(end * 1000).toISOString().slice(0, 10)} (${DAYS} days)`);

  const filters = await binanceMarket.symbolFilters(SYMBOLS);
  /** Per setup: the raw strategy run (R) and the account run ($). They are the same run without --discipline. */
  const results: { raw: BtResult; account: BtResult }[] = [];

  for (const tf of TIMEFRAMES) {
    const from = start - WARMUP_BARS * TF_SECONDS[tf];
    const bySym: Record<string, Candle[]> = {};
    for (const s of SYMBOLS) {
      process.stdout.write(`  fetching ${s} ${tf}… `);
      bySym[s] = await history(s, tf, from, end);
      console.log(bySym[s].length);
    }
    const data = align(bySym);
    for (const strat of STRATEGIES.filter((s) => !s.newsAware && !s.pool)) {
      const t0 = Date.now();
      const run = (discipline: boolean) =>
        backtest({ strategy: strat, timeframe: tf, candlesBySymbol: data, filters, settings: SETTINGS, startBalance: START_BALANCE, from: start, minConfluence: GATE, discipline, slippage: SLIP, makerEntry: MAKER });
      const raw = run(false);
      const account = DISCIPLINE ? run(true) : raw;
      results.push({ raw, account });
      console.log(`  ${strat.key.padEnd(13)} ${tf.padEnd(4)} avg R ${signed(raw.avgR, 3).padStart(7)}  ${String(raw.trades).padStart(4)} trades  $ ${signed(account.netUsd).padStart(8)}  DD ${account.maxDrawdownPct.toFixed(1)}%  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    }
  }

  mkdirSync(OUT, { recursive: true });
  const ranked = [...results].sort((x, y) => y.raw.totalR - x.raw.totalR);
  const lines = [
    `# Backtest: ${DAYS} days to ${new Date(end * 1000).toISOString().slice(0, 10)}`,
    "",
    `$${START_BALANCE} per setup, ${SETTINGS.riskPct * 100}% risk per trade, max ${SETTINGS.maxLeverage}x, ${SYMBOLS.join(" / ")}. MEXC-style fees (taker 0.02%, maker 0%).`,
    `Costs: ${SLIP ? `${(SLIP * 100).toFixed(3)}% slippage on every taker fill` : "no slippage (paper fills)"}; entries are ${MAKER ? "limit orders at the signal close (maker fee, no slippage; no trade when the next bar does not trade through the limit)" : "market orders at the next bar's open (taker)"}.`,
    `Entry rules: ${GATE != null ? `confluence gate ≥ ${GATE}/100` : "every signal is traded (no confluence gate)"}.`,
    "Stops and targets are checked on each timeframe's own bars (stop first when a bar touches both).",
    "",
    "**R columns are the strategy** (R = net PnL ÷ the risk planned for that trade; no cooldowns, no risk cuts), ranked by total R.",
    `**$ columns are the account**${DISCIPLINE ? ", with the live discipline of its timeframe (cooldown after losses and smaller risk while the account is down; none on 1d)" : " of the same run (no discipline)"}.`,
    "† = retired: the live bot gives this setup no capital (shadow-only).",
    "",
    "| # | Strategy | TF | Trades | Win % | Avg R | Total R | PF | Net $ | Return | Max DD | +Months | Worst month | Liq |",
    "|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...ranked.map(({ raw: r, account: a }, i) =>
      `| ${i + 1} | ${r.strategy}${isRetired(r.strategy, r.timeframe) ? " †" : ""} | ${r.timeframe} | ${r.trades} | ${num(r.winRate, 0)} | ${signed(r.avgR, 3)} | ${signed(r.totalR, 1)} | ${num(r.profitFactor)} | ${signed(a.netUsd)} | ${pct(a.returnPct)} | ${a.maxDrawdownPct.toFixed(1)}% | ${a.positiveMonths == null ? "—" : `${Math.round(a.positiveMonths * 100)}%`} | ${pct(a.worstMonthPct)} | ${a.liquidations}${a.busted ? " 💀" : ""} |`,
    ),
    "",
    "Past results don't predict future ones. A setup only counts as promising if it was profitable across most months, not because of one lucky streak.",
  ];
  writeFileSync(join(OUT, "latest.md"), lines.join("\n") + "\n");
  const slim = (r: BtResult) => ({ ...r, tradeList: undefined, equityCurve: undefined });
  writeFileSync(
    join(OUT, "latest.json"),
    JSON.stringify({ days: DAYS, start, end, settings: SETTINGS, gate: GATE ?? null, slippage: SLIP, makerEntry: MAKER, discipline: DISCIPLINE, results: results.map(({ raw, account }) => ({ raw: slim(raw), account: slim(account) })) }, null, 2),
  );
  console.log(`\nWrote ${join("docs", "backtests", "latest.md")}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
