// Experiments on the cached 365-day history (end 2026-10-29). Slippage 0.05%/side applied to every trade.
const ROOT = new URL("../../", import.meta.url).href;
const { STRATEGIES } = await import(ROOT + "supabase/functions/_shared/bot/strategies.ts");
const { backtest } = await import(ROOT + "supabase/functions/_shared/bot/backtest.ts");
const { binanceMarket } = await import(ROOT + "supabase/functions/_shared/bot/io.ts");
const { SYMBOLS, TF_SECONDS, TIMEFRAMES } = await import(ROOT + "supabase/functions/_shared/bot/types.ts");
const { breakevenStop, reachedR } = await import(ROOT + "supabase/functions/_shared/bot/risk.ts");
const { align, history } = await import(ROOT + "scripts/lib/history.ts");

const END = 1793232000; // matches cache files
const DAYS = 365;
const START = END - DAYS * 86400;
const MID = START + Math.floor((DAYS * 86400) / 2);
const SLIP = 0.0005;
const WARMUP = 600;

type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number };
type Strat = (typeof STRATEGIES)[number];

function withBreakeven(s: Strat): Strat {
  const initial = new Map<string, number>(); // first manage call sees the initial stop
  return {
    ...s,
    manage(c: Candle[], tr: any) {
      const k = `${tr.side}:${tr.entryPrice}`;
      if (tr.barsHeld <= 1 && !initial.has(k)) initial.set(k, Math.abs(tr.entryPrice - tr.stop));
      const m = s.manage(c, tr);
      if (m.exit) return m;
      const held = c.slice(Math.max(0, c.length - tr.barsHeld));
      if (!held.length) return m;
      const best = tr.side === "long" ? Math.max(...held.map((x) => x.high)) : Math.min(...held.map((x) => x.low));
      const initRisk = initial.get(k) ?? Math.abs(tr.entryPrice - tr.stop);
      const reached = (tr.side === "long" ? best - tr.entryPrice : tr.entryPrice - best) >= initRisk;
      if (!reached) return m;
      const be = breakevenStop(tr.side, tr.entryPrice);
      const proposed = m.stop == null ? be : tr.side === "long" ? Math.max(m.stop, be) : Math.min(m.stop, be);
      return { ...m, stop: proposed };
    },
  };
}

const filters = await binanceMarket.symbolFilters(SYMBOLS);
const data: Record<string, Record<string, Candle[]>> = {};
for (const tf of TIMEFRAMES) {
  const from = START - WARMUP * TF_SECONDS[tf];
  const bySym: Record<string, Candle[]> = {};
  for (const s of SYMBOLS) bySym[s] = await history(s, tf, from, END);
  data[tf] = align(bySym);
}

interface Opts { gate?: number; discipline?: boolean; risk?: number; be?: boolean; from?: number; maxLev?: number }
function run(strat: Strat, tf: string, o: Opts) {
  const s = o.be ? withBreakeven(strat) : strat;
  const r = backtest({
    strategy: s, timeframe: tf, candlesBySymbol: data[tf], filters,
    settings: { riskPct: o.risk ?? 0.02, maxLeverage: o.maxLev ?? 20, slots: SYMBOLS.length },
    startBalance: 100, from: o.from ?? START, minConfluence: o.gate, discipline: o.discipline ?? true,
  });
  const trades = r.tradeList.map((t: any) => {
    const slipUsd = SLIP * t.qty * (t.entry + t.exit);
    return { ...t, netSlip: t.net - slipUsd, rSlip: t.riskUsd > 0 ? (t.net - slipUsd) / t.riskUsd : 0 };
  });
  return { ...r, trades };
}

function dailyStats(trades: any[], from: number, to: number, start = 100) {
  const byDay = new Map<string, number>();
  for (const t of trades) {
    const d = new Date(t.exitTime * 1000).toISOString().slice(0, 10);
    byDay.set(d, (byDay.get(d) ?? 0) + t.netSlip);
  }
  const days = Math.round((to - from) / 86400);
  const vals: number[] = [];
  let eq = start, peak = start, dd = 0;
  for (let i = 0; i < days; i++) {
    const d = new Date((from + i * 86400) * 1000).toISOString().slice(0, 10);
    const v = byDay.get(d) ?? 0;
    vals.push(v);
    eq += v; peak = Math.max(peak, eq); dd = Math.max(dd, (peak - eq) / peak);
  }
  const total = vals.reduce((a, b) => a + b, 0);
  const active = vals.filter((v) => v !== 0);
  const sorted = [...vals].sort((a, b) => a - b);
  const sumR = trades.reduce((a, t) => a + t.rSlip, 0);
  const gw = trades.filter((t) => t.netSlip > 0).reduce((a, t) => a + t.netSlip, 0);
  const gl = -trades.filter((t) => t.netSlip <= 0).reduce((a, t) => a + t.netSlip, 0);
  return {
    total, days, avgDay: total / days, medDay: sorted[Math.floor(days / 2)],
    posDays: vals.filter((v) => v > 0).length, negDays: vals.filter((v) => v < 0).length, flatDays: vals.filter((v) => v === 0).length,
    best: sorted[sorted.length - 1], worst: sorted[0], maxDd: dd * 100,
    n: trades.length, avgR: trades.length ? sumR / trades.length : 0, pf: gl > 0 ? gw / gl : null,
    winPct: trades.length ? (100 * trades.filter((t) => t.netSlip > 0).length) / trades.length : 0, vals,
  };
}

