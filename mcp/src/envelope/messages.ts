/**
 * Captured-message envelope construction.
 *
 * Wraps captured session text in `<captured_<role>>...</captured_<role>>`
 * with XML escaping so adversarial payloads (including a literal
 * `</captured_user_message>`) cannot break out of the wrapper.
 *
 * Wrapper-tag mapping per Plan D §lines 506-511 (canonical TAG_BY_ROLE):
 *   user        -> <captured_user_message>      (extended `_message` form)
 *   assistant   -> <captured_assistant_message> (extended `_message` form)
 *   tool_use    -> <captured_tool_use>          (bare `<captured_<role>>`)
 *   tool_result -> <captured_tool_result>       (bare `<captured_<role>>`)
 *
 * `user` and `assistant` use the extended `_message` form; `tool_use`
 * and `tool_result` use the bare `<captured_<role>>` form.
 */

import { escapeText } from "./xml.js";

export type Role = "user" | "assistant" | "tool_use" | "tool_result";

export interface MessageEnvelope {
  role: Role;
  from_session_id: string;
  from_turn_id: string;
  content: string;
}

/**
 * Canonical role -> wrapper-tag map. Source: Plan D §lines 506-511.
 */
const TAG_BY_ROLE: Record<Role, string> = {
  user: "captured_user_message",
  assistant: "captured_assistant_message",
  tool_use: "captured_tool_use",
  tool_result: "captured_tool_result",
};

export function buildMessageEnvelope(
  role: Role,
  fromSessionId: string,
  fromTurnId: string,
  text: string,
): MessageEnvelope {
  const escaped = escapeText(text);
  const tag = TAG_BY_ROLE[role];
  return {
    role,
    from_session_id: fromSessionId,
    from_turn_id: fromTurnId,
    content: `<${tag}>${escaped}</${tag}>`,
  };
}
