/**
 * FIND-1-M: Placeholder masking for attachment-sibling text blocks.
 *
 * Claude Code (and other CLI agents) emit a sibling text block alongside
 * image/document content blocks of the form:
 *   "[Image: source: /Users/x/.claude/image-cache/<uuid>/1.png]"
 *   "[PDF: source: /Users/x/Downloads/report.pdf]"
 * etc. The gateway stores these text blocks verbatim inside the request
 * body JSON (req_bytes object, messages_delta column, tool_call.input,
 * user_request_text). The dashboard renders raw stored content in several
 * places (session detail full-request viewer, tool call inputs). Those
 * placeholder strings contain absolute filesystem paths from the user's
 * machine, which is a data leak when the dashboard is shared across a
 * team or customer org.
 *
 * The gateway-side `is_image_source_placeholder` helper in
 * `gateway/src/session/mod.rs` strips these at `user_request_text`
 * extraction time, but captures must remain byte-complete for compliance
 * / audit — so the raw request body still carries the placeholder. This
 * module owns the DISPLAY-TIME masking: API resolvers run user-visible
 * strings through `maskPlaceholderPaths` before returning them to the
 * dashboard.
 *
 * **Parity invariant (FIND-3-TS-3)**: the prefix allow-list is loaded
 * from `shared/placeholder-prefixes.json` — the SAME file the Rust side
 * consumes via `include_str!`. Adding or removing a prefix in that
 * single file propagates to BOTH sides automatically. The test suite
 * (`packages/recondo-data/tests/placeholder-mask.test.ts`) asserts the
 * Rust and TS consumers read equal sets from the JSON.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// __dirname equivalent under ESM; avoid require().
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * The shared JSON file holding the allow-list. Resolved relative to
 * this module so it works from multiple invocation contexts:
 *   - `packages/recondo-data/src/redaction/placeholder-mask.ts` (test/dev)
 *   - `packages/recondo-data/dist/redaction/placeholder-mask.js` (built)
 *   - `api/src/placeholder-mask.ts` (legacy shim resolving via @recondo/data)
 *   - `api/dist/src/placeholder-mask.js` (built api)
 */
function loadSharedJson(): {
  prefixes: string[];
  replacement: string;
} {
  // Walk up to find the shared/ directory. The candidate list covers
  // every layout that has historically held this file — duplicates
  // (string-equal paths) are fine because the loop short-circuits on
  // the first hit.
  for (const candidate of [
    // Existing fallbacks (kept so the api shim path still resolves):
    resolve(__dirname, "..", "..", "shared", "placeholder-prefixes.json"),
    resolve(__dirname, "..", "..", "..", "shared", "placeholder-prefixes.json"),
    resolve(__dirname, "..", "shared", "placeholder-prefixes.json"),
    // Resolves from packages/recondo-data/dist/redaction/ → repo root
    // and from packages/recondo-data/src/redaction/ → repo root (both
    // are 4 levels up).
    resolve(__dirname, "..", "..", "..", "..", "shared", "placeholder-prefixes.json"),
  ]) {
    try {
      const contents = readFileSync(candidate, "utf-8");
      const parsed = JSON.parse(contents) as {
        prefixes: string[];
        replacement: string;
      };
      if (
        !Array.isArray(parsed.prefixes) ||
        typeof parsed.replacement !== "string"
      ) {
        throw new Error(
          `shared/placeholder-prefixes.json malformed: prefixes must be array, replacement must be string`,
        );
      }
      // FIND-6-I: reject prefixes containing SQL LIKE meta-characters.
      // `placeholderLikePatterns()` interpolates prefixes into SQL
      // LIKE patterns raw; `%`, `_`, `\` would be treated as
      // wildcards or the escape char, breaking the path-probe
      // defence. A prefix like `[Attach%:` would match any text
      // containing `[Attach<anything> source:` — exactly the kind
      // of side channel FIND-3-TS-5 closed.
      for (const p of parsed.prefixes) {
        if (typeof p !== "string") {
          throw new Error(
            `shared/placeholder-prefixes.json: prefix must be a string, got ${typeof p}`,
          );
        }
        if (/[%_\\]/.test(p)) {
          throw new Error(
            `shared/placeholder-prefixes.json: prefix ${JSON.stringify(
              p,
            )} contains SQL LIKE metacharacter (%, _, or \\). `
              + "These prefixes interpolate into LIKE patterns in "
              + "api/src/resolvers/{turns,sessions}.ts; wildcards here "
              + "break the path-probe defence. Remove the metacharacter "
              + "or escape it deliberately (and update the loader + "
              + "callers)."
          );
        }
      }
      return parsed;
    } catch (err) {
      // ENOENT: keep trying other candidate paths. Any other error
      // (SyntaxError, malformed schema) propagates.
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw err;
    }
  }
  throw new Error(
    "shared/placeholder-prefixes.json not found in any expected location (dev / prod / test). " +
      "This file is the single source of truth for placeholder prefixes — without it the dashboard " +
      "cannot mask filesystem paths out of user-facing strings. Check the Dockerfile.api COPY directive " +
      "and dev setup.",
  );
}