const f1 = (n: number | null, d = 2) => (n == null ? "—" : n.toFixed(d));
const pct = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;

// ───── 1. Live config, whole year, with slippage; split by halves ─────
console.log("\n=== 1. LIVE CONFIG (gate 65 + discipline, 2% risk) WITH 0.05%/side SLIPPAGE ===");
console.log("setup            | yr ret | avgR  | PF   | n    | maxDD | older avgR (n) | newer avgR (n) | $/day");
const live: any[] = [];
for (const tf of TIMEFRAMES) for (const st of STRATEGIES.filter((s: Strat) => !s.newsAware && !s.pool)) {
  const r = run(st, tf, { gate: 65 });
  const all = dailyStats(r.trades, START, END);
  const old = r.trades.filter((t: any) => t.exitTime < MID);
  const nw = run(st, tf, { gate: 65, from: MID }).trades;
  const oa = old.length ? old.reduce((a: number, t: any) => a + t.rSlip, 0) / old.length : 0;
  const na = nw.length ? nw.reduce((a: number, t: any) => a + t.rSlip, 0) / nw.length : 0;
  live.push({ key: `${st.key} ${tf}`, st, tf, all, oa, on: old.length, na, nn: nw.length });
}
live.sort((a, b) => b.all.total - a.all.total);
for (const x of live)
  console.log(`${x.key.padEnd(16)} | ${pct(x.all.total).padStart(6)} | ${f1(x.all.avgR, 3).padStart(5)} | ${f1(x.all.pf).padStart(4)} | ${String(x.all.n).padStart(4)} | ${f1(x.all.maxDd, 1).padStart(5)} | ${f1(x.oa, 3).padStart(6)} (${String(x.on).padStart(3)}) | ${f1(x.na, 3).padStart(6)} (${String(x.nn).padStart(3)}) | ${f1(x.all.avgDay, 3)}`);
const prof = live.filter((x) => x.all.total > 0).length;
console.log(`profitable after slippage: ${prof}/30; mean return ${pct(live.reduce((a, x) => a + x.all.total, 0) / 30)}`);

// ───── 2. Honest selection: pick on OLDER half, test on NEWER half ─────
console.log("\n=== 2. OUT-OF-SAMPLE: setups picked on older half (avgR>0.05, n>=15), tested on newer half ===");
const picked = live.filter((x) => x.oa > 0.05 && x.on >= 15).sort((a, b) => b.oa - a.oa);
for (const x of picked) console.log(`  ${x.key.padEnd(16)} older ${f1(x.oa, 3)} (${x.on})  → newer ${f1(x.na, 3)} (${x.nn})`);
const oosAvg = picked.reduce((a, x) => a + x.na * x.nn, 0) / Math.max(1, picked.reduce((a, x) => a + x.nn, 0));
console.log(`  weighted newer-half avgR of picked: ${f1(oosAvg, 3)}`);

// ───── 3. Portfolio variants on the higher timeframes (1h/4h/1d), whole year + newer half ─────
function portfolio(setups: { st: Strat; tf: string }[], o: Opts, from = START, to = END) {
  const K = setups.length;
  const all: any[] = [];
  for (const s of setups) {
    const r = run(s.st, s.tf, { ...o, from });
    for (const t of r.trades) all.push({ ...t, netSlip: t.netSlip / K, net: t.net / K });
  }
  return dailyStats(all, from, to);
}
const hi = (keys: string[]) => keys.map((k) => { const [key, tf] = k.split(" "); return { st: STRATEGIES.find((s: Strat) => s.key === key)!, tf }; });

const P_ALL_HTF = hi(TIMEFRAMES.filter((t: string) => ["1h", "4h", "1d"].includes(t)).flatMap((tf: string) => STRATEGIES.filter((s: Strat) => !s.newsAware && !s.pool).map((s: Strat) => `${s.key} ${tf}`)));
const P_PICKED = picked.map((x) => ({ st: x.st, tf: x.tf }));
const P_TOP_INSAMPLE = live.slice(0, 5).map((x) => ({ st: x.st, tf: x.tf }));

