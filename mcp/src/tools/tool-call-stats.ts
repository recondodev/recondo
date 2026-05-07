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
 * Period translation: the MCP surface exposes day/week/month/quarter
 * and translates to the data-layer enum (`24h`/`7d`/`30d`/`all`).
 * When `period` is omitted, "all" is used.
 *
 * Plan D drift pin: the data-layer `ToolCallStatsRow` type does NOT
 * carry the legacy token-cost field — duration is the honest scalar.
 * The handler surfaces `total_duration_ms` verbatim and never
 * fabricates the legacy column on the wire.
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
  period: z.enum(["day", "week", "month", "quarter"]).optional(),
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
  "axis; optional `period` (day / week / month / quarter) narrows the " +
  "time window — when omitted, all time is included.";

type McpPeriodLike = "day" | "week" | "month" | "quarter";

function toDataPeriod(period: McpPeriodLike | undefined): ToolCallPeriod {
  switch (period) {
    case "day":
      return "24h";
    case "week":
      return "7d";
    case "month":
      return "30d";
    case "quarter":
      return "all";
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
    const period = toDataPeriod(input.period as McpPeriodLike | undefined);

    const iterable = toolCallStats({
      group_by: input.group_by as ToolCallGroupBy,
      period,
      signal: ctx.abortSignal,
    });

    const limit = input.limit;
    const items: ToolCallStatsRowOut[] = [];
    for await (const row of iterable) {
      if (ctx.abortSignal?.aborted) {
        throw new DOMException("aborted", "AbortError");
      }
      items.push(projectRow(row));
      if (limit !== undefined && items.length >= limit) break;
    }

    const sliced = offset > 0 ? items.slice(offset) : items;
    const budget = enforceListBudget(sliced, offset, JSON.stringify);
    return buildListEnvelope({
      items: budget.items,
      nextOffset: budget.nextOffset,
      truncated: budget.truncated,
    });
  },
};