const SHARED = loadSharedJson();

/** The shared allow-list of placeholder prefixes. Sourced from
 * `shared/placeholder-prefixes.json`. Both Rust (gateway) and TS (api)
 * consume the same file. */
export const PLACEHOLDER_PREFIXES: readonly string[] = SHARED.prefixes;

/** Value written in place of a stripped placeholder. Short and
 * dashboard-safe; the paperclip UI renders the real attachment
 * alongside this string. */
export const MASKED_PLACEHOLDER_REPLACEMENT: string = SHARED.replacement;

/**
 * Return true when `text` is exactly ONE of the attachment-sibling
 * placeholder shapes: starts with one of `PLACEHOLDER_PREFIXES`, ends
 * with `]`, contains `source:`, has no newlines, AND has at most one
 * placeholder prefix occurrence. Matches the gateway-side
 * `is_image_source_placeholder` semantics exactly.
 *
 * FIND-3-TS-8: the "exactly one prefix" guard is critical — without
 * it, `"[Image: source: /a][PDF: source: /b]"` (which does start
 * with `[Image:` and end with `]`) would be flagged as a single
 * placeholder and collapse to one `[attachment]` instead of two.
 */
export function isAttachmentPlaceholder(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  if (!trimmed.endsWith("]")) return false;
  if (trimmed.includes("\n")) return false;
  if (!trimmed.includes("source:")) return false;
  if (!PLACEHOLDER_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) {
    return false;
  }
  // FIND-3-TS-8: reject multi-placeholder strings. Count total
  // occurrences across all prefixes; if > 1, this is a
  // consecutive-placeholder line and must flow through the inline
  // scanner instead of collapsing to a single `[attachment]`.
  let occurrences = 0;
  for (const p of PLACEHOLDER_PREFIXES) {
    let idx = 0;
    while ((idx = trimmed.indexOf(p, idx)) !== -1) {
      occurrences += 1;
      idx += p.length;
      if (occurrences > 1) return false;
    }
  }
  return true;
}

/**
 * Scan a single line for embedded placeholders and replace each one
 * with `MASKED_PLACEHOLDER_REPLACEMENT`. Shared between the fast-path
 * and the multi-line path in `maskPlaceholderPaths`.
 *
 * FIND-3-TS-2 fix: when matching a single-placeholder line that
 * contains a path with embedded `]` (e.g. `/Users/x/dir[1]/image.png`),
 * scan from the END of the line for the outermost `]` so that the
 * inner `]` does not close the placeholder prematurely. For
 * multi-placeholder lines we fall back to per-prefix scanning.
 *
 * FIND-3-TS-6 fix: match candidate is trimmed so interior whitespace
 * ("  [Image:   source: /path]  ") is also normalised.
 *
 * Returns { output, mutated } — mutated=true when at least one
 * replacement fired so the caller can decide whether to reuse the
 * original string or return a new one.
 */
