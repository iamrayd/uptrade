import Anthropic from "@anthropic-ai/sdk";
import type { Narrative, Narrator } from "./analyze.ts";

// Writes the analysis report with Claude. The numbers (stats, rankings, mistakes) are all
// computed in analysis.ts. Claude only interprets them and coaches each rule set on its
// mistakes. Nothing it writes changes what the bots trade.

export const AI_MODEL = "claude-opus-5-5";

const SYSTEM = `You are the performance analyst for a set of crypto paper-trading bots. Each bot is one rule set (for example Fair Value Gap or Order Block) on one timeframe, with its own $100 account. Every signal of a rule set is traded: there is no filter between a signal and an order. The owner is running a 2 to 4 week trial of five rule sets and will then drop the weak ones and improve the strong ones. You get a report computed from the closed trades and write the analysis the owner reads to make that decision.

How to work:
- Only state facts that are in the data. Quote the numbers you rely on (trades, win rate, R, PF, drawdown, verdict). Never invent trades or statistics.
- Treat small samples as unproven. A setup with under 30 trades, or whose lcbRSlip is not positive, is not proven, however high its return. Say so plainly.
- "strategies" is each rule set over all its timeframes: lead with it. Say which rule sets are ahead, which are behind, and whether the sample is large enough to drop or keep one yet.
- Rank for real trading: prefer edge that survives slippage (avgRSlip, lcbRSlip), consistency (positiveWeeksPct) and shallow drawdowns over raw return.
- For mistakes, explain why the entries failed using the review categories and examples, then give concrete, testable changes to the rule set: a parameter, a stop or target rule, a timeframe to drop. Tie each one to the rule set's actual rules.
- Write in plain, direct English for a trader. Keep each paragraph or item to one to three sentences.`;

const str = { type: "string" } as const;
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["headline", "summary", "ranking_notes", "mistakes", "improvements", "caveats"],
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
    return { narrative: JSON.parse(text) as Narrative, model: response.model };
  };
}
