/**
 * `recondo_get_turn` — single-record turn lookup with captured-content
 * wrapping.
 *
 * Returns the turn record from the data layer with `userRequestText`
 * and `responseText` REPLACED IN PLACE by `MessageEnvelope` objects
 * (`<captured_user_message>...</captured_user_message>` /
 * `<captured_assistant_message>...</captured_assistant_message>`),
 * so adversarial payloads cannot break out of the wrapper. Other
 * fields (model, costUsd, tokens, etc.) pass through unchanged.
 *
 * `MappedTurn` (see `packages/recondo-data/src/mappers.ts:109`) does
 * NOT carry an inline `tool_calls` array; tool-call detail lives in
 * a separate child collection (`recondo_list_tool_calls` in C5). So
 * this handler wraps only the two captured-text fields.
 *
 * 32 KB budget enforcement: after wrapping + optional `fields`
 * projection, the record runs through `enforceSingleRecordBudget`.
 * Oversize responses surface a `response_too_large` envelope whose
 * suggestion mentions `recondo_get_turn_raw_metadata`.
 *
 * AbortSignal: `getTurn(apiKey, id, options)` already throws
 * AbortError synchronously when `options.signal.aborted === true`
 * BEFORE any pool query (see `packages/recondo-data/src/turns.ts:133`).
 * The handler relies on that data-layer pre-abort check.
 */
import { getTurn } from "@recondo/data";
import type { ApiKeyInfo } from "@recondo/data";
import { z } from "zod";

import { buildMessageEnvelope } from "../envelope/messages.js";
import { enforceSingleRecordBudget } from "../envelope/truncate.js";
import type { AuthContext } from "../auth/context.js";
import type { ReadTool } from "../registry/types.js";

const inputShape = {
  turn_id: z.string().min(1),
  fields: z.array(z.string()).optional(),
};

export const getTurnInputSchema = z.object(inputShape);
export type GetTurnInput = z.infer<typeof getTurnInputSchema>;

const DESCRIPTION =
  "Fetch a single turn record by id, returning the turn record with " +
  "captured content wrapping: `userRequestText` is replaced by a " +
  "`<captured_user_message>` envelope and `responseText` by a " +
  "`<captured_assistant_message>` envelope so adversarial payloads " +
  "cannot break out. Other fields (model, costUsd, tokens, http_status) " +
  "pass through. Subject to the 32 KB budget; oversize responses " +
  "surface a `response_too_large` envelope — fall back to " +
  "`recondo_get_turn_raw_metadata` + `recondo_get_turn_raw_chunk` for " +
  "the full captured bytes.";

function authContextToApiKey(auth: AuthContext): ApiKeyInfo {
  return {
    id: auth.keyId,
    projectId: auth.projectId,
    rateLimitRpm: 0,
  };
}

function projectFields(
  record: Record<string, unknown>,
  fields: string[] | undefined,
): Record<string, unknown> {
  if (!fields || fields.length === 0) return record;
  const out: Record<string, unknown> = {};
  for (const key of fields) {
    if (Object.prototype.hasOwnProperty.call(record, key)) {
      out[key] = record[key];
    }
  }
  return out;
}

export const getTurnTool: ReadTool<GetTurnInput, unknown> = {
  name: "recondo_get_turn",
  description: DESCRIPTION,
  inputShape,
  inputSchema: getTurnInputSchema,
  handler: async (input, ctx) => {
    const apiKey = authContextToApiKey(ctx.auth);
    const turn = await getTurn(apiKey, input.turn_id, {
      signal: ctx.abortSignal,
    });
    if (turn === null) return null;

    // Shallow copy so we can replace the captured-text fields without
    // mutating whatever the data layer returned.
    const record = { ...(turn as unknown as Record<string, unknown>) };
    const sessionId = String(record.sessionId ?? "");
    const turnId = String(record.id ?? input.turn_id);

    const userText = record.userRequestText;
    if (typeof userText === "string") {
      record.userRequestText = buildMessageEnvelope(
        "user",
        sessionId,
        turnId,
        userText,
      );
    }
    const respText = record.responseText;
    if (typeof respText === "string") {
      record.responseText = buildMessageEnvelope(
        "assistant",
        sessionId,
        turnId,
        respText,
      );
    }

    const projected = projectFields(record, input.fields);
    return enforceSingleRecordBudget(projected, JSON.stringify);
  },
};
