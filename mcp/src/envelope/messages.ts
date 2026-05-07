/**
 * Captured-message envelope construction.
 *
 * Wraps captured session text in `<captured_<role>>...</captured_<role>>`
 * with XML escaping so adversarial payloads (including a literal
 * `</captured_user_message>`) cannot break out of the wrapper.
 *
 * Role enum: user | assistant | tool_use | tool_result.
 *
 * Wrapper-tag mapping per Plan D §line 480:
 *   user          -> <captured_user_message>
 *   assistant     -> <captured_assistant>
 *   tool_use      -> <captured_tool_use>
 *   tool_result   -> <captured_tool_result>
 */

export type Role = "user" | "assistant" | "tool_use" | "tool_result";

/**
 * Escape `&`, `<`, `>` in payload text. Order matters — `&` first so we
 * don't double-escape entity references introduced for `<` / `>`.
 */
export function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export interface MessageEnvelope {
  role: Role;
  from_session_id: string;
  from_turn_id: string;
  content: string;
}

function tagFor(role: Role): string {
  return role === "user" ? "captured_user_message" : `captured_${role}`;
}

export function buildMessageEnvelope(
  role: Role,
  fromSessionId: string,
  fromTurnId: string,
  text: string,
): MessageEnvelope {
  const escaped = escapeXml(text);
  const tag = tagFor(role);
  return {
    role,
    from_session_id: fromSessionId,
    from_turn_id: fromTurnId,
    content: `<${tag}>${escaped}</${tag}>`,
  };
}
