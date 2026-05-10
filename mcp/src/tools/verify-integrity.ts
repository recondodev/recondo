/**
 * `recondo_verify_integrity` — recompute SHA-256 hashes for every
 * captured turn in a session and compare against stored hashes.
 *
 * Returns the data-layer `VerifyIntegrityResult` verbatim. The result
 * is metadata about captured content (per-turn pass/fail booleans, hash
 * presence flags, counts), NOT captured content itself, so no
 * `<captured_*>` wrapping is applied.
 *
 * The description carries TWO governance literals required by the C4
 * unit test (`"Expensive"` and `"only invoke when the user explicitly
 * asks"`); both surface verbatim in `tools/list` so the calling agent
 * sees the cost + invocation policy before scheduling a verify.
 *
 * AbortSignal: the data-layer `verifyIntegrity(apiKey, sessionId,
 * options)` already throws AbortError synchronously when
 * `options.signal.aborted === true` BEFORE any pool query (see
 * `packages/recondo-data/src/turns.ts:67`). We thread `ctx.abortSignal`
 * into `options.signal` and let the data layer raise.
 */

import { verifyIntegrity } from "@recondo/data";
import type { ApiKeyInfo, VerifyIntegrityResult } from "@recondo/data";
import { z } from "zod";

import type { AuthContext } from "../auth/context.js";
import type { ReadTool } from "../registry/types.js";

const inputShape = {
  session_id: z.string().min(1),
};

export const verifyIntegrityInputSchema = z.object(inputShape).strict();
export type VerifyIntegrityInput = z.infer<typeof verifyIntegrityInputSchema>;

const DESCRIPTION =
  "Recompute SHA-256 hashes for every captured turn in the session and " +
  "compare against the stored hashes. Expensive — scans every byte of " +
  "every captured request and response in the session. This tool is " +
  "an integrity attestation, not a routine query: only invoke when the " +
  "user explicitly asks for an integrity check (e.g. \"verify session " +
  "X\", \"check session X for tampering\", \"audit the captures\"). " +
  "Returns a structured report with `verifiedTurns` / `failedTurns` " +
  "counts, an aggregate `verified` boolean, and a per-turn `results[]` " +
  "carrying `reqHashMatch`, `respHashMatch`, `reqBytesPresent`, and " +
  "`respBytesPresent` flags.";

function authContextToApiKey(auth: AuthContext): ApiKeyInfo {
  return {
    id: auth.keyId,
    projectId: auth.projectId,
    rateLimitRpm: 0,
  };
}

export const verifyIntegrityTool: ReadTool<
  VerifyIntegrityInput,
  VerifyIntegrityResult
> = {
  name: "recondo_verify_integrity",
  description: DESCRIPTION,
  inputShape,
  inputSchema: verifyIntegrityInputSchema,
  handler: async (input, ctx) => {
    const apiKey = authContextToApiKey(ctx.auth);
    return verifyIntegrity(apiKey, input.session_id, {
      signal: ctx.abortSignal,
    });
  },
};
