// Tests candidate entry rules on the trades recorded by scripts/gate-analysis.ts (run that first).
// A rule is judged on the older half and on the newer half separately: only a rule that helps in
// both counts. Few rules are tried on purpose, so a lucky one is unlikely to look good in both.
//
//   node scripts/gate-rules.ts

import { readFileSync } from "node:fs";
import type { BtTrade } from "../supabase/functions/_shared/bot/backtest.ts";

const argDays = process.argv.indexOf("--days");
const DAYS = argDays > 0 ? Number(process.argv[argDays + 1]) : 365;
type Row = BtTrade & { strategy: string; timeframe: string };
const rows: Row[] = JSON.parse(readFileSync(`scripts/.cache/gate-rows-${DAYS}d.json`, "utf8"));
const times = rows.map((r) => r.exitTime).sort((a, b) => a - b);
const mid = times[Math.floor(times.length / 2)];

const c = (r: Row, k: string) => r.cf!.checks[k];
const avg = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN);
const f = (n: number) => (Number.isFinite(n) ? (n >= 0 ? "+" : "") + n.toFixed(3) : "  n/a");
function pf(xs: number[]) {
  const w = xs.filter((x) => x > 0).reduce((s, x) => s + x, 0);
  const l = -xs.filter((x) => x <= 0).reduce((s, x) => s + x, 0);
  return l ? w / l : NaN;
}

/** Stop distance as a % of price, backed out of the trade's risk: risk = qty × (distance + fees on both fills). */
const stopPct = (r: Row) => (r.riskUsd / (r.qty * r.entry) - 0.0004) * 100;

const RULES: [string, (r: Row) => boolean][] = [
  ["no filter", () => true],
  ["momentum", (r) => c(r, "momentum") !== false],
  ["volume", (r) => c(r, "volume") !== false],
  ["momentum & volume", (r) => c(r, "momentum") !== false && c(r, "volume") !== false],
  ["not strength", (r) => c(r, "strength") !== true],
  ["momentum & not strength", (r) => c(r, "momentum") !== false && c(r, "strength") !== true],
  ["momentum & vol & not strength", (r) => c(r, "momentum") !== false && c(r, "volume") !== false && c(r, "strength") !== true],
  ["momentum & supertrend", (r) => c(r, "momentum") !== false && c(r, "supertrend") !== false],
  ["momentum & trend200", (r) => c(r, "momentum") !== false && c(r, "trend200") !== false],
  ["stop ≥ 0.4%", (r) => stopPct(r) >= 0.4],
  ["stop ≥ 0.6%", (r) => stopPct(r) >= 0.6],
  ["stop ≥ 0.8%", (r) => stopPct(r) >= 0.8],
  ["stop ≥ 1.0%", (r) => stopPct(r) >= 1.0],
  ["stop ≥ 0.6% & momentum", (r) => stopPct(r) >= 0.6 && c(r, "momentum") !== false],
  ["stop ≥ 0.6% & mom & vol", (r) => stopPct(r) >= 0.6 && c(r, "momentum") !== false && c(r, "volume") !== false],
  ["score ≥ 85", (r) => r.cf!.score >= 85],
  ["score < 65", (r) => r.cf!.score < 65],
];
const GROUPS: [string, (r: Row) => boolean][] = [
  ["all", () => true],
  ["5m-30m", (r) => ["5m", "15m", "30m"].includes(r.timeframe)],
  ["1h-1d", (r) => ["1h", "4h", "1d"].includes(r.timeframe)],
  ["trend strategies", (r) => r.strategy !== "bb_rsi"],
];

console.log("stop distance buckets (% of price): avg R, n");
for (const [gname, g] of GROUPS) {
  const pool = rows.filter(g);
  const out: string[] = [];
  for (const [lo, hi] of [[0, 0.2], [0.2, 0.4], [0.4, 0.6], [0.6, 0.9], [0.9, 1.4], [1.4, 100]]) {
    const b = pool.filter((r) => stopPct(r) >= lo && stopPct(r) < hi);
    out.push(`${lo}-${hi === 100 ? "+" : hi}%: ${f(avg(b.map((r) => r.r)))} (${b.length})`);
  }
  console.log(`  ${gname.padEnd(18)} ${out.join("   ")}`);
}
console.log(`${rows.length} trades; older/newer split at ${new Date(mid * 1000).toISOString().slice(0, 10)}`);
for (const [gname, g] of GROUPS) {
  const pool = rows.filter(g);
  console.log(`\n=== ${gname} (${pool.length}) ===`);
  for (const [name, rule] of RULES) {
    const kept = pool.filter(rule);
    const older = kept.filter((r) => r.exitTime < mid).map((r) => r.r);
    const newer = kept.filter((r) => r.exitTime >= mid).map((r) => r.r);
    console.log(
      `  ${name.padEnd(30)} keeps ${String(Math.round((kept.length / pool.length) * 100)).padStart(3)}%  avgR ${f(avg(kept.map((r) => r.r)))}  PF ${pf(kept.map((r) => r.r)).toFixed(2)}  older ${f(avg(older))} (${older.length})  newer ${f(avg(newer))} (${newer.length})`,
    );
  }
}
