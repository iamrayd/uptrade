// Crypto-news awareness for the news strategy variants (and as learning features for all bots).
//
//  - fetchNews:   headlines from public RSS feeds + the Fear & Greed index, scored by a keyword
//                 lexicon. No API key, no cost, deterministic and testable. Runs in bot-news.
//  - newsFor:     the reading for one coin: sentiment (−1…+1) and event risk (0…1), with older
//                 headlines fading (half-life 6 hours).
//  - newsGate:    the rule the "+ News" bots apply. They wait out fresh high-impact events (hacks,
//                 bans, lawsuits, depegs …) and do not trade against clearly one-sided news.
//
// Honest limits: a keyword lexicon is blunt (it misses sarcasm and negation) and there is no
// news history to backtest against, so the news variants can only be judged forward, side by
// side with their plain twins. Every trade stores the news reading it was taken with, so the
// learner can also find out whether news mattered.

import type { Side } from "./types.ts";

export type NewsScope = "BTC" | "ETH" | "SOL" | "MARKET";

export interface Headline {
  title: string;
  description?: string;
  source: string;
  /** Publication time (ms). */
  at: number;
}

export interface ScoredHeadline extends Headline {
  scopes: NewsScope[];
  /** −1 (bearish) … +1 (bullish) before fading. */
  sentiment: number;
  /** 0 … 1: how much this looks like a market-moving event, before fading. */
  risk: number;
}

export interface ScopeNews {
  /** Faded sentiment, −1 … +1. */
  score: number;
  /** Faded event risk, 0 … 1. */
  risk: number;
  /** Headlines inside the window. */
  n: number;
  /** The headlines that moved the numbers most. */
  top: { title: string; source: string; at: number; sentiment: number; risk: number }[];
}

export interface NewsState {
  fetchedAt: number;
  fng: { value: number; label: string } | null;
  /** Feeds that answered / failed in this read. */
  sources: string[];
  errors: string[];
  scopes: Record<NewsScope, ScopeNews>;
}

export const NEWS = {
  /** Headlines older than this are ignored. */
  windowMs: 24 * 3600_000,
  /** A headline's weight halves every this long. */
  halfLifeMs: 6 * 3600_000,
  /** A reading older than this is treated as unavailable. */
  staleMs: 45 * 60_000,
  /** Wait (no entries either way) while event risk is at least this. A single fresh hack/ban headline stays above it for about 2 hours. */
  riskBlock: 0.55,
  /** Do not enter against news at least this one-sided. */
  sentimentBlock: 0.35,
};

export const FEEDS: { name: string; url: string }[] = [
  { name: "CoinDesk", url: "https://www.coindesk.com/arc/outboundfeeds/rss/" },
  { name: "Cointelegraph", url: "https://cointelegraph.com/rss" },
  { name: "Decrypt", url: "https://decrypt.co/feed" },
];

// ───────────────────────── Lexicon ─────────────────────────

const STRONG = 1;
const MEDIUM = 0.6;
const MILD = 0.3;

const BEARISH: [RegExp, number][] = [
  [/\b(hack(ed|s|ers?)?|exploit(ed|s)?|drained|stolen|breach(ed)?|rug[- ]?pull|insolven\w*|bankrupt\w*|collaps\w*|de-?peg\w*|fraud\w*|ponzi|delist\w*|ban(s|ned)?|crackdown|subpoena\w*|arrest\w*|sues?|sued|lawsuit\w*|charges)\b/i, STRONG],
  [/\b(crash\w*|plunge\w*|plummet\w*|tumbl\w*|slump\w*|dump\w*|tank(s|ed|ing)?|sell-?off|liquidat\w*|outflows?|hawkish|rate hikes?|recession|tariffs?|panic|capitulat\w*|breakdown|bearish|rejects?|rejected|denied|halts?|halted|suspend\w*|outage)\b/i, MEDIUM],
  [/\b(drops?|falls?|fell|slips?|slid|declin\w*|pressure|weak\w*|concerns?|uncertain\w*|warns?|warning|fears?|risks?|lower|loses|lost)\b/i, MILD],
];

const BULLISH: [RegExp, number][] = [
  [/\b(etf (approv\w*|inflows?)|approv(es|ed|al)|strategic (bitcoin )?reserve|all-time highs?|record highs?|adopt(s|ed|ion))\b/i, STRONG],
  [/\b(surg\w*|soar\w*|rall(y|ies|ied)|jump\w*|spik\w*|breakout|inflows?|accumulat\w*|bullish|rate cuts?|dovish|partnership|upgrade\w*|institutional|buys?|bought|launch\w*)\b/i, MEDIUM],
  [/\b(rises?|rose|gains?|gained|climb\w*|rebound\w*|recover\w*|higher|strong\w*|optimis\w*|support)\b/i, MILD],
];

