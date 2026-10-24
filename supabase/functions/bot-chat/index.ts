// UpTrade analysis chatbot. The app calls this with the signed-in user's session; it reads
// that user's own reports, lessons and trades (row-level security applies) and asks Gemini.
//
// Deploy:   supabase functions deploy bot-chat        (keep JWT verification ON: only signed-in users)
// Secrets:  GEMINI_API_KEY  (free key from https://aistudio.google.com/apikey)
//           GEMINI_MODEL    optional, default "gemini-flash-latest"
// SUPABASE_URL and SUPABASE_ANON_KEY are provided by Supabase automatically.

import { buildContext, geminiAnswer, geminiBody, trimHistory, type ChatData, type ChatMessage } from "../_shared/bot/chat.ts";

declare const Deno: {
  env: { get(name: string): string | undefined };
  serve(handler: (req: Request) => Response | Promise<Response>): void;
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
// App-level failures come back as 200 + {error} so the app can show the message as-is.
const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: CORS });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return reply({ error: "POST only" }, 405);

  const url = Deno.env.get("SUPABASE_URL");
  const anon = Deno.env.get("SUPABASE_ANON_KEY");
  const key = Deno.env.get("GEMINI_API_KEY");
  const model = Deno.env.get("GEMINI_MODEL") ?? "gemini-flash-latest";
  if (!url || !anon) return reply({ error: "SUPABASE_URL / SUPABASE_ANON_KEY not set" }, 500);
  if (!key) return reply({ error: "The chatbot isn't set up: run `npx supabase secrets set GEMINI_API_KEY=...` (see docs/strategies/ANALYSIS.md)." });

  const auth = req.headers.get("Authorization") ?? "";
  const headers = { apikey: anon, Authorization: auth };
  const user = await fetch(`${url}/auth/v1/user`, { headers });
  if (!user.ok) return reply({ error: "Not signed in" }, 401);

  let messages: ChatMessage[];
  try {
    messages = trimHistory(((await req.json()) as { messages?: ChatMessage[] }).messages ?? []);
  } catch {
    return reply({ error: "Bad request" }, 400);
  }
  if (!messages.length || messages[messages.length - 1].role !== "user") return reply({ error: "Ask a question first." }, 400);

  // The user's own rows only: these requests carry the user's session, so row-level security applies.
  const get = async <T>(path: string): Promise<T> => {
    const res = await fetch(`${url}/rest/v1/${path}`, { headers });
    if (!res.ok) throw new Error(`${path.split("?")[0]}: ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  };
  let data: ChatData;
  try {
    const latest = (kind: string) =>
      get<ChatData["reports"]>(`bot_reports?select=kind,period_start,period_end,created_at,data,narrative&kind=eq.${kind}&order=period_start.desc&limit=1`);
    const [hourly, daily, weekly, monthly, lessons, trades, openTrades, strategies] = await Promise.all([
      latest("hourly"),
      latest("daily"),
      latest("weekly"),
      latest("monthly"),
      get<ChatData["lessons"]>("bot_lessons?select=*&order=created_at.desc&limit=50"),
      get<ChatData["trades"]>(
        "bot_trades?select=strategy,timeframe,symbol,side,opened_at,closed_at,exit_reason,r_multiple,net_pnl,entry_reason,review&status=eq.closed&order=closed_at.desc&limit=40",
      ),
      get<ChatData["openTrades"]>("bot_trades?select=strategy,timeframe,symbol,side,entry_price,stop_price,take_profit,opened_at&status=eq.open"),
      get<ChatData["strategies"]>("bot_strategies?select=key,name,summary,params"),
    ]);
    data = { reports: [...hourly, ...daily, ...weekly, ...monthly], lessons, trades, openTrades, strategies };
  } catch (e) {
    return reply({ error: `Couldn't load the analysis: ${e instanceof Error ? e.message : String(e)}` });
  }
  if (!data.reports.length) return reply({ error: "There's no analysis report yet. The first one is written within an hour of setting up bot-analyze." });

  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify(geminiBody(buildContext(data), messages)),
      signal: AbortSignal.timeout(90_000),
    });
    const body = await res.json().catch(() => ({}));
    const out = geminiAnswer(res.status, body);
    return reply("text" in out ? { reply: out.text, model } : out);
  } catch (e) {
    return reply({ error: `Gemini didn't answer: ${e instanceof Error ? e.message : String(e)}` });
  }
});
