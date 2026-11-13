// Strategy v3 selection on the cached 365-day history (end 2026-10-29). docs/strategies/V3.md.
//
//   node --experimental-strip-types scripts/experiments/v3-select.ts
//
// Every candidate rule set is replayed on 15m, 1h and 4h for BTC, ETH and SOL: every signal
// traded, taker fees plus 0.05% slippage per taker fill. Runs offline from scripts/.cache (the
// candles are fetched and cached on the first run).
//
// Each setup is run twice. The R columns (trades, win %, avg R, halves) come from a run at 0.3%
// risk on $1000, which cannot bust, so they cover the whole year and measure the rules, not the
// sizing. The account columns (return, drawdown, busted) come from the account as it trades
// live: $100, 2% risk, 20x max leverage.
//
// Trades are split by ENTRY time into the older and the newer half of the year, so a rule set
// that only worked in one half is visible. "Paper avgR" is the same run without slippage: the
// paper accounts charge fees but fill at the quoted price, so that is what they will show.
//
// Fair Value Gap and Order Block trade whatever they score (the owner's choice). The other three
// places go to the best total return over the three timeframes, among rule sets with at least
// MIN_TRADES trades in the year.
import { writeFileSync } from "node:fs";
import { CANDIDATES, STRATEGIES } from "../../supabase/functions/_shared/bot/strategies.ts";
import { backtest, type BtResult } from "../../supabase/functions/_shared/bot/backtest.ts";
import { SYMBOLS, TF_SECONDS, TIMEFRAMES, type Candle } from "../../supabase/functions/_shared/bot/types.ts";
import { align, history } from "../lib/history.ts";

const END = 1793232000;
const DAYS = 365;
const START = END - DAYS * 86400;
const MID = START + (DAYS * 86400) / 2;
const WARMUP = 600;
const SLIP = 0.0005;
const MIN_TRADES = 100;
const MANDATORY = ["fvg", "order_block"];
const FILTERS = { BTCUSDT: { step: 0.00001, tick: 0.01 }, ETHUSDT: { step: 0.0001, tick: 0.01 }, SOLUSDT: { step: 0.001, tick: 0.01 } };

const data: Record<string, Record<string, Candle[]>> = {};
for (const tf of TIMEFRAMES) {
  const by: Record<string, Candle[]> = {};
  for (const s of SYMBOLS) by[s] = await history(s, tf, START - WARMUP * TF_SECONDS[tf], END);
  data[tf] = align(by);
}

const lines: string[] = [];
const out = (s = "") => {
  lines.push(s);
  console.log(s);
};
const f = (n: number | null, d = 2, sign = false) => (n == null ? "-" : `${sign && n >= 0 ? "+" : ""}${n.toFixed(d)}`);
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

const run = (st: (typeof CANDIDATES)[number], tf: (typeof TIMEFRAMES)[number], account: boolean, slippage = SLIP) =>
  backtest({ strategy: st, timeframe: tf, candlesBySymbol: data[tf], filters: FILTERS, settings: { riskPct: account ? 0.02 : 0.003, maxLeverage: 20, slots: 3 }, startBalance: account ? 100 : 1000, from: START, slippage });

const results: (BtResult & { acct: BtResult; paperAvgR: number | null })[] = [];
out(`Strategy v3 candidates: ${DAYS} days to ${new Date(END * 1000).toISOString().slice(0, 10)}, ${SYMBOLS.join("/")}, every signal traded.`);
out(`Taker fee 0.02%, slippage ${(SLIP * 100).toFixed(2)}% per taker fill. Account columns: $100 start, 2% risk, 20x max leverage.`);
out();
out("strategy            tf   trades  win%   avgR  totalR  older avgR (n)  newer avgR (n)  paper avgR | return%  maxDD%");
for (const st of CANDIDATES) {
  for (const tf of TIMEFRAMES) {
    const r = run(st, tf, false);
    const acct = run(st, tf, true);
    const paperAvgR = run(st, tf, false, 0).avgR;
    results.push({ ...r, acct, paperAvgR });
    const older = r.tradeList.filter((t) => t.entryTime < MID).map((t) => t.r);
    const newer = r.tradeList.filter((t) => t.entryTime >= MID).map((t) => t.r);
    out(
      `${st.key.padEnd(19)} ${tf.padEnd(4)} ${String(r.trades).padStart(6)} ${f(r.winRate, 1).padStart(5)} ${f(r.avgR, 3, true).padStart(6)} ${f(r.totalR, 1, true).padStart(7)}  ${`${f(avg(older), 3, true)} (${older.length})`.padStart(14)}  ${`${f(avg(newer), 3, true)} (${newer.length})`.padStart(14)}  ${f(paperAvgR, 3, true).padStart(10)} | ${f(acct.returnPct, 1, true).padStart(7)} ${f(acct.maxDrawdownPct, 1).padStart(7)}${acct.busted ? "  BUSTED" : ""}`,
    );
  }
}

out();
out("Per rule set, the three timeframes together (three $100 accounts):");
out("strategy             trades  win%   avgR  totalR  paper avgR | return%  net $");
const totals = CANDIDATES.map((st) => {
  const rs = results.filter((r) => r.strategy === st.key);
  const trades = rs.flatMap((r) => r.tradeList);
  const net = rs.reduce((s, r) => s + r.acct.netUsd, 0);
  const paper = rs.reduce((s, r) => s + (r.paperAvgR ?? 0) * r.trades, 0) / Math.max(1, trades.length);
  return { key: st.key, paper, trades: trades.length, win: trades.length ? (trades.filter((t) => t.net > 0).length / trades.length) * 100 : null, avgR: avg(trades.map((t) => t.r)), totalR: trades.reduce((s, t) => s + t.r, 0), ret: (net / (100 * rs.length)) * 100, net };
}).sort((a, b) => b.ret - a.ret);
for (const t of totals)
  out(`${t.key.padEnd(19)} ${String(t.trades).padStart(7)} ${f(t.win, 1).padStart(5)} ${f(t.avgR, 3, true).padStart(6)} ${f(t.totalR, 1, true).padStart(7)} ${f(t.paper, 3, true).padStart(11)} | ${f(t.ret, 1, true).padStart(7)} ${f(t.net, 2, true).padStart(7)}${MANDATORY.includes(t.key) ? "  (mandatory)" : t.trades < MIN_TRADES ? `  (under ${MIN_TRADES} trades)` : ""}`);

const picked = [...MANDATORY, ...totals.filter((t) => !MANDATORY.includes(t.key) && t.trades >= MIN_TRADES).slice(0, 5 - MANDATORY.length).map((t) => t.key)];
out();
out(`Selected: ${picked.join(", ")}`);
const live = STRATEGIES.map((s) => s.key);
out(`STRATEGIES in strategies.ts: ${live.join(", ")}${picked.every((k) => live.includes(k)) && live.length === picked.length ? " (matches)" : " (DOES NOT MATCH the selection)"}`);
const book = totals.filter((t) => picked.includes(t.key));
out(`The five together (15 accounts, $1500): ${book.reduce((s, t) => s + t.trades, 0)} trades in the year (${(book.reduce((s, t) => s + t.trades, 0) / DAYS).toFixed(1)} a day), net ${f(book.reduce((s, t) => s + t.net, 0), 2, true)} $.`);

writeFileSync(new URL("./v3-select.out.txt", import.meta.url), lines.join("\n") + "\n");
