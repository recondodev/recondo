/**
 * Prompt — `monitor_anomalies`.
 *
 * Drives the agent to poll `recondo_anomalies` on a non-aggressive
 * cadence and surface new entries to the developer. The body calls
 * out the recommended polling cadence (30 seconds minimum) and
 * explains why — anomalies are a non-urgent monitoring surface, not a
 * real-time pager, and tighter polling burns context window for no
 * additional value.
 */
import type { PromptDefinition, PromptRenderResult } from "./types.js";
import { userMessage } from "./types.js";

const BODY = `You are monitoring Recondo's anomaly stream on the developer's behalf.

Call \`recondo_anomalies\` to fetch the most recent anomaly events. Use tool: \`recondo_anomalies\`, args: \`{"limit":20}\`, and review every entry the tool returns.

**Polling cadence — minimum 30 seconds between calls.** This is the recommended minimum cadence for the following reasons:
- Anomaly detection is a non-urgent monitoring surface; new anomalies do not need sub-minute latency.
- Each \`recondo_anomalies\` call burns context-window budget, so a polling cadence tighter than 30 seconds wastes the developer's tokens with no monitoring benefit.
- The data layer aggregates anomalies in 30-second-and-larger buckets upstream, so anything below 30s reads the same row twice.

If you are running in a loop, sleep at least 30 seconds between polls; do NOT call the tool back-to-back.

For each anomaly returned, summarise:
- **Anomaly id, type, and severity** verbatim from the tool response.
- **Affected session / turn** if the anomaly references one (link via \`recondo://session/<id>\`).
- **Recommended action** — call out whether the anomaly looks like a transient spike vs a sustained pattern.

Never invent anomalies the tool did not return.`;

export const monitorAnomalies: PromptDefinition = {
  name: "monitor_anomalies",
  description:
    "Poll recondo_anomalies on a 30-second minimum cadence and surface new anomaly events to the developer.",
  async render(): Promise<PromptRenderResult> {
    return { messages: [userMessage(BODY)] };
  },
};
