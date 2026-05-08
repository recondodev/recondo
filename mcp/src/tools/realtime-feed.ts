/**
 * `recondo_realtime_feed` — paginated real-time activity feed.
 *
 * Wraps the data-layer `listRealtimeFeed(apiKey, args, options)`
 * AsyncIterable, drains it via `for await`, projects each item into
 * the canonical 5-key list envelope, and runs the result through the
 * 32 KB list-budget enforcement.
 *
 * Cadence guidance: dashboards SHOULD poll this tool every 30 seconds
 * (the gateway publishes capture rows on a similar cadence); polling
 * faster than every 30 seconds wastes bandwidth without surfacing
 * fresher data and risks tripping the rate limiter on busy clusters.
 *
 * `since` accepts either an ISO-8601 timestamp or an opaque base64url
 * "since" cursor (the data layer accepts both — see
 * `packages/recondo-data/src/realtime.ts`).
 *
 * `ctx.abortSignal` is threaded into the data-layer options; if the
 * signal is pre-aborted the AsyncIterable throws `AbortError`
 * synchronously on the first iteration step.
 */

import { listRealtimeFeed } from "@recondo/data";
import type { ApiKeyInfo, RealtimeFeedItem, RealtimeFeedArgs } from "@recondo/data";
import { z } from "zod";

import {
  buildMessageEnvelope,
  type MessageEnvelope,
} from "../envelope/messages.js";
import type { AuthContext } from "../auth/context.js";
import type { ReadTool } from "../registry/types.js";
import {
  buildBudgetedOffsetEnvelope,
  collectOffsetPage,
} from "./pagination.js";

const inputShape = {
  since: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(20),
  offset: z.number().int().min(0).default(0),
  project_id: z.string().optional(),
};

export const realtimeFeedInputSchema = z.object(inputShape);
export type RealtimeFeedInput = z.infer<typeof realtimeFeedInputSchema>;

const DESCRIPTION =
  "Paginated real-time activity feed over recently captured user turns. " +
  "Returns a 5-key list envelope (items / next_offset / truncated / " +
  "stream_id / is_final). Each item carries provider, model, framework, " +
  "duration, token + cost rollups, and an `intent` field that is the " +
  "captured user message wrapped in a `<captured_user_message>` envelope " +
  "(role / from_session_id / from_turn_id / content) — XML-escaped so " +
  "adversarial intent text cannot escape into instructions. Pass `since` " +
  "(ISO-8601 timestamp or opaque cursor) for incremental polling; " +
  "recommended polling cadence is 30 seconds — faster than 30s wastes " +
  "bandwidth and risks rate-limiter trips.";

function authContextToApiKey(
  auth: AuthContext,
  projectIdOverride?: string,
): ApiKeyInfo {
  return {
    id: auth.keyId,
    projectId: projectIdOverride ?? auth.projectId,
    rateLimitRpm: 0,
  };
}

interface FeedItemOut {
  timestamp: string;
  provider: string;
  model: string | null;
  framework: string | null;
  intent: MessageEnvelope | null;
  total_tokens: number;
  cost_usd: number;
  http_status: number | null;
  capture_complete: boolean;
  session_id: string;
  sub_call_count: number;
  tool_call_count: number;
  attachment_count: number;
  duration_ms: number | null;
  user_turn_id: string;
}

function projectFeedItem(item: RealtimeFeedItem): FeedItemOut {
  // The intent text is captured user content — REPLACE the raw string
  // with the canonical `<captured_user_message>` envelope so adversarial
  // intent text can't escape into instructions for the consuming agent.
  // Mirrors `mcp/src/tools/get-turn.ts` which replaces `userRequestText`
  // with the envelope rather than carrying both raw and wrapped fields
  // (any raw field would be a prompt-injection bypass).
  const intent =
    item.intent !== null && item.intent !== undefined
      ? buildMessageEnvelope(
          "user",
          item.sessionId,
          item.userTurnId,
          item.intent,
        )
      : null;
  return {
    timestamp: item.timestamp,
    provider: item.provider,
    model: item.model,
    framework: item.framework,
    intent,
    total_tokens: item.totalTokens,
    cost_usd: item.costUsd,
    http_status: item.httpStatus,
    capture_complete: item.captureComplete,
    session_id: item.sessionId,
    sub_call_count: item.subCallCount,
    tool_call_count: item.toolCallCount,
    attachment_count: item.attachmentCount,
    duration_ms: item.durationMs,
    user_turn_id: item.userTurnId,
  };
}

export const realtimeFeedTool: ReadTool<RealtimeFeedInput, unknown> = {
  name: "recondo_realtime_feed",
  description: DESCRIPTION,
  inputShape,
  inputSchema: realtimeFeedInputSchema,
  handler: async (input, ctx) => {
    const offset = input.offset ?? 0;
    const limit = input.limit ?? 20;
    const apiKey = authContextToApiKey(ctx.auth, input.project_id);

    const args: RealtimeFeedArgs = {};
    if (input.since !== undefined) args.since = input.since;

    const iterable = listRealtimeFeed(apiKey, args, {
      limit: offset + limit + 1,
      offset: 0,
      signal: ctx.abortSignal,
    });

    const page = await collectOffsetPage(iterable, {
      offset,
      limit,
      signal: ctx.abortSignal,
      project: projectFeedItem,
    });
    return buildBudgetedOffsetEnvelope(page, offset, JSON.stringify);
  },
};
