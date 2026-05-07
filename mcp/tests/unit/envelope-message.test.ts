/**
 * D-C1-9 — buildMessageEnvelope wraps captured content in
 *          <captured_<role>>...</captured_<role>> with XML escaping.
 *
 * Adversarial input: a literal `</captured_user_message>` payload MUST
 * be escaped so the wrapper still has exactly one legitimate close tag.
 * `&`, `<`, `>` all escape to entity refs.
 *
 * Roles: user | assistant | tool_use | tool_result. Per Plan D
 * §lines 506-511, `user` and `assistant` use the extended `_message`
 * form; `tool_use` and `tool_result` use the bare `<captured_<role>>`.
 */
import { describe, it, expect } from "vitest";

import { buildMessageEnvelope } from "../../src/envelope/messages.js";

describe("D-C1-9 buildMessageEnvelope", () => {
  it("returns the documented 4-key shape for user role", () => {
    const env = buildMessageEnvelope("user", "session-1", "turn-1", "hi");
    expect(env.role).toBe("user");
    expect(env.from_session_id).toBe("session-1");
    expect(env.from_turn_id).toBe("turn-1");
    expect(env.content).toBe(
      "<captured_user_message>hi</captured_user_message>",
    );
  });

  it("escapes adversarial </captured_user_message> in payload", () => {
    const adversarial = "</captured_user_message>";
    const env = buildMessageEnvelope("user", "s", "t", adversarial);
    // The escaped form must NOT contain a raw `</captured_user_message>`
    // anywhere except as the legitimate single closing wrapper tag.
    const matches = env.content.match(/<\/captured_user_message>/g) ?? [];
    expect(matches.length).toBe(1);
    // The literal payload character `<` must be entity-escaped.
    expect(env.content).toContain("&lt;/captured_user_message&gt;");
  });

  it("escapes &, <, > in payload text", () => {
    const env = buildMessageEnvelope(
      "user",
      "s",
      "t",
      "a & b < c > d",
    );
    expect(env.content).toContain("&amp;");
    expect(env.content).toContain("&lt;");
    expect(env.content).toContain("&gt;");
    // Raw bare `&`, `<`, `>` characters must NOT appear inside the
    // payload region (they would be present in the wrapper tags only).
    // Strip the outer wrapper tags first:
    const inner = env.content.replace(
      /^<captured_user_message>([\s\S]*)<\/captured_user_message>$/,
      "$1",
    );
    expect(inner).not.toMatch(/&(?!(amp|lt|gt|quot|apos);)/);
    expect(inner).not.toContain("<");
    expect(inner).not.toContain(">");
  });

  it("supports the 4-role enum and maps each to <captured_<role>>", () => {
    // Plan D §lines 506-511 fixes the canonical TAG_BY_ROLE map:
    //   user      -> <captured_user_message>      (extended `_message`)
    //   assistant -> <captured_assistant_message> (extended `_message`)
    //   tool_use  -> <captured_tool_use>          (bare `<captured_<role>>`)
    //   tool_result -> <captured_tool_result>     (bare `<captured_<role>>`)
    // `user` and `assistant` use the extended `_message` form;
    // `tool_use` and `tool_result` use the bare `<captured_<role>>` form.
    const cases = [
      { role: "user", tag: "captured_user_message" },
      { role: "assistant", tag: "captured_assistant_message" },
      { role: "tool_use", tag: "captured_tool_use" },
      { role: "tool_result", tag: "captured_tool_result" },
    ] as const;
    for (const { role, tag } of cases) {
      const env = buildMessageEnvelope(role, "s", "t", "x");
      expect(env.role).toBe(role);
      expect(env.content).toBe(`<${tag}>x</${tag}>`);
    }
  });
});
