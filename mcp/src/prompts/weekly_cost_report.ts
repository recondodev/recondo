/**
 * Prompt — `weekly_cost_report` (gated on `--allow-actions`).
 *
 * Drives the agent to produce a SOC 2-style weekly cost report by
 * calling `recondo_generate_report` (an action tool — mutates the
 * `reports` table). Because it triggers a mutation, the prompt is
 * annotated with `requiresAction: true` so the server bootstrap can
 * gate its registration.
 */
import type { PromptDefinition, PromptRenderResult } from "./types.js";
import { userMessage } from "./types.js";

const BODY = `You are generating a weekly cost-and-coverage compliance report for SOC 2 attestation evidence.

Call \`recondo_generate_report\` with the following arguments to materialise a new report row:
- \`name\`: a human-readable label such as "Weekly cost & coverage — <ISO week>".
- \`framework\`: \`"soc2"\` (the canonical default).
- \`period_start\` / \`period_end\`: the trailing-7-days window in ISO-8601 format (e.g. \`2026-04-30T00:00:00Z\` to \`2026-05-07T00:00:00Z\`).

This is an **action**: it mutates the \`reports\` table by inserting a new report record. Confirm the mutation succeeded by reading back the returned report id, then summarise:
- **Report metadata** — the id, name, and period.
- **Coverage** — the capture_count and findings counts from the response.
- **Next steps** — link to \`recondo://reports/<id>\` so the developer can read the full report via the resource fetcher.

If \`recondo_generate_report\` fails (e.g. the action gate is closed), surface the error verbatim — do NOT pretend the report was generated.`;

export const weeklyCostReport: PromptDefinition = {
  name: "weekly_cost_report",
  description:
    "Generate a weekly SOC 2 cost-and-coverage report via recondo_generate_report. Gated on --allow-actions because it mutates the reports table.",
  requiresAction: true,
  async render(): Promise<PromptRenderResult> {
    return { messages: [userMessage(BODY)] };
  },
};
