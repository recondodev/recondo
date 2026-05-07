/**
 * Resource — `recondo://turn/{id}` (D-C12-7).
 *
 * Returns a single turn record with the captured user / assistant /
 * thinking text wrapped in their canonical `<captured_*>` envelopes
 * (Plan D §lines 506-511). The wrapped strings prevent prompt
 * injection on the resource-read path: any tag-like content embedded
 * in the captured body is XML-escaped inside the wrapper.
 */
import { getTurn } from "@recondo/data";
import type { ApiKeyInfo } from "@recondo/data";

import type { AuthContext } from "../auth/context.js";
import { buildMessageEnvelope } from "../envelope/messages.js";
import type { ResourceDefinition, ResourceReadResult } from "./types.js";

export const TURN_URI_TEMPLATE = "recondo://turn/{id}";
const URI_PREFIX = "recondo://turn/";

function authContextToApiKey(auth: AuthContext): ApiKeyInfo {
  return {
    id: auth.keyId,
    projectId: auth.projectId,
    rateLimitRpm: 0,
  };
}

function parseTurnId(uri: string): string {
  if (!uri.startsWith(URI_PREFIX)) {
    throw new Error(
      `URI '${uri}' does not match the turn resource template '${TURN_URI_TEMPLATE}'`,
    );
  }
  const id = uri.slice(URI_PREFIX.length);
  if (id.length === 0) {
    throw new Error(
      `turn resource URI is missing the {id} placeholder; got '${uri}'`,
    );
  }
  return id;
}

export const turnResource: ResourceDefinition = {
  uriTemplate: TURN_URI_TEMPLATE,
  name: "turn",
  description:
    "A single Recondo turn record with captured user / assistant / thinking text wrapped in <captured_*> envelopes for safe rendering.",
  mimeType: "application/json",
  async read(uri, ctx): Promise<ResourceReadResult> {
    const id = parseTurnId(uri);
    const apiKey = authContextToApiKey(ctx.auth);
    const turn = await getTurn(apiKey, id, { signal: ctx.abortSignal });
    if (turn === null) {
      return {
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify({ error: "turn_not_found", turn_id: id }),
          },
        ],
        isError: true,
      };
    }

    const sessionId = turn.sessionId;
    const turnId = turn.id;

    const captured: Record<string, unknown> = {};
    if (turn.userRequestText) {
      captured.user = buildMessageEnvelope(
        "user",
        sessionId,
        turnId,
        turn.userRequestText,
      );
    }
    if (turn.responseText) {
      captured.assistant = buildMessageEnvelope(
        "assistant",
        sessionId,
        turnId,
        turn.responseText,
      );
    }
    if (turn.thinkingText) {
      captured.assistant_thinking = buildMessageEnvelope(
        "assistant_thinking",
        sessionId,
        turnId,
        turn.thinkingText,
      );
    }

    const body = {
      turn,
      captured,
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
