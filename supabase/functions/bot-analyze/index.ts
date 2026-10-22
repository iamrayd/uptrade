// UpTrade bot analysis: reviews closed trades, learns entry filters from losers, and writes
// hourly/daily/weekly/monthly reports. pg_cron calls this every hour (see supabase/bot_cron.sql).
//
// Deploy:   supabase functions deploy bot-analyze --no-verify-jwt
// Secrets:  BOT_CRON_SECRET (same as bot-tick), and optionally ANTHROPIC_API_KEY for the
//           AI write-up. Without a key, reports use the built-in template; everything
//           else (rankings, reviews, learning) works the same.
//           AI_REPORT_KINDS: comma-separated kinds that get the AI write-up (default "daily,weekly,monthly").
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase automatically.

import { runAnalysis } from "../_shared/bot/analyze.ts";
import { claudeNarrator } from "../_shared/bot/ai.ts";
import { binanceMarket, restAnalysisDb } from "../_shared/bot/io.ts";
import { REPORT_KINDS, type ReportKind } from "../_shared/bot/analysis.ts";

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

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  const kinds = (Deno.env.get("AI_REPORT_KINDS") ?? "daily,weekly,monthly")
    .split(",")
    .map((k) => k.trim())
    .filter((k): k is ReportKind => (REPORT_KINDS as string[]).includes(k));
  try {
    const summary = await runAnalysis({ market: binanceMarket, db: restAnalysisDb(url, key), narrator: apiKey ? claudeNarrator(apiKey) : null, aiKinds: kinds });
    return Response.json(summary);
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
});
