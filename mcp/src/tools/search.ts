/**
 * `recondo_search` — full-text search across captured turns.
 *
 * Wraps the data-layer `searchTurns(apiKey, query, projectId|null,
 * options)` AsyncIterable, projects each match into a list-envelope item
 * whose captured snippet is wrapped via `buildMessageEnvelope` (so an
 * adversarial closing tag in the matched text cannot escape the
 * `<captured_<role>>` wrapper), and returns the canonical 5-key list
 * envelope.
 *
 * Pagination: `offset` only. Relevance-ranked results have no monotonic
 * cursor, so the `since` field is intentionally absent — the schema
 * test guards against drift.
 *
 * Scope mapping (per Plan D §Task 14 + the C0 audit):
 *
 *   - `scope: "prompt"`    -> role `"user"`, snippet from
 *                              `userRequestText` -> `<captured_user_message>`.
 *   - `scope: "response"`  -> role `"assistant"`, snippet from
 *                              `responseText` -> `<captured_assistant_message>`.
 *   - `scope: "tool_call"` -> role `"tool_use"`, snippet from
 *                              `userRequestText` (the trigger prompt)
 *                              with `responseText` as the fallback when
 *                              the trigger text is missing -> `<captured_tool_use>`.
 *                              `MappedTurn` does not carry an inline
 *                              tool_calls payload (that lives in a
 *                              child collection surfaced by C5's
 *                              `recondo_list_tool_calls`); v1 wraps the
 *                              triggering turn-level text with the
 *                              `tool_use` tag so the consumer still
 *                              gets a captured-content envelope and
 *                              can drill into `recondo_list_tool_calls`
 *                              for the structured args.
 *   - default scope        -> first non-empty of `userRequestText`
 *                              (role `"user"`) or `responseText`
 *                              (role `"assistant"`). If both are empty
 *                              we still emit a wrapped record (empty
 *                              user message) so the offset accounting
 *                              matches the underlying iterable.
 */

import { searchTurns } from "@recondo/data";
import type { ApiKeyInfo, MappedTurn } from "@recondo/data";
import { z } from "zod";

import {
  buildMessageEnvelope,
  type MessageEnvelope,
  type Role,
} from "../envelope/messages.js";
import type { AuthContext } from "../auth/context.js";
import type { ReadTool } from "../registry/types.js";
import {
  buildBudgetedOffsetEnvelope,
  collectOffsetPage,
} from "./pagination.js";

const inputShape = {
  query: z.string().min(1),
  project_id: z.string().optional(),
  scope: z.enum(["prompt", "response", "tool_call"]).optional(),
  limit: z.number().int().min(1).max(100).default(20),
  offset: z.number().int().min(0).default(0),
  // Intentional omission: NO `since` — relevance-ranked search has no
  // monotonic cursor. The C4 unit test guards against accidental
  // re-introduction.
};

export const searchInputSchema = z.object(inputShape).strict();
export type SearchInput = z.infer<typeof searchInputSchema>;

const DESCRIPTION =
  "Full-text search across captured turns (user prompts, assistant " +
  "responses, tool-call triggers). Returns a paginated envelope of " +
  "matched turns whose captured snippet is wrapped in a " +
  "`<captured_<role>>` envelope so the LLM consuming this tool's output " +
  "cannot mistake adversarial captured text for instructions. " +
  "Pagination uses `offset` only — relevance-ranked results have no " +
  "monotonic cursor. Optional `scope` narrows to a specific role " +
  "(`prompt` / `response` / `tool_call`); `project_id` scopes to a " +
  "project. `query` must be 1..500 characters.";

function authContextToApiKey(auth: AuthContext): ApiKeyInfo {
  return {
    id: auth.keyId,
    projectId: auth.projectId,
    rateLimitRpm: 0,
  };
}

interface SearchMatch {
  turn_id: string;
  session_id: string;
  sequence_num: number | null;
  timestamp: string | null;
  model: string | null;
  provider: string | null;
  role: Role;
  from_session_id: string;
  from_turn_id: string;
  content: string;
}

function pickRoleAndSnippet(
  turn: MappedTurn,
  scope: SearchInput["scope"],
): { role: Role; snippet: string } {
  switch (scope) {
    case "prompt":
      return { role: "user", snippet: turn.userRequestText ?? "" };
    case "response":
      return { role: "assistant", snippet: turn.responseText ?? "" };
    case "tool_call":
      // MappedTurn carries no inline tool_calls payload; surface the
      // turn's triggering user text under the tool_use tag so the
      // consumer can still chain into `recondo_list_tool_calls`.
      return {
        role: "tool_use",
        snippet: turn.userRequestText ?? turn.responseText ?? "",
      };
    default: {
      const userText = turn.userRequestText ?? "";
      if (userText.length > 0) {
        return { role: "user", snippet: userText };
      }
      return { role: "assistant", snippet: turn.responseText ?? "" };
    }
  }
}

function projectMatch(
  turn: MappedTurn,
  scope: SearchInput["scope"],
): SearchMatch {
  const { role, snippet } = pickRoleAndSnippet(turn, scope);
  const envelope: MessageEnvelope = buildMessageEnvelope(
    role,
    turn.sessionId,
    turn.id,
    snippet,
  );
  return {
    turn_id: turn.id,
    session_id: turn.sessionId,
    sequence_num: turn.sequenceNum ?? null,
    timestamp: turn.timestamp ?? null,
    model: turn.model ?? null,
    provider: turn.provider ?? null,
    role: envelope.role,
    from_session_id: envelope.from_session_id,
    from_turn_id: envelope.from_turn_id,
    content: envelope.content,
  };
}

export const searchTool: ReadTool<SearchInput, unknown> = {
  name: "recondo_search",
  description: DESCRIPTION,
  inputShape,
  inputSchema: searchInputSchema,
  handler: async (input, ctx) => {
    const apiKey = authContextToApiKey(ctx.auth);
    const offset = input.offset ?? 0;
    const limit = input.limit ?? 20;

    const iterable = searchTurns(apiKey, input.query, input.project_id ?? null, {
      limit: offset + limit + 1,
      offset: 0,
      signal: ctx.abortSignal,
    });
    const page = await collectOffsetPage(iterable, {
      offset,
      limit,
      signal: ctx.abortSignal,
      project: (turn) => projectMatch(turn, input.scope),
    });
    return buildBudgetedOffsetEnvelope(page, offset, JSON.stringify);
  },
};
