// UpTrade crypto-news reader: fetches public RSS headlines + the Fear & Greed index, scores them and
// stores the result for the bots. pg_cron calls this every 10 minutes (see supabase/bot_cron.sql).
// The "+ News" strategies read it; every bot records it with its trades so the learner can test
// whether news mattered. No API key is needed.
//
// Deploy:   supabase functions deploy bot-news --no-verify-jwt
// Secret:   BOT_CRON_SECRET (same as bot-tick).
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase automatically.

import { fetchNews } from "../_shared/bot/news.ts";
import { restNewsDb } from "../_shared/bot/io.ts";

declare const Deno: {
  env: { get(name: string): string | undefined };
  serve(handler: (req: Request) => Response | Promise<Response>): void;
};

/** Constant-time string compare. */
function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async (req) => {
  const secret = Deno.env.get("BOT_CRON_SECRET");
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!secret || !url || !key) return Response.json({ error: "BOT_CRON_SECRET / SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set" }, { status: 500 });
  if (!safeEqual(req.headers.get("x-bot-secret") ?? "", secret)) return Response.json({ error: "unauthorized" }, { status: 401 });

  try {
    const news = await fetchNews((u, init) => fetch(u, init), Date.now());
    // Every feed down: keep the last good read (it ages out on its own) instead of overwriting it with nothing.
    if (!news.sources.length) return Response.json({ saved: false, errors: news.errors }, { status: 502 });
    await restNewsDb(url, key).saveNews(news);
    return Response.json({ saved: true, sources: news.sources, errors: news.errors, fng: news.fng, scopes: Object.fromEntries(Object.entries(news.scopes).map(([k, v]) => [k, { score: v.score, risk: v.risk, n: v.n }])) });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
});
