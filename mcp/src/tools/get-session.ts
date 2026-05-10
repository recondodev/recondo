/**
 * `recondo_get_session` — single-record session lookup.
 *
 * Returns the session record verbatim from the data layer when within
 * the 32 KB single-record budget, otherwise emits a
 * `response_too_large` envelope whose suggestion mentions both
 * `fields` projection and `recondo_get_turn_raw_metadata` as escape
 * hatches.
 *
 * Implementation notes:
 *   - `getSession(apiKey, id, options)` already throws AbortError
 *     synchronously when `options.signal.aborted === true` BEFORE any
 *     pool query (see packages/recondo-data/src/sessions.ts:299). We
 *     rely on that data-layer pre-abort check rather than calling
 *     `signal.throwIfAborted()` at the top of the handler.
 *   - `fields` projection is applied AFTER fetching — Postgres returns
 *     `s.*` regardless. The MCP layer trims the projection so the
 *     budget check applies to the trimmed shape.
 */
import { getSession } from "@recondo/data";
import type { ApiKeyInfo } from "@recondo/data";
import { z } from "zod";

import { enforceSingleRecordBudget } from "../envelope/truncate.js";
import type { AuthContext } from "../auth/context.js";
import type { ReadTool } from "../registry/types.js";

const inputShape = {
  session_id: z.string().min(1),
  fields: z.array(z.string()).optional(),
};

export const getSessionInputSchema = z.object(inputShape);
export type GetSessionInput = z.infer<typeof getSessionInputSchema>;

const DESCRIPTION =
  "Fetch a single session record by id, returning the session record " +
  "verbatim from the data layer (id, framework, provider, model, " +
  "started_at, total_tokens, etc.) when within the 32 KB budget. " +
  "Use `fields` to scope the projection when only a subset of columns " +
  "is needed; oversized responses surface a `response_too_large` " +
  "envelope pointing at `recondo_get_turn_raw_metadata` for byte-level " +
  "access to captured payloads.";

function authContextToApiKey(auth: AuthContext): ApiKeyInfo {
  return {
    id: auth.keyId,
    projectId: auth.projectId,
    rateLimitRpm: 0,
  };
}

function projectFields<T extends Record<string, unknown>>(
  record: T,
  fields: string[] | undefined,
): Record<string, unknown> | T {
  if (!fields || fields.length === 0) return record;
  const out: Record<string, unknown> = {};
  for (const key of fields) {
    if (Object.prototype.hasOwnProperty.call(record, key)) {
      out[key] = record[key];
    }
  }
  return out;
}

export const getSessionTool: ReadTool<GetSessionInput, unknown> = {
  name: "recondo_get_session",
  description: DESCRIPTION,
  inputShape,
  inputSchema: getSessionInputSchema,
  handler: async (input, ctx) => {
    const apiKey = authContextToApiKey(ctx.auth);
    const record = await getSession(apiKey, input.session_id, {
      signal: ctx.abortSignal,
    });
    if (record === null) return null;

    const projected = projectFields(
      record as unknown as Record<string, unknown>,
      input.fields,
    );

    return enforceSingleRecordBudget(projected, JSON.stringify);
  },
};
