// Replays the aggressive accounts (aggro.ts) over the cached year, with the playbook learning as
// it goes, and writes the playbook they end with as the seed the live accounts start from.
//
//   node --experimental-strip-types scripts/experiments/aggro-replay.ts            # report only
//   node --experimental-strip-types scripts/experiments/aggro-replay.ts --seed     # also write aggro-seed.ts
//
// Reads the candles in scripts/.cache (the year ending at END). Slippage 0.05% per taker fill.

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { aggroReplay } from "../../supabase/functions/_shared/bot/aggro.ts";
import { AGGRO, calibrate, cellLabel } from "../../supabase/functions/_shared/bot/playbook.ts";
import { STRATEGY_BY_KEY } from "../../supabase/functions/_shared/bot/strategies.ts";
import { SYMBOLS, TF_SECONDS, type Candle, type Timeframe } from "../../supabase/functions/_shared/bot/types.ts";
import { align, history } from "../lib/history.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const END = 1793232000;
const START = END - 365 * 86400;
const WARMUP_BARS = 600;
const SLIP = 0.0005;
/** Fixed, so the replay (and the seed it writes) does not depend on a network call. */
const FILTERS: Record<string, { step: number; tick: number }> = { BTCUSDT: { step: 0.00001, tick: 0.01 }, ETHUSDT: { step: 0.0001, tick: 0.01 }, SOLUSDT: { step: 0.001, tick: 0.01 } };

