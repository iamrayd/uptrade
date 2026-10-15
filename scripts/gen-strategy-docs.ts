// Writes docs/strategies/<key>.md from the strategy definitions, so the docs
// always match the code the bot runs.   npm run docs:strategies

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { STRATEGIES } from "../supabase/functions/_shared/bot/strategies.ts";
import { TIMEFRAMES } from "../supabase/functions/_shared/bot/types.ts";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "strategies");

for (const s of STRATEGIES) {
  const md = [
    `# ${s.name} (\`${s.key}\` v${s.version})`,
    "",
    `> Generated from \`supabase/functions/_shared/bot/strategies.ts\`. Don't edit by hand; run \`npm run docs:strategies\`.`,
    "",
    s.summary,
    "",
    `**Timeframes:** ${TIMEFRAMES.join(", ")}. Each timeframe is its own $100 account trading BTC, ETH and SOL, at most one position per coin.`,
    "",
    s.rules,
    "",
    "## Parameters",
    "",
    "| Name | Value |",
    "|---|---|",
    ...Object.entries(s.params).map(([k, v]) => `| ${k} | ${v} |`),
    "",
    `Warm-up: ${s.warmup} closed bars before the first signal.`,
    "",
    "## Shared rules (all strategies)",
    "",
    "See [README.md](README.md#risk-management-shared-by-every-strategy).",
    "",
  ].join("\n");
  writeFileSync(join(OUT, `${s.key}.md`), md);
  console.log(`wrote docs/strategies/${s.key}.md`);
}
