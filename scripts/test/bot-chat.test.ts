import { test } from "node:test";
import assert from "node:assert/strict";
import { buildContext, geminiAnswer, geminiBody, MAX_TURNS, trimHistory, type ChatData } from "../../supabase/functions/_shared/bot/chat.ts";

const report = (kind: string, created: string, extra: Record<string, unknown> = {}) => ({
  kind,
  period_start: "2026-10-23T00:00:00Z",
  period_end: "2026-10-24T00:00:00Z",
  created_at: created,
  data: { period: { trades: 3 }, setups: [{ strategy: kind }], rankings: { best: [] }, timing: {}, mistakes: { period: [], allTime: [{ category: "chop" }], bySetup: [], examples: [] }, ...extra },
  narrative: { headline: `${kind} headline` },
});

test("chat context: all-time stats from the freshest report only, plus each report's own period", () => {
  const d: ChatData = {
    reports: [report("daily", "2026-10-24T00:07:00Z"), report("hourly", "2026-10-24T05:07:00Z")],
    lessons: [{ id: "x", strategy: "donchian", timeframe: "5m", title: "skip", explanation: "e", status: "active", blocked: 3, blocked_r: -2.5, evidence: { big: true } }],
    trades: [{ strategy: "donchian", timeframe: "5m", r_multiple: -1, review: { title: "False signal", why: "w", fix: "f", flags: [], mfeR: 0.1 } }],
    openTrades: [],
    strategies: [{ key: "donchian", name: "Donchian Breakout", summary: "s", params: {} }],
  };
  const ctx = JSON.parse(buildContext(d, Date.UTC(2026, 9, 24, 6)));
  assert.deepEqual(ctx.allTime.setups, [{ strategy: "hourly" }], "the hourly report is fresher");
  assert.equal(ctx.allTimeAsOf, "2026-10-24T05:07:00Z");
  assert.deepEqual(ctx.reports.map((r: { kind: string }) => r.kind), ["hourly", "daily"]);
  assert.equal(ctx.reports[1].writeUp.headline, "daily headline");
  assert.equal(ctx.lessons[0].evidence, undefined, "bulky evidence is left out");
  assert.equal(ctx.lessons[0].blocked_r, -2.5);
  assert.deepEqual(ctx.recentClosedTrades[0].review, { title: "False signal", why: "w", fix: "f", flags: [] });
});

test("chat history is trimmed, starts with a question and maps to Gemini roles", () => {
  const long = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", text: `m${i}` }) as const);
  const h = trimHistory([...long, { role: "user", text: "x".repeat(5000) }]);
  assert.ok(h.length <= MAX_TURNS);
  assert.equal(h[0].role, "user");
  assert.equal(h[h.length - 1].text.length, 2000);
  assert.deepEqual(trimHistory([{ role: "assistant", text: "hi" }, { role: "user", text: " " }]), []);

  const body = geminiBody("{}", [{ role: "user", text: "q" }, { role: "assistant", text: "a" }, { role: "user", text: "q2" }]);
  assert.deepEqual(body.contents.map((c) => c.role), ["user", "model", "user"]);
  assert.match(body.system_instruction.parts[0].text, /DATA \(JSON\):\n\{\}$/);
});

test("Gemini replies: text, thoughts skipped, limits and blocks explained", () => {
  assert.deepEqual(geminiAnswer(200, { candidates: [{ content: { parts: [{ text: "plan", thought: true }, { text: "Answer" }] }, finishReason: "STOP" }] }), { text: "Answer" });
  assert.match((geminiAnswer(429, { error: { code: 429, status: "RESOURCE_EXHAUSTED" } }) as { error: string }).error, /free-tier limit/);
  assert.match((geminiAnswer(400, { error: { code: 400, message: "bad model" } }) as { error: string }).error, /bad model/);
  assert.match((geminiAnswer(200, { promptFeedback: { blockReason: "SAFETY" } }) as { error: string }).error, /SAFETY/);
  assert.match((geminiAnswer(200, { candidates: [{ finishReason: "RECITATION" }] }) as { error: string }).error, /RECITATION/);
  assert.match((geminiAnswer(200, { candidates: [{ content: { parts: [{ text: "part" }] }, finishReason: "MAX_TOKENS" }] }) as { text: string }).text, /cut off/);
});
