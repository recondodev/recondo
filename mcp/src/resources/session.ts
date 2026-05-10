/**
 * Resource — `recondo://session/{id}` (D-C12-7, D-C12-8).
 *
 * Reads a closed session and returns its captured user-message text
 * wrapped in the canonical `<captured_user_message>` envelope (so any
 * adversarial content inside the captured body cannot break out of
 * the resource frame).
 *
 * Active sessions (`ended_at IS NULL`) are NOT readable through this
 * resource — they may still be receiving turns, and surfacing a
 * mid-flight session to a caller invites stale-data races. The
 * caller is redirected to `recondo_get_session` (which returns the
 * session metadata without claiming the captured-stream is final).
 */
import { getSession } from "@recondo/data";
import type { ApiKeyInfo } from "@recondo/data";

import type { AuthContext } from "../auth/context.js";
import { buildMessageEnvelope } from "../envelope/messages.js";
import type { ResourceDefinition, ResourceReadResult } from "./types.js";

export const SESSION_URI_TEMPLATE = "recondo://session/{id}";
const URI_PREFIX = "recondo://session/";

function authContextToApiKey(auth: AuthContext): ApiKeyInfo {
  return {
    id: auth.keyId,
    projectId: auth.projectId,
    rateLimitRpm: 0,
  };
}

function parseSessionId(uri: string): string {
  if (!uri.startsWith(URI_PREFIX)) {
    throw new Error(
      `URI '${uri}' does not match the session resource template '${SESSION_URI_TEMPLATE}'`,
    );
  }
  const id = uri.slice(URI_PREFIX.length);
  if (id.length === 0) {
    throw new Error(
      `session resource URI is missing the {id} placeholder; got '${uri}'`,
    );
  }
  return id;
}

export const sessionResource: ResourceDefinition = {
  uriTemplate: SESSION_URI_TEMPLATE,
  name: "session",
  description:
    "A closed Recondo session and its captured user prompt, wrapped in <captured_user_message> envelopes. Active sessions (ended_at IS NULL) are not readable here — use recondo_get_session for in-flight reads.",
  mimeType: "application/json",
  async read(uri, ctx): Promise<ResourceReadResult> {
    const id = parseSessionId(uri);
    const apiKey = authContextToApiKey(ctx.auth);
    const session = await getSession(apiKey, id, { signal: ctx.abortSignal });
    if (session === null) {
      return {
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify({
              error: "session_not_found",
              session_id: id,
            }),
          },
        ],
        isError: true,
      };
    }

    if (session.endedAt === null) {
      return {
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify({
              error:
                "session is active; resource_read requires a closed session (ended_at IS NOT NULL). Use the recondo_get_session tool for in-flight reads.",
              session_id: session.id,
              ended_at: null,
            }),
          },
        ],
        isError: true,
      };
    }

    const initialIntent = session.initialIntent ?? "";
    const envelope = buildMessageEnvelope(
      "user",
      session.id,
      session.id,
      initialIntent,
    );

    const body = {
      session,
      captured_initial_intent: envelope,
    };

    return {
      contents: [
        {
          uri,
          mimeType: "application/json",
          text: JSON.stringify(body),
        },
      ],
    };
  },
};
