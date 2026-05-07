/**
 * Prompt — `summarize_my_week`.
 *
 * Drives the agent to produce a developer-facing weekly summary by
 * orchestrating the canonical read tools: `recondo_usage_summary`
 * (top-line tokens + cost), `recondo_top` (top developers /
 * repositories), and `recondo_session_efficiency` (per-session
 * outliers). This prompt is read-only, so it ships unconditionally.
 */
import type { PromptDefinition, PromptRenderResult } from "./types.js";
import { userMessage } from "./types.js";

const BODY = `You are summarising the past 7 days of agentic LLM activity for the developer.

Call the following Recondo MCP tools, in order, and combine their outputs into a concise weekly digest:

1. \`recondo_usage_summary\` — fetch top-line totals (sessions, turns, input/output tokens, total cost) for the trailing 7-day window. Pass \`{"period": "last_7_days"}\` (or omit \`period\` if the tool defaults to that).
2. \`recondo_top\` — fetch the top developers and repositories by usage so the digest can name names. Pass \`{"period": "last_7_days", "limit": 5}\`.
3. \`recondo_session_efficiency\` — fetch session-level efficiency metrics so the digest can flag outliers. Pass \`{"period": "last_7_days"}\` and call out any sessions with abnormally low efficiency.

Combine the results into a markdown digest with the following sections:
- **Headline numbers** — total sessions, turns, tokens, and dollars from \`recondo_usage_summary\`.
- **Top contributors** — leaderboard from \`recondo_top\`.
- **Outliers worth investigating** — sessions with low efficiency from \`recondo_session_efficiency\`.

Keep the digest under 400 words. Do not invent numbers — every figure must come from a tool response.`;

export const summarizeMyWeek: PromptDefinition = {
  name: "summarize_my_week",
  description:
    "Produce a developer-facing weekly digest of agentic LLM activity by orchestrating recondo_usage_summary, recondo_top, and recondo_session_efficiency.",
  async render(): Promise<PromptRenderResult> {
    return { messages: [userMessage(BODY)] };
  },
};