const show = (name: string, d: ReturnType<typeof dailyStats>) =>
  console.log(`${name.padEnd(44)} ret ${pct(d.total).padStart(7)}  $/day ${f1(d.avgDay, 3).padStart(6)}  med/day ${f1(d.medDay, 3).padStart(6)}  +days ${d.posDays}/-${d.negDays}/0:${d.flatDays}  best ${f1(d.best)} worst ${f1(d.worst)}  DD ${f1(d.maxDd, 1)}%  n ${d.n} avgR ${f1(d.avgR, 3)} PF ${f1(d.pf)} win ${f1(d.winPct, 0)}%`);

console.log("\n=== 3. PORTFOLIOS ($100 split equally), whole year, slippage included ===");
for (const [name, set] of [["all 15 HTF setups (1h/4h/1d)", P_ALL_HTF], ["older-half picks", P_PICKED], ["top-5 in-sample (overfit ceiling)", P_TOP_INSAMPLE]] as const) {
  for (const o of [{ gate: 65, risk: 0.02 }, { gate: 65, risk: 0.02, be: true }, { gate: 80, risk: 0.02 }, { gate: 65, risk: 0.04 }, { gate: 80, risk: 0.04, be: true }, { gate: 65, risk: 0.06 }]) {
    show(`${name} g${o.gate} r${(o.risk * 100).toFixed(0)}${o.be ? " BE" : ""}`, portfolio(set as any, o));
  }
  console.log();
}

console.log("=== 3b. Same portfolios, NEWER HALF only (out-of-sample for the picks) ===");
for (const [name, set] of [["all 15 HTF setups", P_ALL_HTF], ["older-half picks", P_PICKED]] as const) {
  for (const o of [{ gate: 65, risk: 0.02 }, { gate: 65, risk: 0.02, be: true }, { gate: 80, risk: 0.02 }, { gate: 65, risk: 0.04 }, { gate: 80, risk: 0.04, be: true }]) {
    show(`${name} g${o.gate} r${(o.risk * 100).toFixed(0)}${o.be ? " BE" : ""}`, portfolio(set as any, o, MID, END));
  }
  console.log();
}

// ───── 4. Per-setup: does breakeven help? gate 80? ─────
console.log("=== 4. PER-SETUP (HTF only): gate 65 vs 80, BE on/off — whole-year return after slippage ===");
console.log("setup            | g65    | g65+BE | g80    | g80+BE | n65 | n80");
for (const s of P_ALL_HTF) {
  const a = dailyStats(run(s.st, s.tf, { gate: 65 }).trades, START, END);
  const b = dailyStats(run(s.st, s.tf, { gate: 65, be: true }).trades, START, END);
  const c = dailyStats(run(s.st, s.tf, { gate: 80 }).trades, START, END);
  const d = dailyStats(run(s.st, s.tf, { gate: 80, be: true }).trades, START, END);
  console.log(`${`${s.st.key} ${s.tf}`.padEnd(16)} | ${pct(a.total).padStart(6)} | ${pct(b.total).padStart(6)} | ${pct(c.total).padStart(6)} | ${pct(d.total).padStart(6)} | ${String(a.n).padStart(3)} | ${String(c.n).padStart(3)}`);
}

// ───── 5. Exit reason breakdown for HTF setups (where does R leak?) ─────
console.log("\n=== 5. EXIT REASONS, all 15 HTF setups, gate 65 ===");
const byReason = new Map<string, { n: number; r: number }>();
for (const s of P_ALL_HTF) for (const t of run(s.st, s.tf, { gate: 65 }).trades) {
  const e = byReason.get(t.reason) ?? { n: 0, r: 0 };
  e.n++; e.r += t.rSlip; byReason.set(t.reason, e);
}
for (const [k, v] of byReason) console.log(`  ${k.padEnd(14)} n ${String(v.n).padStart(4)}  avgR ${f1(v.r / v.n, 3)}  totalR ${f1(v.r, 1)}`);

// ───── 6. Long vs short, per symbol ─────
console.log("\n=== 6. SIDE / SYMBOL, all 15 HTF setups, gate 65 ===");
const bySide = new Map<string, { n: number; r: number }>();
for (const s of P_ALL_HTF) for (const t of run(s.st, s.tf, { gate: 65 }).trades) {
  for (const k of [t.side, t.symbol]) { const e = bySide.get(k) ?? { n: 0, r: 0 }; e.n++; e.r += t.rSlip; bySide.set(k, e); }
}
for (const [k, v] of bySide) console.log(`  ${k.padEnd(10)} n ${String(v.n).padStart(4)}  avgR ${f1(v.r / v.n, 3)}`);

// ───── 7. Leverage cap sensitivity at 4% risk (does 20x cap bind?) ─────
console.log("\n=== 7. older-half picks, g65, risk 4%: maxLev 20 vs 50 ===");
show("picks r4 lev20", portfolio(P_PICKED as any, { gate: 65, risk: 0.04, maxLev: 20 }));
show("picks r4 lev50", portfolio(P_PICKED as any, { gate: 65, risk: 0.04, maxLev: 50 }));
