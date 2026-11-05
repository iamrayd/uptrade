// Strategy v2 on the cached 365-day history (end 2026-10-29), docs/strategies/V2-PLAN.md.
// Every run charges 0.05% slippage per taker fill inside the backtester. R figures are raw
// strategy results (no discipline); dollar figures are an account as the live bot runs it.
//
//   node --experimental-strip-types scripts/experiments/v2-validate.ts
//
// Trades are split by ENTRY time into the older and the newer half of the year. Choices are made
// on the older half only; the newer half is the out-of-sample check.
const ROOT = new URL("../../", import.meta.url).href;
const { STRATEGIES, STRATEGY_BY_KEY, withChandelier } = await import(ROOT + "supabase/functions/_shared/bot/strategies.ts");
const { backtest } = await import(ROOT + "supabase/functions/_shared/bot/backtest.ts");
const { binanceMarket } = await import(ROOT + "supabase/functions/_shared/bot/io.ts");
const { SYMBOLS, TF_SECONDS } = await import(ROOT + "supabase/functions/_shared/bot/types.ts");
const { isRetired } = await import(ROOT + "supabase/functions/_shared/bot/tuning.ts");
const { makerTimeoutMs } = await import(ROOT + "supabase/functions/_shared/bot/risk.ts");
const { align, history } = await import(ROOT + "scripts/lib/history.ts");

const END = 1793232000, DAYS = 365, START = END - DAYS * 86400, MID = START + Math.floor((DAYS * 86400) / 2), WARMUP = 600, SLIP = 0.0005;
const TFS = ["1h", "4h", "1d"];
let filters: Record<string, { step: number; tick: number }>;
try {
  filters = await binanceMarket.symbolFilters(SYMBOLS);
} catch {
  filters = { BTCUSDT: { step: 0.00001, tick: 0.01 }, ETHUSDT: { step: 0.0001, tick: 0.01 }, SOLUSDT: { step: 0.001, tick: 0.01 } };
}
const data: Record<string, any> = {};
const FINE = process.env.FINE ?? "1m"; // candles the maker fill model reads; 1m matches the live engine exactly
for (const tf of [...TFS, FINE]) {
  const b: any = {};
  for (const s of SYMBOLS) b[s] = tf === "1m" ? await minutes(s) : await history(s, tf, START - WARMUP * TF_SECONDS[tf], END);
  data[tf] = align(b);
}

/** A year of 1m candles (history() only knows the bot's timeframes). About 530 requests per coin, cached. */
async function minutes(symbol: string) {
  const { existsSync, readFileSync, writeFileSync } = await import("node:fs");
  const file = new URL(`scripts/.cache/${symbol}_1m_${START}_${END}.json`, ROOT);
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
  const out: any[] = [];
  let start = START * 1000;
  while (start < END * 1000) {
    const page = await binanceMarket.klines(symbol, "1m", { startTime: start, limit: 1000 });
    if (!page.length) break;
    for (const c of page) if (c.time < END && (!out.length || c.time > out[out.length - 1].time)) out.push(c);
    const next = page[page.length - 1].time * 1000 + 60_000;
    if (next <= start) break;
    start = next;
    await new Promise((r) => setTimeout(r, 100));
  }
  writeFileSync(file, JSON.stringify(out));
  return out;
}

