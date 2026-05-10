/**
 * `recondo_tool_call_stats` — paginated tool-call statistics grouped
 * by tool name, session, or framework.
 *
 * Wraps the data-layer `toolCallStats(options)` AsyncIterable. The
 * data-layer signature is intentionally a single options bag (NOT the
 * 3-arg `(apiKey, args, options)` pattern) — see
 * `packages/recondo-data/src/tool-call-stats.ts`. The handler iterates
 * with `for await`, projects rows into the canonical 5-key list
 * envelope, and runs the result through `enforceListBudget`.
 *
 * Period translation: the MCP surface exposes day/week/month and
 * translates to the data-layer enum (`24h`/`7d`/`30d`). The data-layer
 * `ToolCallPeriod` does include `"all"` and `"quarter"`, but this tool
 * deliberately drops `"quarter"` from its enum — there is no honest
 * 90-day bucket in the data layer, and silently broadening to `"all"`
 * is a contract violation. Callers wanting the full window omit
 * `period`, which maps to the data-layer `"all"`.
 *
 * Plan D drift pin: the data-layer `ToolCallStatsRow` type does NOT
 * carry the legacy token-cost field — duration is the honest scalar.
 * The handler surfaces `total_duration_ms` verbatim and never
 * fabricates the legacy column on the wire.
 *
 * Pagination: the handler drains `limit + offset` rows from the
 * underlying iterable BEFORE slicing by offset. Slicing first by limit
 * and then by offset (the historical bug) returned an empty page when
 * `offset >= limit`. The current implementation pulls
 * `(offset ?? 0) + (limit ?? Infinity)` rows, slices `[offset, offset
 * + limit)`, and lets `enforceListBudget` compute the next-offset
 * cursor relative to the original offset.
 *
 * `ctx.abortSignal` is threaded into the data-layer options bag.
 */

import { toolCallStats } from "@recondo/data";
import type {
  ToolCallGroupBy,
  ToolCallPeriod,
  ToolCallStatsRow,
} from "@recondo/data";
import { z } from "zod";

import { buildListEnvelope } from "../envelope/list.js";
import { enforceListBudget } from "../envelope/truncate.js";
import type { ReadTool } from "../registry/types.js";

const inputShape = {
  group_by: z.enum(["tool_name", "session", "framework"]),
  // NOTE: `quarter` is intentionally absent — see file header. The
  // data layer has no 90-day bucket; admitting `quarter` would force a
  // silent broadening to `"all"` which violates the period contract.
  period: z.enum(["day", "week", "month"]).optional(),
  project_id: z.string().optional(),
  limit: z.number().int().min(1).max(500).optional(),
  offset: z.number().int().min(0).optional(),
};

export const toolCallStatsInputSchema = z.object(inputShape);
export type ToolCallStatsInput = z.infer<typeof toolCallStatsInputSchema>;

const DESCRIPTION =
  "Paginated tool-call statistics grouped by tool name, session, or " +
  "framework. Returns the canonical 5-key list envelope of rows " +
  "(group_key, total_calls, failure_rate, avg_latency_ms, " +
  "total_duration_ms). Required `group_by` selects the aggregation " +
  "axis; optional `period` (day / week / month) narrows the time " +
  "window — when omitted, all time is included.";

type McpPeriodLike = "day" | "week" | "month";

function toDataPeriod(period: McpPeriodLike | undefined): ToolCallPeriod {
  switch (period) {
    case "day":
      return "24h";
    case "week":
      return "7d";
    case "month":
      return "30d";
    default:
      return "all";
  }
}

interface ToolCallStatsRowOut {
  group_key: string;
  total_calls: number;
  failure_rate: number;
  avg_latency_ms: number;
  total_duration_ms: number;
}

function projectRow(row: ToolCallStatsRow): ToolCallStatsRowOut {
  return {
    group_key: row.group_key,
    total_calls: row.total_calls,
    failure_rate: row.failure_rate,
    avg_latency_ms: row.avg_latency_ms,
    total_duration_ms: row.total_duration_ms,
  };
}

export const toolCallStatsTool: ReadTool<ToolCallStatsInput, unknown> = {
  name: "recondo_tool_call_stats",
  description: DESCRIPTION,
  inputShape,
  inputSchema: toolCallStatsInputSchema,
  handler: async (input, ctx) => {
    const offset = input.offset ?? 0;
    const limit = input.limit;
    const period = toDataPeriod(input.period as McpPeriodLike | undefined);

    const iterable = toolCallStats({
      group_by: input.group_by as ToolCallGroupBy,
      period,
      projectId: input.project_id,
      signal: ctx.abortSignal,
    });

    // Drain `offset + limit` rows up front. Slicing in the opposite
    // order — collect `limit` rows then `slice(offset)` — was the C7
    // pagination bug: it returned 0 rows whenever `offset >= limit`.
    const target = limit === undefined ? Infinity : offset + limit;
    const items: ToolCallStatsRowOut[] = [];
    for await (const row of iterable) {
      if (ctx.abortSignal?.aborted) {
        throw new DOMException("aborted", "AbortError");
      }
      items.push(projectRow(row));
      if (items.length >= target) break;
    }

    const pageEnd = limit === undefined ? items.length : offset + limit;
    const sliced = items.slice(offset, pageEnd);
    const budget = enforceListBudget(sliced, offset, JSON.stringify);
    return buildListEnvelope({
      items: budget.items,
      nextOffset: budget.nextOffset,
      truncated: budget.truncated,
    });
  },
};