function maskLineContents(line: string): { output: string; mutated: boolean } {
  // Fast path: if no prefix appears anywhere, don't allocate.
  if (!PLACEHOLDER_PREFIXES.some((p) => line.includes(p))) {
    return { output: line, mutated: false };
  }

  let mutated = false;
  let out = "";
  let i = 0;
  while (i < line.length) {
    const prefix = PLACEHOLDER_PREFIXES.find(
      (p) => line.substring(i, i + p.length) === p,
    );
    if (!prefix) {
      out += line[i];
      i += 1;
      continue;
    }
    // FIND-4-D close-detection: find the OUTERMOST `]` that closes
    // this specific placeholder, even when the path inside contains
    // `]` (e.g. `/Users/x/dir[1]/image.png`) AND another placeholder
    // follows on the same line. Strategy:
    //   1. Find the position `nextPrefixStart` of the NEXT placeholder
    //      prefix occurrence after this prefix's body. If no next
    //      prefix exists, set it to `line.length` (end-of-line).
    //   2. The closing `]` for THIS placeholder is the LAST `]` strictly
    //      before `nextPrefixStart`. That `]` is the outermost — any
    //      earlier `]` (inside `dir[1]`) is interior; any later `]`
    //      (after `nextPrefixStart`) belongs to the next placeholder.
    //
    // This handles all four cases correctly:
    //   - Single placeholder, no `]` in path: lastIndexOf("]", line.length)
    //     finds the only `]`, which is the close.
    //   - Single placeholder with `]` in path: the SAME lookup finds the
    //     outermost `]` because the interior `]`s are earlier.
    //   - Multi placeholder: each placeholder K's lookup is bounded by
    //     placeholder (K+1)'s start, so the `]` it finds is its own
    //     close, not the close of the next.
    //   - Multi placeholder with `]` in first path: the bound at next
    //     prefix start ensures we don't skip past the close of the
    //     first into the second.
    const bodyStart = i + prefix.length;
    let nextPrefixStart = line.length;
    for (const p of PLACEHOLDER_PREFIXES) {
      const found = line.indexOf(p, bodyStart);
      if (found !== -1 && found < nextPrefixStart) {
        nextPrefixStart = found;
      }
    }
    // `lastIndexOf(s, fromIndex)` returns the last occurrence of `s`
    // at index <= fromIndex. We want the last `]` strictly BEFORE
    // nextPrefixStart, so pass nextPrefixStart - 1 (or
    // line.length - 1 when there is no next).
    const close = line.lastIndexOf("]", nextPrefixStart - 1);
    if (close < bodyStart) {
      // No closing `]` between this prefix and the next placeholder
      // (or between this prefix and end-of-line). Treat the prefix
      // as ordinary text and continue scanning.
      out += line[i];
      i += 1;
      continue;
    }
    const candidate = line.substring(i, close + 1).trim();
    // Real placeholder only if it contains `source:` (embedded) and
    // does NOT span a newline (we already split on \r?\n so this line
    // check is defensive).
    if (candidate.includes("source:") && !candidate.includes("\n")) {
      out += MASKED_PLACEHOLDER_REPLACEMENT;
      mutated = true;
      i = close + 1;
    } else {
      // Looked like a prefix but missing `source:` — real user text
      // (e.g., `[Image: can you describe this icon?]`). Preserve.
      out += line[i];
      i += 1;
    }
  }
  return { output: out, mutated };
}

/**
 * Replace every occurrence of an attachment-sibling placeholder inside
 * `text` with `MASKED_PLACEHOLDER_REPLACEMENT`. Preserves original line
 * separators (CRLF / LF / CR) so mixed behaviour doesn't surface
 * downstream (FIND-3-TS-7).
 *
 * Returns `null` when input is `null` / `undefined`, passes the input
 * through unchanged when no placeholder is found (zero allocation for
 * the common case), and returns a new string with replacements when
 * masking occurred.
 */