const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
const sR = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(3)}R`;
const pct = (n: number) => `${n >= 0 ? "+" : ""}${(n * 100).toFixed(1)}%`;

const seed: Record<string, { cells: Record<string, [number, number]>; cal: Record<string, number> }> = {};

for (const tf of STRATEGY_BY_KEY.aggro.timeframes as Timeframe[]) {
  const bySym: Record<string, Candle[]> = {};
  for (const s of SYMBOLS) bySym[s] = await history(s, tf, START - WARMUP_BARS * TF_SECONDS[tf], END);
  const t0 = Date.now();
  const res = aggroReplay({ timeframe: tf, candlesBySymbol: align(bySym), filters: FILTERS, from: START, startBalance: 100, maxLeverage: 20, slippage: SLIP });
  seed[tf] = { cells: res.playbook.cells, cal: res.playbook.cal };

  console.log(`\n══ Aggressive ${tf}: 365 days to ${new Date(END * 1000).toISOString().slice(0, 10)}, slippage ${SLIP * 100}% per taker fill (${((Date.now() - t0) / 1000).toFixed(0)}s) ══`);
  const all = res.signals;
  const traded = res.trades;
  console.log(`Signals seen: ${all.length}, on their own ${sR(mean(all.map((s) => s.r)))} each. Trades taken: ${traded.length} (${((traded.length / Math.max(1, all.length)) * 100).toFixed(0)}% of signals), ${sR(mean(traded.map((t) => t.r)))} each, win rate ${((traded.filter((t) => t.net > 0).length / Math.max(1, traded.length)) * 100).toFixed(0)}%.`);
  console.log(`Average risk taken per trade: ${(mean(traded.map((t) => t.riskPct)) * 100).toFixed(1)}% of equity.`);

  for (const [name, lo, hi] of [["older half", START, START + 182.5 * 86400], ["newer half", START + 182.5 * 86400, END]] as const) {
    const tr = traded.filter((t) => t.entryTime >= lo && t.entryTime < hi);
    const sg = all.filter((s) => s.time >= lo && s.time < hi);
    console.log(`  ${name}: traded ${sR(mean(tr.map((t) => t.r)))} over ${tr.length}; all signals ${sR(mean(sg.map((s) => s.r)))} over ${sg.length}`);
  }

  console.log(`Calibration at the end: slope ${calibrate(res.playbook, 1).slope.toFixed(2)} over ${Math.round(res.playbook.cal.n)} checked signals (below 0: a good record has been followed by worse results).`);
  console.log("Does the playbook's estimate sort signals? (all signals, by the calibrated estimate at the time)");
  for (const [label, lo, hi] of [["exp < −0.10", -Infinity, -0.1], ["−0.10 … 0", -0.1, 0], ["0 … +0.05", 0, 0.05], ["+0.05 … +0.15", 0.05, 0.15], ["≥ +0.15", 0.15, Infinity]] as const) {
    const g = all.filter((s) => s.exp >= lo && s.exp < hi);
    console.log(`  ${label.padEnd(14)} ${String(g.length).padStart(5)} signals, realized ${g.length ? sR(mean(g.map((s) => s.r))) : "—"}`);
  }

  const busted = res.lives.filter((l) => l.cause === "busted");
  console.log(`Lives: ${res.livesUsed} started, ${busted.length} busted. The one running at the end holds $${res.finalEquity.toFixed(2)}.`);
  const lens = busted.map((l) => (+new Date(l.ended_at) - +new Date(l.started_at!)) / 86_400_000).sort((x, y) => x - y);
  if (lens.length) console.log(`  A busted life lasted ${lens[Math.floor(lens.length / 2)].toFixed(1)} days at the median (shortest ${lens[0].toFixed(1)}, longest ${lens[lens.length - 1].toFixed(1)}); peaks: ${busted.map((l) => `$${l.peak.toFixed(0)}`).join(", ")}.`);
  console.log(`  Dollars: ${res.livesUsed} × $100 put in, $${res.finalEquity.toFixed(2)} left: net ${(res.finalEquity - res.livesUsed * 100).toFixed(2)}.`);

  const rets = res.days.map((d) => d.ret);
  const sorted = [...rets].sort((x, y) => x - y);
  console.log(`Days: ${rets.length}. Average day ${pct(mean(rets))}, median ${pct(sorted[Math.floor(sorted.length / 2)] ?? 0)}, best ${pct(sorted[sorted.length - 1] ?? 0)}, worst ${pct(sorted[0] ?? 0)}.`);
  console.log(`  Days at or above +${AGGRO.dayTarget * 100}%: ${rets.filter((r) => r >= AGGRO.dayTarget).length}. Days up: ${rets.filter((r) => r >= 1e-6).length}, down: ${rets.filter((r) => r <= -1e-6).length}, flat: ${rets.filter((r) => Math.abs(r) < 1e-6).length}.`);

  const bySrc = new Map<string, number[]>();
  for (const t of traded) bySrc.set(t.src, [...(bySrc.get(t.src) ?? []), t.r]);
  console.log(`Trades by rule set: ${[...bySrc].map(([k, rs]) => `${k} ${rs.length} (${sR(mean(rs))})`).join(", ")}`);
  const cells = Object.entries(res.playbook.cells).filter(([k, [n]]) => k.includes("|") && n >= 30).map(([k, [n, s]]) => ({ k, n, avg: s / (n + AGGRO.prior) })).sort((x, y) => y.avg - x.avg);
  console.log(`Best contexts at the end:  ${cells.slice(0, 5).map((c) => `${cellLabel(c.k)} ${sR(c.avg)} (${Math.round(c.n)})`).join(" | ")}`);
  console.log(`Worst contexts at the end: ${cells.slice(-5).reverse().map((c) => `${cellLabel(c.k)} ${sR(c.avg)} (${Math.round(c.n)})`).join(" | ")}`);
}

if (process.argv.includes("--seed")) {
  const NL = "\n";
  const body = Object.entries(seed)
    .map(([tf, { cells, cal }]) => {
      const rows = Object.entries(cells).sort(([x], [y]) => x.localeCompare(y)).map(([k, [n, sum]]) => `      ${JSON.stringify(k)}: [${+n.toFixed(2)}, ${+sum.toFixed(2)}],`);
      return [`  "${tf}": {`, `    cal: ${JSON.stringify(cal)},`, "    cells: {", ...rows, "    },", "  },"].join(NL);
    })
    .join(NL);
  const file = join(ROOT, "supabase", "functions", "_shared", "bot", "aggro-seed.ts");
  const lines = [
    "// Generated by scripts/experiments/aggro-replay.ts --seed. Don't edit by hand.",
    "//",
    "// What the aggressive accounts know before their first live trade: the playbook cells",
    "// (cell → [weighted count, weighted sum of R]) and the calibration sums left by a replay of the",
    `// year to ${new Date(END * 1000).toISOString().slice(0, 10)} with ${SLIP * 100}% slippage per taker fill. A new account starts from these;`,
    "// everything after is learned live.",
    "",
    'import type { PlaybookSeed } from "./playbook.ts";',
    "",
    "export const AGGRO_SEED: Record<string, PlaybookSeed> = {",
    body,
    "};",
    "",
  ];
  writeFileSync(file, lines.join(NL));
  console.log(`${NL}Wrote ${file}`);
}
