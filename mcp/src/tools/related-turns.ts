/**
 * `recondo_related_turns` — neighbour-turn lookup.
 *
 * Wraps the data-layer `relatedTurns(turnId, relation, options)` helper.
 * Three relations, no more, no less:
 *
 *   - `same_session`     — peers in the same session, input excluded,
 *                          ordered ASC by timestamp.
 *   - `same_prompt_hash` — turns whose `md5(user_request_text)` matches
 *                          the input's (cross-session matches valid).
 *   - `retry_of`         — connected component under
 *                          `supersedes_turn_id`: parent + children +
 *                          co-retry siblings of the input. Maps to the
 *                          `supersedes_turn_id` column (the legacy
 *                          `retry_of_turn_id` column was never shipped).
 *
 * Legacy v0 relations DROPPED — their backing columns do not exist on
 * `turns`, so they cannot be honestly implemented. This is the design
 * rationale for reducing the draft five-member enum to the three-member
 * v1 enum exposed here.
 *
 * Captured user text on each row is wrapped via
 * `buildMessageEnvelope("user", session_id, turn_id, text)` so
 * adversarial payloads cannot escape `<captured_user_message>`. Output
 * is the canonical 5-key list envelope; the 32 KB response budget is
 * enforced via `enforceListBudget`.
 *
 * AbortSignal: `relatedTurns` is sync-callable — pre-aborted signals
 * throw on the first iteration step.
 */
import { relatedTurns } from "@recondo/data";
import type { Relation, RelatedTurnsRow } from "@recondo/data";
import { z } from "zod";

import { buildMessageEnvelope } from "../envelope/messages.js";
import type { ReadTool } from "../registry/types.js";
import {
  buildBudgetedOffsetEnvelope,
  collectOffsetPage,
} from "./pagination.js";

const inputShape = {
  turn_id: z.string().min(1),
  relation: z.enum(["same_session", "same_prompt_hash", "retry_of"]),
  limit: z.number().int().min(1).max(100).default(20),
  offset: z.number().int().min(0).default(0),
};

export const relatedTurnsInputSchema = z.object(inputShape);
export type RelatedTurnsInput = z.infer<typeof relatedTurnsInputSchema>;

const DESCRIPTION =
  "Find turns related to a given turn under one of three relations: " +
  "`same_session` (peers in the same session), `same_prompt_hash` " +
  "(byte-identical user_request_text under md5), or `retry_of` (the " +
  "connected component under the `supersedes_turn_id` column — parent, " +
  "children, and co-retry siblings of the input). The `retry_of` " +
  "relation maps directly to `supersedes_turn_id`. Returns a paginated " +
  "list envelope; each row's captured user text is wrapped in " +
  "`<captured_user_message>` so adversarial payloads cannot escape. " +
  "Subject to the 32 KB response budget.";

interface RelatedTurnItem {
  turn_id: string;
  session_id: string;
  timestamp: string;
  role?: "user";
  from_session_id?: string;
  from_turn_id?: string;
  content?: string;
}

function projectRow(row: RelatedTurnsRow): RelatedTurnItem {
  const item: RelatedTurnItem = {
    turn_id: row.turn_id,
    session_id: row.session_id,
    timestamp: row.timestamp,
  };
  if (typeof row.user_request_text === "string") {
    const envelope = buildMessageEnvelope(
      "user",
      row.session_id,
      row.turn_id,
      row.user_request_text,
    );
    item.role = envelope.role as "user";
    item.from_session_id = envelope.from_session_id;
    item.from_turn_id = envelope.from_turn_id;
    item.content = envelope.content;
  }
  return item;
}

export const relatedTurnsTool: ReadTool<RelatedTurnsInput, unknown> = {
  name: "recondo_related_turns",
  description: DESCRIPTION,
  inputShape,
  inputSchema: relatedTurnsInputSchema,
  handler: async (input, ctx) => {
    const offset = input.offset ?? 0;
    const limit = input.limit ?? 20;

    const iterable = relatedTurns(
      input.turn_id,
      input.relation as Relation,
      { limit: offset + limit + 1, signal: ctx.abortSignal },
    );
    const page = await collectOffsetPage(iterable, {
      offset,
      limit,
      signal: ctx.abortSignal,
      project: projectRow,
    });
    return buildBudgetedOffsetEnvelope(page, offset, JSON.stringify);
  },
};
