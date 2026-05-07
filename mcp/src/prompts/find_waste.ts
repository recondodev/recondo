/**
 * Prompt — `find_waste`.
 *
 * Drives the agent to surface duplicated / redundant prompt traffic
 * via `recondo_find_similar_prompts`. The body explicitly calls out
 * the v1 detection limitation (Risk #4 from Plan D's spec): the
 * underlying matcher is **exact-match only** on the prompt-hash —
 * byte-identical user requests are detected, but semantic
 * near-duplicates (paraphrases, whitespace differences) are NOT.
 * This is captured here so the agent doesn't over-promise to the
 * developer when the tool returns no matches.
 */
import type { PromptDefinition, PromptRenderResult } from "./types.js";
import { userMessage } from "./types.js";

const BODY = `You are hunting for duplicated, wasted, or redundant prompt traffic that the developer could deduplicate or cache.

Call \`recondo_find_similar_prompts\` to retrieve groups of repeat prompts in the recent activity window. Pass \`{"period": "last_7_days", "min_repeats": 2}\` (or the equivalent default range if no period argument is exposed).

Important caveat — surface this in your reply: the v1 similarity matcher is **exact-match only** on the prompt hash. It detects byte-identical user requests; near-duplicates (paraphrases, trailing whitespace, different line endings) will NOT be flagged. If the tool returns no matches, that means there were no byte-identical repeats, NOT that the developer's prompts are necessarily unique.

Format the response as:
- **Summary** — the count of repeat-prompt groups returned by the tool.
- **Top offenders** — for each group, list the prompt fingerprint, the repeat count, and the estimated wasted spend.
- **Caveats** — re-state the exact-match-only limitation so the developer knows what the absence of matches means.

Do not invent groups or estimate spend the tool didn't return.`;

export const findWaste: PromptDefinition = {
  name: "find_waste",
  description:
    "Surface duplicated or redundant prompt traffic via recondo_find_similar_prompts; explicitly flags the v1 exact-match-only limitation.",
  async render(): Promise<PromptRenderResult> {
    return { messages: [userMessage(BODY)] };
  },
};