/** Events that move markets whichever way they resolve: wait for the dust to settle. */
const EVENT_RISK: [RegExp, number][] = [
  [/\b(hack(ed|s|ers?)?|exploit(ed|s)?|drained|stolen|breach(ed)?|rug[- ]?pull|insolven\w*|bankrupt\w*|de-?peg\w*|delist\w*|ban(s|ned)?|crackdown|subpoena\w*|emergency|outage|halts?|halted|suspend\w*)\b/i, 1],
  [/\b(sec|cftc|doj)\b.*\b(charges?|sues?|sued|lawsuit|fines?|probe|investigat\w*)\b|\b(charges?|sues?|sued|lawsuit)\b.*\b(sec|cftc|doj)\b/i, 1],
  [/\b(fomc|rate decision|cpi|inflation data|rate hikes?|hawkish)\b/i, 0.4],
  [/\b(liquidations?|crash\w*|plunge\w*)\b/i, 0.4],
];

// "Sol" the name is not Solana: the ticker only counts in capitals.
const COIN_TESTS: [NewsScope, (text: string) => boolean][] = [
  ["BTC", (t) => /\b(bitcoin|btc)\b/i.test(t)],
  ["ETH", (t) => /\b(ethereum|ether|eth)\b/i.test(t)],
  ["SOL", (t) => /\bsolana\b/i.test(t) || /\bSOL\b/.test(t)],
];
const BROAD_RE = /\b(crypto(currenc\w*)?|digital assets?|market|markets|sec|cftc|fed|fomc|etf|stablecoins?|tether|usdt|usdc|binance|coinbase|exchanges?|regulat\w*|treasury|congress|senate)\b/i;

const sumMatches = (list: [RegExp, number][], text: string) => list.reduce((s, [re, w]) => s + (re.test(text) ? w : 0), 0);

export function scoreHeadline(h: Headline): ScoredHeadline {
  const title = h.title;
  const desc = (h.description ?? "").slice(0, 400);
  // The headline counts fully; the description only half, since it dilutes with background.
  const bull = sumMatches(BULLISH, title) + 0.5 * sumMatches(BULLISH, desc);
  const bear = sumMatches(BEARISH, title) + 0.5 * sumMatches(BEARISH, desc);
  const sentiment = Math.tanh((bull - bear) / 1.5);
  const risk = Math.min(1, Math.max(0, ...EVENT_RISK.map(([re, w]) => (re.test(title) ? w : 0))));
  const scopes: NewsScope[] = [];
  const text = `${title} ${desc}`;
  for (const [scope, test] of COIN_TESTS) if (test(title) || test(desc.slice(0, 160))) scopes.push(scope);
  if (BROAD_RE.test(title)) scopes.push("MARKET");
  return { ...h, scopes: text.trim() ? scopes : [], sentiment: +sentiment.toFixed(3), risk };
}

// ───────────────────────── RSS ─────────────────────────

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);
}

// CDATA wrapper off, entities decoded (feeds escape HTML inside descriptions), then tags removed.
const unwrap = (s: string) => decodeEntities(s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")).replace(/<\/?[a-z][^>]*>/gi, " ").replace(/\s+/g, " ").trim();

/** Items of an RSS 2.0 feed. Items without a title or a valid date are dropped. */
export function parseRss(xml: string, source: string): Headline[] {
  const out: Headline[] = [];
  for (const m of xml.matchAll(/<item[\s>][\s\S]*?<\/item>/g)) {
    const item = m[0];
    const tag = (name: string) => item.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"))?.[1];
    const title = tag("title");
    const date = tag("pubDate") ?? tag("dc:date");
    if (!title || !date) continue;
    const at = Date.parse(unwrap(date));
    if (!Number.isFinite(at)) continue;
    out.push({ title: unwrap(title), description: tag("description") ? unwrap(tag("description")!).slice(0, 500) : undefined, source, at });
  }
  return out;
}

// ───────────────────────── Aggregation ─────────────────────────

const SCOPES: NewsScope[] = ["BTC", "ETH", "SOL", "MARKET"];
const normTitle = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 70);

