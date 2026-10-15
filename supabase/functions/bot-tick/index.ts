// UpTrade strategy bots: one run per call. pg_cron calls this every minute (see supabase/bot_cron.sql).
//
// Deploy:   supabase functions deploy bot-tick --no-verify-jwt
// Secret:   supabase secrets set BOT_CRON_SECRET=<long random string>
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase automatically.

import { runTick } from "../_shared/bot/tick.ts";
import { binanceMarket, restDb } from "../_shared/bot/io.ts";

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
    const summary = await runTick({ market: binanceMarket, db: restDb(url, key) });
    return Response.json(summary);
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
});