interface Opts { maker?: boolean; discipline?: boolean; gate?: number | null }
function run(st: any, tf: string, o: Opts = {}) {
  return backtest({
    strategy: st, timeframe: tf, candlesBySymbol: data[tf], filters, settings: { riskPct: 0.02, maxLeverage: 20, slots: 3 }, startBalance: 100, from: START,
    minConfluence: o.gate === null ? undefined : (o.gate ?? 65), discipline: o.discipline ?? false, slippage: SLIP,
    makerEntry: o.maker ? { candles: data[FINE], timeoutSec: makerTimeoutMs(tf) / 1000, delaySec: 60 } : false,
  });
}
const f = (n: number | null, d = 3) => (n == null || !Number.isFinite(n) ? "   —" : `${n >= 0 ? "+" : ""}${n.toFixed(d)}`);
const stats = (ts: any[]) => {
  const n = ts.length, sum = ts.reduce((a, t) => a + t.r, 0);
  const sd = n > 1 ? Math.sqrt(ts.reduce((a, t) => a + (t.r - sum / n) ** 2, 0) / (n - 1)) : 0;
  return { n, avg: n ? sum / n : null, sum, t: n > 1 && sd > 0 ? sum / n / (sd / Math.sqrt(n)) : null };
};
const halves = (ts: any[]) => ({ old: stats(ts.filter((t) => t.entryTime < MID)), nw: stats(ts.filter((t) => t.entryTime >= MID)), all: stats(ts) });
const cell = (s: ReturnType<typeof stats>) => `${f(s.avg)} (${String(s.n).padStart(3)})`;

// ───── 1. Exit choice: opposite cross + 2R target (v1) vs a chandelier trail of k × ATR ─────
console.log("=== 1. EXITS: v1 (cross exit + 2R target) vs chandelier trail, gate 65, taker entries, slip 0.05% ===");
console.log("avgR (trades); chosen on the OLDER half, checked on the NEWER half");
const KS = [2, 2.5, 3, 4];
for (const key of ["ema_trend", "macd_adx"]) {
  const base = STRATEGY_BY_KEY[key];
  const variants: [string, any][] = [["v1", base], ...KS.map((k): [string, any] => [`trail ${k}`, withChandelier(base, { atr: 14, trailAtr: k }, { key: `${key}_v2`, name: "", version: 2, summary: "", rules: "" })])];
  console.log(`\n${key}        | ${TFS.map((t) => `${t} older      | ${t} newer     `).join(" | ")} | all TF older  | all TF newer`);
  for (const [name, st] of variants) {
    const per = TFS.map((tf) => halves(run(st, tf).tradeList));
    const allOld = stats(TFS.flatMap((tf) => run(st, tf).tradeList.filter((t: any) => t.entryTime < MID)));
    const allNew = stats(TFS.flatMap((tf) => run(st, tf).tradeList.filter((t: any) => t.entryTime >= MID)));
    console.log(`${name.padEnd(16)} | ${per.map((h) => `${cell(h.old)} | ${cell(h.nw)}`).join(" | ")} | ${cell(allOld)} | ${cell(allNew)}`);
  }
}

// ───── 2. Maker entries (limit at the signal close, 5m fill model, live timeout) vs taker ─────
console.log(`\n=== 2. ENTRIES: taker at the next open vs maker limit at the signal close (must fill within the live timeout; ${FINE} candles, none starting in the first minute after the close is counted, as live) ===`);
console.log("setup               | taker older    | taker newer    | maker older    | maker newer    | filled");
const live = STRATEGIES.filter((s: any) => !s.newsAware && !s.pool).flatMap((s: any) => TFS.filter((tf) => !isRetired(s.key, tf)).map((tf) => ({ s, tf })));
const tot = { tk: [] as any[], mk: [] as any[] };
for (const { s, tf } of live) {
  const tk = run(s, tf), mk = run(s, tf, { maker: true });
  tot.tk.push(...tk.tradeList); tot.mk.push(...mk.tradeList);
  const a = halves(tk.tradeList), b = halves(mk.tradeList);
  console.log(`${`${s.key} ${tf}`.padEnd(19)} | ${cell(a.old)} | ${cell(a.nw)} | ${cell(b.old)} | ${cell(b.nw)} | ${mk.trades}/${mk.trades + mk.unfilledEntries}`);
}
{
  const a = halves(tot.tk), b = halves(tot.mk);
  console.log(`${"ALL".padEnd(19)} | ${cell(a.old)} | ${cell(a.nw)} | ${cell(b.old)} | ${cell(b.nw)} | totalR taker ${f(a.all.sum, 1)} maker ${f(b.all.sum, 1)}`);
}

