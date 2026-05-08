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

1. \`recondo_usage_summary\` — fetch top-line totals (sessions, turns, input/output tokens, total cost) for the trailing 7-day window. Use tool: \`recondo_usage_summary\`, args: \`{"period":"week"}\`.
2. \`recondo_top\` — fetch the top developers and repositories by usage so the digest can name names. Use tool: \`recondo_top\`, args: \`{"dimension":"developer","period":"week","limit":5}\`, then tool: \`recondo_top\`, args: \`{"dimension":"repository","period":"week","limit":5}\`.
3. \`recondo_list_sessions\` — fetch a small page of recent sessions before drilling into outliers. Use tool: \`recondo_list_sessions\`, args: \`{"limit":5}\`.
4. \`recondo_session_efficiency\` — fetch session-level efficiency metrics for any session id from the session list that looks unusually expensive or inefficient. Use tool: \`recondo_session_efficiency\`, args: \`{"session_id":"<session_id_from_recondo_list_sessions>"}\`.

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