export function aggregateNews(headlines: Headline[], now: number): Record<NewsScope, ScopeNews> {
  const seen = new Set<string>();
  const scored = headlines
    .filter((h) => now - h.at <= NEWS.windowMs && h.at <= now + 5 * 60_000)
    .sort((a, b) => b.at - a.at)
    .filter((h) => {
      const k = normTitle(h.title);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .map(scoreHeadline);
  const out = {} as Record<NewsScope, ScopeNews>;
  for (const scope of SCOPES) {
    let s = 0;
    let r = 0;
    const rows = scored
      .filter((h) => h.scopes.includes(scope))
      .map((h) => {
        const w = 0.5 ** (Math.max(0, now - h.at) / NEWS.halfLifeMs);
        s += h.sentiment * w;
        r += h.risk * w;
        return { h, impact: (Math.abs(h.sentiment) + h.risk) * w };
      });
    out[scope] = {
      score: +Math.tanh(s / 2).toFixed(3),
      risk: +(1 - Math.exp(-r)).toFixed(3),
      n: rows.length,
      top: rows
        .sort((a, b) => b.impact - a.impact)
        .slice(0, 3)
        .map(({ h }) => ({ title: h.title, source: h.source, at: h.at, sentiment: h.sentiment, risk: h.risk })),
    };
  }
  return out;
}

export type FetchLike = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export async function fetchNews(fetchFn: FetchLike, now: number): Promise<NewsState> {
  const headers = { "User-Agent": "Mozilla/5.0 (compatible; uptrade-bot)", Accept: "application/rss+xml, application/xml, text/xml, application/json" };
  const sources: string[] = [];
  const errors: string[] = [];
  const all: Headline[] = [];
  await Promise.all(
    FEEDS.map(async (f) => {
      try {
        const res = await fetchFn(f.url, { signal: AbortSignal.timeout(8000), headers });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const items = parseRss(await res.text(), f.name);
        if (!items.length) throw new Error("no items");
        all.push(...items);
        sources.push(f.name);
      } catch (e) {
        errors.push(`${f.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }),
  );
  let fng: NewsState["fng"] = null;
  try {
    const res = await fetchFn("https://api.alternative.me/fng/?limit=1", { signal: AbortSignal.timeout(8000), headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = JSON.parse(await res.text()) as { data?: { value?: string; value_classification?: string }[] };
    const v = Number(j.data?.[0]?.value);
    if (Number.isFinite(v)) fng = { value: v, label: j.data?.[0]?.value_classification ?? "" };
    sources.push("Fear & Greed");
  } catch (e) {
    errors.push(`Fear & Greed: ${e instanceof Error ? e.message : String(e)}`);
  }
  return { fetchedAt: now, fng, sources, errors, scopes: aggregateNews(all, now) };
}

// ───────────────────────── The gate ─────────────────────────

export interface NewsReading {
  /** −1 … +1 for the coin (plus half the market's), not signed by direction. */
  score: number;
  /** 0 … 1 */
  risk: number;
  fng: number | null;
  /** Headline behind the biggest move, for the journal. */
  why: string | null;
}

/** News for one symbol such as "BTCUSDT": the coin's own news plus half the market's. Null when the reading is missing or stale. */
export function newsFor(news: NewsState | null | undefined, symbol: string, now: number): NewsReading | null {
  if (!news || now - news.fetchedAt > NEWS.staleMs) return null;
  const coin = symbol.replace(/USDT$/, "") as NewsScope;
  const c = news.scopes[coin] ?? news.scopes.MARKET;
  const m = news.scopes.MARKET;
  if (!c || !m) return null;
  const score = Math.max(-1, Math.min(1, c.score + (c === m ? 0 : 0.5 * m.score)));
  const risk = Math.max(c.risk, 0.8 * m.risk);
  const lead = [...c.top, ...m.top].sort((a, b) => Math.abs(b.sentiment) + b.risk - (Math.abs(a.sentiment) + a.risk))[0];
  return { score: +score.toFixed(3), risk: +risk.toFixed(3), fng: news.fng?.value ?? null, why: lead ? `"${lead.title}" (${lead.source})` : null };
}

/** Numbers stored with the trade, so the learner can test whether news mattered. */
export function newsReadings(r: NewsReading | null): Record<string, number> {
  if (!r) return {};
  const out: Record<string, number> = { newsScore: r.score, newsRisk: r.risk };
  if (r.fng != null) out.fng = r.fng;
  return out;
}

/** The "+ News" rule. `r` null (feed down or stale) never blocks, but the bot says so. */
export function newsGate(r: NewsReading | null, side: Side): { block: boolean; reason: string } {
  if (!r) return { block: false, reason: "No fresh news reading: traded on the indicators alone." };
  if (r.risk >= NEWS.riskBlock)
    return { block: true, reason: `High-impact news is fresh (event risk ${r.risk.toFixed(2)}${r.why ? `, ${r.why}` : ""}): waiting for the market to settle.` };
  const signed = (side === "long" ? 1 : -1) * r.score;
  if (signed <= -NEWS.sentimentBlock)
    return { block: true, reason: `Crypto news leans against this ${side} (${signed.toFixed(2)}${r.why ? `, ${r.why}` : ""}).` };
  return { block: false, reason: `News is no obstacle (sentiment ${signed >= 0 ? "+" : ""}${signed.toFixed(2)} for this ${side}, event risk ${r.risk.toFixed(2)}).` };
}
