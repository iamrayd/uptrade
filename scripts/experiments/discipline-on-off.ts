// Does the discipline rule (risk cuts + cooldown) cost dollars? HTF setups, gate 65, 2% risk, slip 0.05%.
const ROOT = new URL("../../", import.meta.url).href;
const { STRATEGIES } = await import(ROOT + "supabase/functions/_shared/bot/strategies.ts");
const { backtest } = await import(ROOT + "supabase/functions/_shared/bot/backtest.ts");
const { binanceMarket } = await import(ROOT + "supabase/functions/_shared/bot/io.ts");
const { SYMBOLS, TF_SECONDS } = await import(ROOT + "supabase/functions/_shared/bot/types.ts");
const { align, history } = await import(ROOT + "scripts/lib/history.ts");
const END = 1793232000, DAYS = 365, START = END - DAYS * 86400, WARMUP = 600, SLIP = 0.0005;
const TFS = ["1h", "4h", "1d"];
const filters = await binanceMarket.symbolFilters(SYMBOLS);
const data: Record<string, any> = {};
for (const tf of TFS) { const b: any = {}; for (const s of SYMBOLS) b[s] = await history(s, tf, START - WARMUP * TF_SECONDS[tf], END); data[tf] = align(b); }
const f = (n: number, d = 2) => n.toFixed(d);
console.log("setup            | disc ON ret / avgR / n   | disc OFF ret / avgR / n  | OFF gate0 ret / avgR / n");
const tot = { on: 0, off: 0, raw: 0 };
for (const tf of TFS) for (const st of STRATEGIES.filter((s: any) => !s.newsAware && !s.pool)) {
  const go = (disc: boolean, gate?: number) => {
    const r = backtest({ strategy: st, timeframe: tf, candlesBySymbol: data[tf], filters, settings: { riskPct: 0.02, maxLeverage: 20, slots: 3 }, startBalance: 100, from: START, minConfluence: gate, discipline: disc });
    let net = 0, sumR = 0;
    for (const t of r.tradeList) { const n = t.net - SLIP * t.qty * (t.entry + t.exit); net += n; sumR += t.riskUsd > 0 ? n / t.riskUsd : 0; }
    return { ret: net, avgR: r.tradeList.length ? sumR / r.tradeList.length : 0, n: r.tradeList.length };
  };
  const a = go(true, 65), b = go(false, 65), c = go(false, undefined);
  tot.on += a.ret; tot.off += b.ret; tot.raw += c.ret;
  console.log(`${`${st.key} ${tf}`.padEnd(16)} | ${f(a.ret, 1).padStart(6)}% ${f(a.avgR, 3).padStart(6)} ${String(a.n).padStart(4)} | ${f(b.ret, 1).padStart(6)}% ${f(b.avgR, 3).padStart(6)} ${String(b.n).padStart(4)} | ${f(c.ret, 1).padStart(6)}% ${f(c.avgR, 3).padStart(6)} ${String(c.n).padStart(4)}`);
}
console.log(`\nmean return over 15: disc ON ${f(tot.on / 15, 1)}%  disc OFF ${f(tot.off / 15, 1)}%  no gate no disc ${f(tot.raw / 15, 1)}%`);
