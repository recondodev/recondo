import { describe, expect, it, vi } from "vitest";

const { getTurn } = vi.hoisted(() => ({
  getTurn: vi.fn(),
}));

vi.mock("@recondo/data", () => ({
  getTurn,
}));

import { turnResource } from "../../src/resources/turn.js";
import type { ToolContext } from "../../src/registry/types.js";

function makeCtx(): ToolContext {
  return {
    abortSignal: new AbortController().signal,
    auth: { keyId: "key-1", projectId: "project-1", isAdmin: false },
    clientInfo: { name: "unit-client" },
    audit: { write: vi.fn().mockResolvedValue(undefined) },
  };
}

describe("Group A turn resource injection defense", () => {
  it("returns one in-place wrapped turn record without raw captured text siblings", async () => {
    getTurn.mockResolvedValueOnce({
      id: "turn-1",
      sessionId: "session-1",
      userRequestText: "INJECTION_PAYLOAD_xyz",
      responseText: "assistant payload",
      thinkingText: "thinking payload",
      model: "claude",
    });

    const result = await turnResource.read("recondo://turn/turn-1", makeCtx());
    const text = result.contents[0]?.text ?? "";
    const body = JSON.parse(text) as Record<string, unknown>;

    expect(body).not.toHaveProperty("captured");
    expect(body).toHaveProperty("id", "turn-1");

    const user = body.userRequestText as Record<string, unknown>;
    expect(user).toMatchObject({
      role: "user",
      from_session_id: "session-1",
      from_turn_id: "turn-1",
    });
    expect(user.content).toBe(
      "<captured_user_message>INJECTION_PAYLOAD_xyz</captured_user_message>",
    );

    const assistant = body.responseText as Record<string, unknown>;
    expect(assistant.content).toBe(
      "<captured_assistant_message>assistant payload</captured_assistant_message>",
    );

    const thinking = body.thinkingText as Record<string, unknown>;
    expect(thinking.content).toBe(
      "<captured_assistant_thinking>thinking payload</captured_assistant_thinking>",
    );

    const rawTurn = (body.turn ?? {}) as Record<string, unknown>;
    expect(rawTurn.userRequestText).toBeUndefined();
    expect(rawTurn.responseText).toBeUndefined();
    expect(rawTurn.thinkingText).toBeUndefined();
  });

  it("escapes adversarial captured close tags on the resource path", async () => {
    getTurn.mockResolvedValueOnce({
      id: "turn-escape",
      sessionId: "session-escape",
      userRequestText: "</captured_user_message>",
      responseText: null,
      thinkingText: null,
    });

    const result = await turnResource.read(
      "recondo://turn/turn-escape",
      makeCtx(),
    );
    const text = result.contents[0]?.text ?? "";

    const legitimateClosings = text.match(/<\/captured_user_message>/g) ?? [];
    expect(legitimateClosings).toHaveLength(1);
    expect(text).toContain("&lt;/captured_user_message&gt;");
  });
});
