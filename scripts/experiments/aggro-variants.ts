// Does the playbook's estimate sort signals at all, and with which memory settings?
// Replays the cached year with a few a-priori variants of the playbook's memory and prints, per
// half of the year, what signals realized by the estimate they had at the time.
//
//   node --experimental-strip-types scripts/experiments/aggro-variants.ts [15m|1h|4h]
//
// "raw" variants trade on the record-based estimate as it is; "calibrated" is what runs live.

import { aggroReplay } from "../../supabase/functions/_shared/bot/aggro.ts";
import { AGGRO } from "../../supabase/functions/_shared/bot/playbook.ts";
import { SYMBOLS, TF_SECONDS, type Candle, type Timeframe } from "../../supabase/functions/_shared/bot/types.ts";
import { align, history } from "../lib/history.ts";

const END = 1793232000;
const START = END - 365 * 86400;
const MID = START + 182.5 * 86400;
const FILTERS = { BTCUSDT: { step: 0.00001, tick: 0.01 }, ETHUSDT: { step: 0.0001, tick: 0.01 }, SOLUSDT: { step: 0.001, tick: 0.01 } };
const tfs = (process.argv[2] ? [process.argv[2]] : ["4h", "1h", "15m"]) as Timeframe[];
const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN);
const sR = (n: number) => (Number.isFinite(n) ? `${n >= 0 ? "+" : ""}${n.toFixed(3)}` : "   —  ");

const VARIANTS: [string, Partial<typeof AGGRO>][] = [
  ["raw record, no calibration (decay .998, prior 20)", { calibration: false }],
  ["raw, no decay", { calibration: false, decay: 1 }],
  ["raw, no decay, prior 100", { calibration: false, decay: 1, prior: 100 }],
  ["raw, decay .998, prior 100", { calibration: false, prior: 100 }],
  ["raw, rule set only (no context), no decay", { calibration: false, decay: 1, facetWeight: 0 }],
  ["raw, fast memory (decay .98)", { calibration: false, decay: 0.98 }],
  ["calibrated (the live setting)", {}],
];
const BASE = { ...AGGRO };

for (const tf of tfs) {
  const bySym: Record<string, Candle[]> = {};
  for (const s of SYMBOLS) bySym[s] = await history(s, tf, START - 600 * TF_SECONDS[tf], END);
  const data = align(bySym);
  console.log(`\n══ ${tf} ══  realized R of all signals by the estimate at the time: older half | newer half   (n)`);
  for (const [name, over] of VARIANTS) {
    Object.assign(AGGRO, BASE, over);
    const res = aggroReplay({ timeframe: tf, candlesBySymbol: data, filters: FILTERS, from: START, startBalance: 100, maxLeverage: 20, slippage: 0.0005 });
    const row = (lo: number, hi: number) => {
      const g = res.signals.filter((s) => s.exp >= lo && s.exp < hi);
      const a = g.filter((s) => s.time < MID);
      const b = g.filter((s) => s.time >= MID);
      return `${sR(mean(a.map((s) => s.r)))} | ${sR(mean(b.map((s) => s.r)))} (${a.length}/${b.length})`;
    };
    const tr = (lo: number, hi: number) => {
      const g = res.trades.filter((t) => t.entryTime >= lo && t.entryTime < hi);
      return `${sR(mean(g.map((t) => t.r)))} (${g.length})`;
    };
    console.log(`${name}`);
    console.log(`   exp<0: ${row(-Infinity, 0)}   0…0.05: ${row(0, 0.05)}   0.05…0.15: ${row(0.05, 0.15)}   ≥0.15: ${row(0.15, Infinity)}`);
    console.log(`   traded: older ${tr(START, MID)}, newer ${tr(MID, END)}; lives ${res.livesUsed}, final $${res.finalEquity.toFixed(0)}`);
  }
}
Object.assign(AGGRO, BASE);