export function maskPlaceholderPaths(
  text: string | null | undefined,
): string | null {
  if (text === null || text === undefined) return null;
  if (text.length === 0) return text;

  // FIND-3-TS-8: only collapse to the bare `[attachment]` replacement
  // when the ENTIRE string is exactly one placeholder. When two or
  // more are present (e.g. `[Image: source: /a][PDF: source: /b]`),
  // fall through to the line-scanner so each is masked individually.
  const trimmed = text.trim();
  if (!trimmed.includes("\n")) {
    let occurrences = 0;
    for (const p of PLACEHOLDER_PREFIXES) {
      let idx = 0;
      while ((idx = trimmed.indexOf(p, idx)) !== -1) {
        occurrences += 1;
        idx += p.length;
        if (occurrences > 1) break;
      }
      if (occurrences > 1) break;
    }
    if (occurrences === 1 && isAttachmentPlaceholder(text)) {
      return MASKED_PLACEHOLDER_REPLACEMENT;
    }
  }

  // Substring fast-path: if no prefix appears anywhere, nothing to do.
  if (!PLACEHOLDER_PREFIXES.some((p) => text.includes(p))) {
    return text;
  }

  // FIND-3-TS-7: preserve original line separators. Split with a
  // capturing group on (\r\n|\r|\n) so each separator is retained in
  // the resulting array; alternate elements are content/separator.
  const parts = text.split(/(\r\n|\r|\n)/g);
  let anyMutated = false;
  const maskedParts: string[] = parts.map((part, idx) => {
    // Separator positions: even index = content, odd index = separator.
    if (idx % 2 === 1) return part;
    // Content line — check bare-placeholder fast path first.
    if (isAttachmentPlaceholder(part)) {
      anyMutated = true;
      return MASKED_PLACEHOLDER_REPLACEMENT;
    }
    const { output, mutated } = maskLineContents(part);
    if (mutated) anyMutated = true;
    return output;
  });
  return anyMutated ? maskedParts.join("") : text;
}

/**
 * FIND-1-M (consolidated): Sanitize a single DB row, returning a NEW
 * shallow-cloned object whose `fields` columns have been run through
 * `maskPlaceholderPaths`. Other columns are passed through by
 * reference (shallow copy semantics).
 *
 * FIND-4-L: this function previously MUTATED its input row. Callers
 * that pass cached / DataLoader-backed rows would have polluted the
 * cache with masked values. Returning a fresh object eliminates that
 * footgun. The shallow-copy cost is one allocation per sanitised row;
 * negligible compared to the DB round-trip that produced the row.
 *
 * Use this at the response boundary — REST handlers, compliance
 * exports, query-builder result mappers — where rows go straight to
 * a serializer.
 */
export function sanitizeRowTextFields<T extends Record<string, unknown>>(
  row: T,
  fields: readonly string[],
): T {
  // FIND-4-L: shallow clone so mutations don't propagate to caches.
  const out: Record<string, unknown> = { ...row };
  for (const f of fields) {
    const v = out[f];
    if (typeof v === "string") {
      const masked = maskPlaceholderPaths(v);
      if (masked !== v) {
        // `masked !== null` here because `v` is a non-null string and
        // `maskPlaceholderPaths` preserves null-ness for string inputs.
        out[f] = masked;
      }
    }
  }
  return out as T;
}

/**
 * FIND-1-M (consolidated): Column name set used for turn rows across
 * every emission surface. Imports use this constant so drift between
 * resolvers / routes / exports can't surface.
 */
export const TURN_TEXT_FIELDS: readonly string[] = [
  "user_request_text",
  "response_text",
  "thinking_text",
];

/**
 * FIND-1-M (consolidated): Column name set for session rows.
 */
export const SESSION_TEXT_FIELDS: readonly string[] = ["initial_intent"];

/**
 * FIND-1-M (consolidated): Column name set for tool call rows.
 */
export const TOOL_CALL_TEXT_FIELDS: readonly string[] = [
  "tool_input",
  "output",
];