// ───── 3. Discipline per timeframe: dollars of a $100 account, with and without ─────
console.log("\n=== 3. DISCIPLINE (per-timeframe rules) on vs off: $ of a $100 account over the year, market entries ===");
console.log("timeframe | on $ (sum of setups) | off $ | setups");
for (const tf of TFS) {
  const set = live.filter((x: any) => x.tf === tf);
  const on = set.reduce((a: number, x: any) => a + run(x.s, tf, { discipline: true }).netUsd, 0);
  const off = set.reduce((a: number, x: any) => a + run(x.s, tf, { discipline: false }).netUsd, 0);
  console.log(`${tf.padEnd(9)} | ${f(on, 2).padStart(8)} | ${f(off, 2).padStart(8)} | ${set.length}`);
}

// ───── 4. The v2 book as it would run live, against the validation bar ─────
console.log("\n=== 4. V2 BOOK as live: non-retired setups, gate 65, per-timeframe discipline, market entries, slip 0.05% ===");
console.log("setup               | older avgR (n) | newer avgR (n) | year $ | maxDD%");
const book: any[] = [];
let usd = 0;
for (const { s, tf } of live) {
  const r = run(s, tf, { discipline: true });
  book.push(...r.tradeList.map((t: any) => ({ ...t, key: `${s.key} ${tf}` })));
  usd += r.netUsd;
  const h = halves(r.tradeList);
  console.log(`${`${s.key} ${tf}`.padEnd(19)} | ${cell(h.old)} | ${cell(h.nw)} | ${f(r.netUsd, 2).padStart(7)} | ${r.maxDrawdownPct.toFixed(1)}`);
}
const h = halves(book);
console.log(`\nBOOK: ${live.length} setups. older avgR ${cell(h.old)} t=${f(h.old.t, 2)} | newer avgR ${cell(h.nw)} t=${f(h.nw.t, 2)} | year avgR ${cell(h.all)}`);
console.log(`$100 split equally across the ${live.length} setups: ${f(usd / live.length, 2)} $ over the year (${f(usd / live.length / DAYS, 4)} $/day)`);
// The validation bar (V2-PLAN.md): newer-half avgR > +0.10 over 100+ trades, before any setup trades above 2% risk.
// The whole book's newer half is NOT a clean test: the retired list was drawn from both halves of this
// same year. The clean test is to pick setups on the older half only and read their newer half.
console.log(`\nWhole book, newer half: avgR ${f(h.nw.avg)}, n ${h.nw.n} (flattered: the retired list used this half too)`);
const keys = [...new Set(book.map((t) => t.key))];
const picks = keys.filter((k) => { const o = stats(book.filter((t) => t.key === k && t.entryTime < MID)); return o.avg != null && o.avg > 0.05 && o.n >= 10; });
const pk = stats(book.filter((t) => picks.includes(t.key) && t.entryTime >= MID));
console.log(`Picked on the older half (avgR > 0.05, n ≥ 10): ${picks.join(", ") || "none"}`);
console.log(`  → their newer half: avgR ${cell(pk)} t=${f(pk.t, 2)}  ⇒ validation bar ${pk.avg != null && pk.avg > 0.1 && pk.n >= 100 ? "MET" : "NOT MET"}`);
const solo = keys.filter((k) => { const n = stats(book.filter((t) => t.key === k && t.entryTime >= MID)); return n.avg != null && n.avg > 0.1 && n.n >= 100; });
console.log(`Single setups with newer-half avgR > +0.10 over 100+ trades: ${solo.map((k) => `${k} (older half ${f(stats(book.filter((t) => t.key === k && t.entryTime < MID)).avg)})`).join(", ") || "none"}`);
