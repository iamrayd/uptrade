import Anthropic from "@anthropic-ai/sdk";
import type { Narrative, Narrator } from "./analyze.ts";

// Writes the analysis report with Claude. The numbers (stats, rankings, mistakes,
// lessons) are all computed in analysis.ts. Claude only interprets them, coaches each
// setup on its mistakes, and may suggest entry filters. A suggested filter is used only
// if it passes the same check on newer trades as the mined ones (analyze.ts).

export const AI_MODEL = "claude-opus-5-5";

const SYSTEM = `You are the performance analyst for a set of crypto paper-trading bots. Each bot is one strategy on one timeframe, with its own $100 account. You get a report computed from their closed trades and write the analysis the owner reads to decide which strategies could be used with real money and how the bots should improve.

How to work:
- Only state facts that are in the data. Quote the numbers you rely on (trades, R, PF, drawdown, verdict). Never invent trades or statistics.
- Treat small samples as unproven. A setup with under 30 trades, or whose lcbRSlip is not positive, is not proven, however high its return. Say so plainly.
- Rank for real trading: prefer edge that survives slippage (avgRSlip, lcbRSlip), consistency (positiveWeeksPct) and shallow drawdowns over raw return.
- For mistakes, explain why the entries failed using the review categories, flags and examples, then give concrete, testable fixes, such as a parameter change, a filter, or a different stop or exit rule. Tie each fix to the strategy's actual rules.
- The report's "learning" section shows whether the bots are improving: "impact" is the average R per trade before the first lesson switched on vs since, "tags" are the named mistakes ranked by the R they cost, "replayed" is what the signals the bots did not trade would have made, and "gate" compares the signals the indicator gate skipped with the trades it let through. Say plainly whether entries are getting better and by how much, and call it noise when fewer than 30 trades back it.
- A strategy whose key ends in _news is the news-aware twin of the plain strategy with the same trigger. Compare each twin with its original on the same timeframe before saying news helps.
- Features starting with mk_ are named entry mistakes (value "yes"); prefer them in candidate_filters when the mistakes data points to one.
- candidate_filters are entry filters the bots could learn ("skip entries when <feature> <op> <value>"). Use only features from filterFeatures and the setups in the data. Suggest at most 3, and only where the mistakes or timing data point to them; it is fine to suggest none. Use timeframe "" for every timeframe of a strategy. Each one is tested on newer trades before it is used.
- Write in plain, direct English for a trader. Keep each paragraph or item to one to three sentences.`;

const str = { type: "string" } as const;
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["headline", "summary", "ranking_notes", "mistakes", "improvements", "caveats", "candidate_filters"],
  properties: {
    headline: { type: "string", description: "One sentence: the most important takeaway of this period." },
    summary: { type: "array", items: str, description: "Two to four short paragraphs on the period and the overall state of the bots." },
    ranking_notes: { type: "array", items: str, description: "The best overall, most effective and highest-return setups, and whether each is fit for real trading." },
    mistakes: {
      type: "array",
      items: { type: "object", additionalProperties: false, required: ["title", "detail"], properties: { title: str, detail: str } },
      description: "The main reasons entries failed, with the evidence.",
    },
    improvements: {
      type: "array",
      items: { type: "object", additionalProperties: false, required: ["scope", "action", "rationale"], properties: { scope: str, action: str, rationale: str } },
      description: "Concrete changes per strategy/timeframe (scope), what to do (action) and why (rationale).",
    },
    caveats: { type: "array", items: str },
    candidate_filters: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["strategy", "timeframe", "feature", "op", "value", "reason"],
        properties: {
          strategy: str,
          timeframe: { type: "string", description: 'A timeframe such as "1h", or "" for every timeframe.' },
          feature: str,
          op: { type: "string", enum: ["lt", "gte", "eq"] },
          value: { type: "string", description: "A number for numeric features, or the category value." },
          reason: str,
        },
      },
    },
  },
};

export function claudeNarrator(apiKey: string, model = AI_MODEL): Narrator {
  // Edge functions have a time limit, so give up rather than run past it; the report falls back to the template.
  const client = new Anthropic({ apiKey, timeout: 110_000, maxRetries: 1 });
  return async ({ kind, data, context }) => {
    const response = await client.beta.messages.create({
      model,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium", format: { type: "json_schema", schema: SCHEMA } },
      system: SYSTEM,
      messages: [
        {
          role: "user",
          content: `Background:\n${JSON.stringify(context)}\n\nThe ${kind} report (computed data, times in UTC):\n${JSON.stringify(data)}\n\nWrite the ${kind} analysis.`,
        },
      ],
    });
    if (response.stop_reason === "refusal") throw new Error("Claude declined to write this report");
    if (response.stop_reason === "max_tokens") throw new Error("Claude's report was cut off (max_tokens)");
    const text = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    const parsed = JSON.parse(text) as Narrative;
    parsed.candidate_filters = (parsed.candidate_filters ?? []).map((c) => ({ ...c, timeframe: c.timeframe ? c.timeframe : null }));
    return { narrative: parsed, model: response.model };
  };
}