/**
 * FIND-6-C + FIND-7-J + FIND-10-E: Column name set for anomaly_event
 * rows.
 *
 * - `description`: quote-source from the triggering turn's
 *   `initial_intent` / `user_request_text` (may carry a
 *   `[Image: source: /path]` placeholder).
 * - `resolution_note`: operator-supplied text written by
 *   `resolveAnomaly` (migration 007 added the column). Operators
 *   commonly paste session context into resolution notes when
 *   triaging — e.g. "user re-attached a different image, see
 *   [Image: source: /path]". Without sanitisation, the operator
 *   note path leaks via /v1/query?queryType=anomalies.
 *
 * FIND-10-E (Round 10): the `metadata` JSONB column is NOT
 * bounded-shape contrary to the prior comment claim. The
 * `decision_outlier` anomaly path persists `tool_name` into
 * `metadata.toolName`, and any anomaly produced by a pre-Round-9
 * gateway (or an out-of-band batch importer) carries the raw path.
 * `sanitizeRowTextFields` only walks top-level string fields, so
 * `metadata` JSONB leaks. Use `sanitizeAnomalyRow` (below) instead
 * of `sanitizeRowTextFields` at the REST/GraphQL boundary for
 * anomaly rows — it covers both the top-level text fields AND the
 * one-level deep walk of `metadata`'s string values.
 */
export const ANOMALY_TEXT_FIELDS: readonly string[] = [
  "description",
  "resolution_note",
];

/**
 * FIND-10-E + FIND-11-D: deep-mask anomaly rows including the
 * `metadata` JSONB column. Top-level string fields are masked via
 * the same ANOMALY_TEXT_FIELDS list as before; additionally, every
 * string value reachable inside `metadata` is masked.
 *
 * FIND-11-D extends the walker from "one level deep" to "fully
 * recursive (depth-bounded)". The prior implementation missed:
 *   * arrays of strings (e.g.
 *     `{"evidence": ["[Image: source: /Users/x]", "/y"]}`)
 *   * nested objects (e.g. `{"evidence": {"path": "/Users/x"}}`)
 *   * top-level array metadata (e.g. `["/Users/x"]`)
 * The new walker handles all three without unbounded recursion: a
 * `MAX_DEPTH` cap of 4 prevents pathologically nested payloads from
 * blowing the stack, and depth=4 comfortably covers every shape the
 * anomaly persistence path emits today (the deepest observed is
 * `metadata.evidence[].sourceContext` at depth 3).
 *
 * The function is pure and shallow-copies (like
 * `sanitizeRowTextFields`) so caches and original rows stay
 * un-mutated.
 */
const MASK_JSONB_MAX_DEPTH = 4;

function maskJsonbValue(value: unknown, depth = 0): unknown {
  if (depth > MASK_JSONB_MAX_DEPTH) return value;
  if (typeof value === "string") {
    const masked = maskPlaceholderPaths(value);
    return masked ?? value;
  }
  if (Array.isArray(value)) {
    return value.map((v) => maskJsonbValue(v, depth + 1));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>)) {
      out[k] = maskJsonbValue((value as Record<string, unknown>)[k], depth + 1);
    }
    return out;
  }
  return value;
}

export function sanitizeAnomalyRow<T extends Record<string, unknown>>(
  row: T,
): T {
  const out = sanitizeRowTextFields(row, ANOMALY_TEXT_FIELDS) as Record<
    string,
    unknown
  >;
  // metadata may be a top-level string, array, or object — the
  // recursive walker handles all three. We only re-assign when the
  // value is non-null/undefined so we don't replace `null` metadata
  // with the JS object `null` (no-op but allocates).
  if (out.metadata !== undefined && out.metadata !== null) {
    out.metadata = maskJsonbValue(out.metadata);
  }
  return out as T;
}

/**
 * FIND-4-I: Derive a SQL regex pattern from the shared JSON allow-list.
 * Returns a PostgreSQL-compatible alternation of the prefix names with
 * the leading `[` and trailing `:` stripped — suitable for embedding
 * inside `regexp_replace(...)` patterns. Adding a prefix to the shared
 * JSON propagates to the SQL layer automatically; no second
 * source-of-truth.
 *
 * Result: `Image|PDF|Document|File|Attachment` (for the canonical list).
 */
export const SQL_PREFIX_NAMES: readonly string[] = PLACEHOLDER_PREFIXES.map(
  (p) => p.slice(1, -1),
);
export const SQL_PREFIX_ALTERNATION: string = SQL_PREFIX_NAMES.join("|");

