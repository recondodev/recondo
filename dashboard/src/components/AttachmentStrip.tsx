import type { AttachmentData } from "../types/graphql";
import { getBaseUrl } from "../api/client";

// FIND-12-C: hoisted to module scope. Pre-Round-12 this Set was
// constructed on every iteration of `attachments.map()` —
// allocated per render per attachment, no caching. Module-scope
// Set is built once at import time; the runtime cost is amortised
// across every <AttachmentStrip> mount.
//
// FIND-10-F + FIND-11-H: defence-in-depth on the dashboard side
// — the gateway's `is_attachment_mime_allowed`
// (gateway/src/capture/attachments.rs) blocks unsafe MIMEs at
// extraction time; this allow-list mirrors that EXACTLY so any
// new mime added there must be added here as well.
const SAFE_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
  "application/pdf",
]);

/** Resolve an attachment URL for use in `<img src>` / download links.
 *
 *  The API returns a relative path (e.g. /v1/attachments/:id); the browser
 *  would otherwise resolve that against the dashboard origin (:3000) and
 *  miss the API (:4000). Absolute https?:// URLs pass through untouched so
 *  external_image_url kinds still work.
 *
 *  FIND-8-D: previously also passed `data:` URIs through. The gateway
 *  extractor decodes inline data URIs into bytes and stores them as
 *  `kind=image` (so the API serves them via /v1/attachments/:id, not
 *  via a raw data: URL), so a `data:` URL reaching this resolver
 *  necessarily came from the `external_image_url` path — i.e. an LLM
 *  request that put `data:text/html;...` in `image_url.url`. The
 *  gateway-side `extract_openai` (FIND-8-D) now rejects non-data: /
 *  non-http(s) schemes at extraction time, but defence-in-depth on
 *  the dashboard: refuse to render anything that isn't https?://.
 *  Unsupported schemes return an empty string, so the surrounding
 *  `<a href>` becomes inert and the `<img src>` never attempts to
 *  load `data:text/html,<script>...`.
 *
 *  Returns "" (empty) for any URL that fails the safety check. The
 *  caller renders the chip with no link target.
 */
function resolveAttachmentUrl(raw: string): string {
  if (!raw) return raw;
  // FIND-9-O: protocol-relative URLs (e.g. `//evil.com/foo.png`).
  // The browser would resolve `//evil.com/foo.png` against the
  // current origin's scheme — under the dashboard's https:// origin
  // that becomes `https://evil.com/foo.png`, which would then load
  // arbitrary cross-origin content. The scheme allow-list below
  // checks for `[a-z]+:` (a colon-prefixed scheme), so a string
  // starting with `//` slips past it. Reject explicitly.
  if (raw.startsWith("//")) return "";
  // Absolute URL — only allow https:// or http://. Drop data:,
  // javascript:, file://, vbscript:, etc. for XSS safety.
  if (/^[a-z]+:/i.test(raw)) {
    if (/^https?:/i.test(raw)) return raw;
    return "";
  }
  const base = getBaseUrl().replace(/\/$/, "");
  return `${base}${raw.startsWith("/") ? "" : "/"}${raw}`;
}

/**
 * Renders a horizontal strip of attachment previews.
 *
 * Images render as thumbnails; PDFs and other documents render as named
 * chips with a download link. Clicking an image opens it in a new tab at
 * full resolution — we don't build a lightbox here; the browser's native
 * image viewer covers the common case and keeps this component small.
 *
 * Layout: flex wrap so rows of images reflow on narrow session detail
 * panels. Width-capped so a single oversized screenshot doesn't blow out
 * the turn card.
 */
export function AttachmentStrip({ attachments }: { attachments: AttachmentData[] }) {
  if (!attachments || attachments.length === 0) return null;
  return (
    <div className="attachment-strip">
      {attachments.map((a) => {
        const url = resolveAttachmentUrl(a.url);
        // FIND-8-D: when resolveAttachmentUrl rejects the scheme it
        // returns "". Render an inert chip with a warning marker
        // instead of `<a href="">` (which the browser would treat
        // as the current page).
        //
        // FIND-10-F + FIND-11-H: defence-in-depth on the dashboard
        // side. The gateway's `is_attachment_mime_allowed` blocks
        // unsafe MIMEs at extraction time; the dashboard mirrors
        // that allow-list exactly so a legacy row (uploaded by an
        // older gateway, or imported out-of-band) cannot bypass
        // the dashboard's safety check.
        //
        // FIND-11-H: prior denylist mode missed several mimes:
        // application/xhtml+xml, text/xml, application/xml,
        // image/x-svg, text/javascript, application/x-javascript,
        // application/ecmascript. An attacker controlling the
        // gateway DB (or a pre-Round-10 capture) could pin any
        // of these and the dashboard would happily render them.
        // The module-scope `SAFE_MIMES` allow-list is the EXACT
        // mirror of the gateway's `is_attachment_mime_allowed`
        // (gateway/src/capture/attachments.rs); any new mime added
        // there must be added here as well. (FIND-12-C: hoisted
        // out of the .map() callback to avoid per-attachment
        // re-allocation.)
        const baseMime = (a.mimeType ?? "")
          .toLowerCase()
          .split(";")[0]
          .trim();
        // If mimeType is non-empty AND not in the allow-list, treat
        // as forbidden. An empty mimeType is handled by the URL
        // check below (we don't try to render a typeless link).
        const mimeForbidden = a.mimeType != null && a.mimeType !== "" && !SAFE_MIMES.has(baseMime);
        if (url === "" || mimeForbidden) {
          return (
            <span
              key={a.id}
              className="attachment-chip attachment-chip-rejected"
              title={
                mimeForbidden
                  ? `Disallowed MIME (${a.mimeType}) — render blocked for safety`
                  : `Unsupported URL scheme — render blocked for safety`
              }
            >
              <span className="attachment-chip-icon">!</span>
              <span className="attachment-chip-label">unsupported URL</span>
            </span>
          );
        }
        if (a.kind === "image" || a.kind === "external_image_url") {
          return (
            <a
              key={a.id}
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="attachment-thumb-link"
              title={a.filename ?? `Image #${a.sequenceNum}`}
            >
              <img src={url} alt={a.filename ?? `Image ${a.sequenceNum}`} />
            </a>
          );
        }
        const label = a.filename ?? labelForKind(a);
        return (
          <a
            key={a.id}
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="attachment-chip"
            title={`${a.mimeType} · ${formatSize(a.sizeBytes)}`}
          >
            <span className="attachment-chip-icon">{iconForKind(a.kind)}</span>
            <span className="attachment-chip-label">{label}</span>
            <span className="attachment-chip-size">{formatSize(a.sizeBytes)}</span>
          </a>
        );
      })}
    </div>
  );
}

function iconForKind(kind: string): string {
  // Minimal, dependency-free. If we adopt an icon library later, swap here.
  switch (kind) {
    case "pdf":
      return "PDF";
    case "document":
      return "DOC";
    default:
      return "FILE";
  }
}

function labelForKind(a: AttachmentData): string {
  switch (a.kind) {
    case "pdf":
      return `Attachment #${a.sequenceNum} (PDF)`;
    case "document":
      return `Attachment #${a.sequenceNum} (document)`;
    default:
      return `Attachment #${a.sequenceNum}`;
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
