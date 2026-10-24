// The analysis chatbot: builds what Gemini sees from the owner's own analysis data,
// and the generateContent request. Pure functions; I/O lives in bot-chat/index.ts.

export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
}

/** Everything the chatbot may draw on, already limited to one user's rows (RLS). */
export interface ChatData {
  /** Latest report of each kind (any may be missing). */
  reports: { kind: string; period_start: string; period_end: string; created_at: string; data: Record<string, unknown>; narrative: unknown }[];
  lessons: Record<string, unknown>[];
  /** Recent closed trades, newest first. */
  trades: Record<string, unknown>[];
  openTrades: Record<string, unknown>[];
  strategies: { key: string; name: string; summary: string; params: unknown }[];
}

/** Turns of history sent along with each question. */
export const MAX_TURNS = 12;
export const MAX_QUESTION_CHARS = 2000;

export const SYSTEM = `You are the analysis assistant inside UpTrade, a crypto paper-trading app. The owner runs strategy bots: 5 strategies × 6 timeframes, each a separate $100 paper account trading BTC/ETH/SOL, risking 2% per trade. An hourly job reviews every closed trade, ranks the setups and learns "lessons" (entry filters). You answer the owner's questions about that analysis.

Rules:
- Answer only from the DATA below. Quote the numbers you use (trades, R, win rate, PF, drawdown, verdicts). If the data doesn't contain the answer, say so and say what would answer it. Never invent trades, statistics or lessons.
- R = net PnL ÷ planned risk. "Slip" figures include an extra 0.05% slippage per side. lcbR is the 95% lower confidence bound of mean R. A setup needs 30+ trades and a positive lcbRSlip before its edge is more than luck; say so when a sample is small.
- Lessons are learned on the oldest 70% of a setup's trades and must hold on the newest 30% plus a t-test; a lesson is retired if the signals it blocked would have made money. Few lessons early on is expected.
- This is paper trading. Don't promise profits. You may say which setups look strongest for a small live test and why, with the caveats.
- Be concise and direct: short paragraphs, "- " bullet lists, **bold** for key numbers. No headings, no tables, no code blocks.
- Times in the data are UTC.`;

const pick = (o: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.filter((k) => o[k] != null).map((k) => [k, o[k]]));

/** A compact JSON of the analysis. The all-time sections come from the freshest report only, so they aren't repeated per report. */
export function buildContext(d: ChatData, now = Date.now()): string {
  const byFresh = [...d.reports].sort((a, b) => +new Date(b.created_at) - +new Date(a.created_at));
  const latest = byFresh[0];
  const allTime = latest
    ? pick(latest.data, ["setups", "rankings", "timing"])
    : null;
  const mistakes = latest ? (latest.data.mistakes as Record<string, unknown> | undefined) : undefined;
  return JSON.stringify({
    now: new Date(now).toISOString(),
    strategies: d.strategies.map((s) => ({ key: s.key, name: s.name, summary: s.summary, params: s.params })),
    allTimeAsOf: latest?.created_at ?? null,
    allTime,
    allTimeMistakes: mistakes ? pick(mistakes, ["allTime", "bySetup"]) : null,
    reports: byFresh.map((r) => ({
      kind: r.kind,
      period: `${r.period_start} → ${r.period_end}`,
      results: r.data.period,
      mistakesThisPeriod: (r.data.mistakes as Record<string, unknown> | undefined)?.period,
      worstLosers: (r.data.mistakes as Record<string, unknown> | undefined)?.examples,
      writeUp: r.narrative,
    })),
    lessons: d.lessons.map((l) =>
      pick(l, ["strategy", "timeframe", "title", "explanation", "status", "source", "blocked", "blocked_r", "retired_reason", "created_at"]),
    ),
    recentClosedTrades: d.trades.map((t) => ({
      ...pick(t, ["strategy", "timeframe", "symbol", "side", "opened_at", "closed_at", "exit_reason", "r_multiple", "net_pnl", "entry_reason"]),
      review: t.review ? pick(t.review as Record<string, unknown>, ["title", "why", "fix", "flags"]) : null,
    })),
    openTrades: d.openTrades.map((t) => pick(t, ["strategy", "timeframe", "symbol", "side", "entry_price", "stop_price", "take_profit", "opened_at"])),
  });
}

/** Keeps the last MAX_TURNS messages, starting with a user turn, each capped in length. */
export function trimHistory(messages: ChatMessage[]): ChatMessage[] {
  const clean = messages
    .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.text === "string" && m.text.trim())
    .map((m) => ({ role: m.role, text: m.text.slice(0, m.role === "user" ? MAX_QUESTION_CHARS : 6000) }));
  let out = clean.slice(-MAX_TURNS);
  while (out.length && out[0].role !== "user") out = out.slice(1);
  return out;
}

/** Body for Gemini's generateContent: the analysis goes in the system instruction, the chat in contents. */
export function geminiBody(context: string, history: ChatMessage[]) {
  return {
    system_instruction: { parts: [{ text: `${SYSTEM}\n\nDATA (JSON):\n${context}` }] },
    contents: history.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.text }] })),
    generationConfig: { maxOutputTokens: 2048 },
  };
}

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  error?: { code?: number; message?: string; status?: string };
}

/** Pulls the answer out of a generateContent response, or explains why there isn't one. */
export function geminiAnswer(status: number, body: GeminiResponse): { text: string } | { error: string } {
  if (status === 429 || body.error?.status === "RESOURCE_EXHAUSTED")
    return { error: "Gemini's free-tier limit is used up for now. Try again in a minute; the daily limit resets at midnight Pacific time." };
  if (status >= 400 || body.error) return { error: `Gemini error ${body.error?.code ?? status}: ${body.error?.message ?? "request failed"}` };
  if (body.promptFeedback?.blockReason) return { error: `Gemini declined the question (${body.promptFeedback.blockReason}).` };
  const cand = body.candidates?.[0];
  const text = (cand?.content?.parts ?? []).filter((p) => !p.thought && p.text).map((p) => p.text).join("").trim();
  if (!text) return { error: `Gemini returned no answer${cand?.finishReason ? ` (${cand.finishReason})` : ""}.` };
  return { text: cand?.finishReason === "MAX_TOKENS" ? `${text}\n\n(Answer cut off: ask a narrower question.)` : text };
}
