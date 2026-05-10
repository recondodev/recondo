/**
 * `recondo_find_similar_prompts` — byte-identical prompt lookup.
 *
 * Wraps the data-layer `findSimilarPrompts(input, options)` helper.
 * v1 is hash-only / byte-identical — two prompts are considered similar
 * iff their `md5(user_request_text)` is byte-for-byte equal. Whitespace,
 * casing, or any other normalisation produces a different hash and a
 * non-match. Semantic similarity (embeddings) is on the future-work list.
 *
 * Input shape (XOR — exactly one of):
 *   - `turn_id`: looks up the turn's user_request_text, uses its md5 as
 *                the search key, and self-excludes from results.
 *   - `text`:    uses the literal text as the search key.
 *
 * Captured user text in each match is wrapped via
 * `buildMessageEnvelope("user", session_id, turn_id, text)` so the LLM
 * consuming this tool's output cannot mistake adversarial captured text
 * for instructions. Output is the canonical 5-key list envelope; the
 * 32 KB response budget is enforced via `enforceListBudget`.
 *
 * AbortSignal: `findSimilarPrompts` is sync-callable — it returns an
 * AsyncIterable. Pre-aborted signals throw on the first iteration step
 * (see `packages/recondo-data/src/find-similar-prompts.ts:101`).
 */
import { findSimilarPrompts } from "@recondo/data";
import type {
  FindSimilarPromptsInput as DataLayerInput,
  SimilarPromptMatch,
} from "@recondo/data";
import { z } from "zod";

import { buildMessageEnvelope } from "../envelope/messages.js";
import type { ReadTool } from "../registry/types.js";
import {
  buildBudgetedOffsetEnvelope,
  collectOffsetPage,
} from "./pagination.js";

const inputShape = {
  turn_id: z.string().min(1).optional(),
  text: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(100).default(20),
  offset: z.number().int().min(0).default(0),
};

export const findSimilarPromptsInputSchema = z
  .object(inputShape)
  .strict()
  .refine((d) => (d.turn_id !== undefined) !== (d.text !== undefined), {
    message: "exactly one of turn_id or text must be provided",
  });
export type FindSimilarPromptsInput = z.infer<
  typeof findSimilarPromptsInputSchema
>;

const DESCRIPTION =
  "Find prompts byte-identical to a reference prompt (v1: hash-only — " +
  "matches `md5(user_request_text)` byte-for-byte; whitespace and " +
  "casing differences do NOT match). Provide exactly one of `turn_id` " +
  "(self-excludes the input turn) or `text` (literal lookup). Returns " +
  "a paginated list envelope; each match's captured user text is " +
  "wrapped in `<captured_user_message>` so adversarial payloads cannot " +
  "escape. Subject to the 32 KB response budget.";

interface SimilarPromptItem {
  turn_id: string;
  session_id: string;
  role: "user";
  from_session_id: string;
  from_turn_id: string;
  content: string;
}

function projectMatch(match: SimilarPromptMatch): SimilarPromptItem {
  const envelope = buildMessageEnvelope(
    "user",
    match.session_id,
    match.turn_id,
    match.user_request_text,
  );
  return {
    turn_id: match.turn_id,
    session_id: match.session_id,
    role: envelope.role as "user",
    from_session_id: envelope.from_session_id,
    from_turn_id: envelope.from_turn_id,
    content: envelope.content,
  };
}

export const findSimilarPromptsTool: ReadTool<
  FindSimilarPromptsInput,
  unknown
> = {
  name: "recondo_find_similar_prompts",
  description: DESCRIPTION,
  inputShape,
  inputSchema: findSimilarPromptsInputSchema as unknown as z.SomeZodObject,
  handler: async (input, ctx) => {
    const offset = input.offset ?? 0;
    const limit = input.limit ?? 20;

    // The SDK validates against `inputShape` (both fields optional), so
    // the XOR refine on `findSimilarPromptsInputSchema` is bypassed when
    // arriving via JSON-RPC. Re-enforce in the handler.
    if (
      (input.turn_id === undefined) === (input.text === undefined)
    ) {
      throw new Error(
        "exactly one of turn_id or text must be provided",
      );
    }
    const dataInput: DataLayerInput =
      input.turn_id !== undefined ? input.turn_id : { text: input.text! };

    const iterable = findSimilarPrompts(dataInput, {
      limit: offset + limit + 1,
      signal: ctx.abortSignal,
    });
    const page = await collectOffsetPage(iterable, {
      offset,
      limit,
      signal: ctx.abortSignal,
      project: projectMatch,
    });
    return buildBudgetedOffsetEnvelope(page, offset, JSON.stringify);
  },
};
