/**
 * Shared XML escape helpers for the captured-content envelope wrappers.
 *
 * Order matters in both helpers — `&` is escaped first so we don't
 * double-escape the entity references introduced for the other characters.
 *
 * Used by:
 *   - `mcp/src/envelope/messages.ts` — text-content escaping (no quotes).
 *   - `mcp/src/envelope/raw.ts`      — attribute-value escaping (quotes).
 */

/**
 * Escape `&`, `<`, `>` in element text content.
 */
export function escapeText(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Escape `&`, `"`, `<`, `>` in attribute values (double-quote-delimited).
 */
export function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
