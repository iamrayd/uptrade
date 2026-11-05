// Cost sensitivity on the 15 HTF setups (1h/4h/1d), gate 65 + discipline, 2% risk.
const ROOT = new URL("../../", import.meta.url).href;
const { STRATEGIES } = await import(ROOT + "supabase/functions/_shared/bot/strategies.ts");
const { backtest } = await import(ROOT + "supabase/functions/_shared/bot/backtest.ts");
const { binanceMarket } = await import(ROOT + "supabase/functions/_shared/bot/io.ts");
const { SYMBOLS, TF_SECONDS } = await import(ROOT + "supabase/functions/_shared/bot/types.ts");
const { align, history } = await import(ROOT + "scripts/lib/history.ts");

const END = 1793232000, DAYS = 365, START = END - DAYS * 86400, WARMUP = 600;
const TFS = ["1h", "4h", "1d"];
const filters = await binanceMarket.symbolFilters(SYMBOLS);
const data: Record<string, any> = {};
for (const tf of TFS) {
  const bySym: Record<string, any> = {};
  for (const s of SYMBOLS) bySym[s] = await history(s, tf, START - WARMUP * TF_SECONDS[tf], END);
  data[tf] = align(bySym);
}
const TAKER = 0.0002;
// cost models: [entrySlip, exitSlip, entryFeeRefund(bool)]
const MODELS: Record<string, { es: number; xs: number; makerEntry: boolean }> = {
  "paper (taker, 0 slip)": { es: 0, xs: 0, makerEntry: false },
  "slip 0.02%/side": { es: 0.0002, xs: 0.0002, makerEntry: false },
  "slip 0.05%/side": { es: 0.0005, xs: 0.0005, makerEntry: false },
  "maker entry, exit slip 0.02%": { es: 0, xs: 0.0002, makerEntry: true },
  "maker entry, exit slip 0.05%": { es: 0, xs: 0.0005, makerEntry: true },
};
const f = (n: number, d = 3) => n.toFixed(d);
const agg: Record<string, { n: number; sumR: number; net: number; gw: number; gl: number; hold: number }> = {};
const perSetup: string[] = [];
let totalHold = 0, totalN = 0;
const reasonAgg: Record<string, { n: number; r: number }> = {};
for (const tf of TFS) for (const st of STRATEGIES.filter((s: any) => !s.newsAware && !s.pool)) {
  const r = backtest({ strategy: st, timeframe: tf, candlesBySymbol: data[tf], filters, settings: { riskPct: 0.02, maxLeverage: 20, slots: 3 }, startBalance: 100, from: START, minConfluence: 65, discipline: true });
  const row: string[] = [`${st.key} ${tf}`.padEnd(16)];
  for (const [name, m] of Object.entries(MODELS)) {
    const a = (agg[name] ??= { n: 0, sumR: 0, net: 0, gw: 0, gl: 0, hold: 0 });
    let sumR = 0;
    for (const t of r.tradeList) {
      let net = t.net - m.es * t.qty * t.entry - m.xs * t.qty * t.exit;
      if (m.makerEntry) net += TAKER * t.qty * t.entry;
      const rr = t.riskUsd > 0 ? net / t.riskUsd : 0;
      sumR += rr; a.n++; a.sumR += rr; a.net += net;
      if (net > 0) a.gw += net; else a.gl -= net;
      if (name === "slip 0.05%/side") {
        const ra = (reasonAgg[t.reason] ??= { n: 0, r: 0 }); ra.n++; ra.r += rr;
      }
    }
    row.push(f(r.tradeList.length ? sumR / r.tradeList.length : 0).padStart(7));
  }
  for (const t of r.tradeList) { totalHold += t.exitTime - t.entryTime; totalN++; }
  perSetup.push(row.join(" | "));
}
console.log("avgR per setup by cost model: " + Object.keys(MODELS).join(" | "));
for (const l of perSetup) console.log(l);
console.log("\nAGGREGATE 15 HTF setups:");
for (const [name, a] of Object.entries(agg)) console.log(`  ${name.padEnd(30)} n ${a.n}  avgR ${f(a.sumR / a.n)}  PF ${f(a.gw / a.gl, 2)}  sum net $ (sum of 15 x $100) ${f(a.net, 1)}`);
console.log(`\navg hold ${(totalHold / totalN / 3600).toFixed(1)} h; trades per account-day ${(totalN / 15 / DAYS).toFixed(2)}`);
console.log("\nEXIT REASONS (slip 0.05%):");
for (const [k, v] of Object.entries(reasonAgg)) console.log(`  ${k.padEnd(14)} n ${String(v.n).padStart(4)} avgR ${f(v.r / v.n)} totalR ${f(v.r, 1)}`);