/**
 * FIND-4-I + FIND-4-H: SQL `LIKE` patterns used to detect rows whose
 * text fields contain an attachment-sibling placeholder. Used by the
 * search resolver as a candidate-set REJECTION pre-filter when the
 * caller's query looks like a path probe. Path-probing defence
 * (FIND-3-TS-5) requires that ILIKE matches against the path SHAPE
 * never return rows; the simplest robust approach is:
 *   1. Detect "this query looks like a path probe" client-side.
 *   2. If so, exclude rows whose target column carries any placeholder
 *      shape (so the underlying path-shaped text can never match).
 *   3. Run the user's query against the remaining rows.
 *
 * The patterns below are LIKE-style (PG supports them via pg_trgm
 * indexes if installed; without them the scan is sequential, which is
 * acceptable on the search hot path because we already have a project-
 * scope predicate). The reason we don't use SQL `regexp_replace` to
 * normalise the placeholder INSIDE the predicate is FIND-4-H: PG ERE
 * lacks safe look-ahead support and `[^\]]*` mis-handles paths
 * containing `]`.
 */
export const placeholderLikePatterns: readonly string[] =
  PLACEHOLDER_PREFIXES.map((p) => `%${p} source: %`);

/**
 * FIND-3-TS-5 + FIND-4-H: returns true when the query string looks
 * like an attempt to probe a filesystem path through the search
 * surface. Triggers on absolute POSIX paths or query fragments that
 * contain a `/Users/` / `/home/` / `/tmp/` / `/var/` / `/etc/` segment.
 */
export function looksLikePathProbe(query: string): boolean {
  if (query.length === 0) return false;
  // FIND-7-K: absolute-POSIX-path fast-path runs BEFORE any
  // case-folding. The Round-6 ordering already had this fast-path
  // first, but the lowercase allocation also fires when no probe
  // segment matches. Pre-screen with a substring-of-substring
  // probe — if none of the canonical segment markers appear at all
  // (case-insensitively, via cheap charCode-aware comparison),
  // return false WITHOUT allocating a lowercased copy.
  if (query.startsWith("/") && query.length >= 2) return true;

  // FIND-6-L: tighten the heuristic. Segment matches now require the
  // path-like segment to start at a position where the character
  // before is either BEGINNING-OF-QUERY or whitespace, not any
  // substring position. This prevents false positives on legitimate
  // prose that happens to mention a path segment inline, e.g.:
  //
  //   "debug /etc/ failures in deployment"   → not a probe
  //   "recall the /tmp/ issue from yesterday" → not a probe
  //   "/etc/passwd"                           → probe (starts with /)
  //   "check /Users/victim/.claude"           → probe (whitespace +
  //                                              absolute path)
  //
  // FIND-7-K micro-opt: skip the lowercase allocation when no
  // probe-segment marker is present in the raw query at all. The
  // markers are ASCII; we can do a case-insensitive substring scan
  // by checking each marker against the raw query AND its
  // lowercase form ONLY for queries that contain at least one of
  // the marker characters (`/` or `.`). Common queries like
  // "claude-sonnet-4" or "[attachment]" short-circuit here without
  // any lowercase allocation.
  if (!query.includes("/") && !query.includes(".")) return false;
  const lower = query.toLowerCase();
  const probeSegments = [
    "/users/",
    "/home/",
    "/tmp/",
    "/var/",
    "/etc/",
    ".claude/",
    ".cache/",
    "image-cache/",
  ];
  for (const seg of probeSegments) {
    let idx = 0;
    while (idx !== -1) {
      idx = lower.indexOf(seg, idx);
      if (idx === -1) break;
      const preceding = idx === 0 ? "" : lower[idx - 1];
      // Start-of-query OR whitespace-preceded = path-probe-shaped.
      // Anything else (letter, digit, `-`, `.`, etc.) is prose that
      // happens to mention a path segment.
      if (idx === 0 || /\s/.test(preceding)) return true;
      idx += seg.length;
    }
  }
  return false;
}
