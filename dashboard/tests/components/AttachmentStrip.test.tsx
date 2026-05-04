/**
 * FIND-9-I: Tests for the AttachmentStrip component
 * (src/components/AttachmentStrip.tsx).
 *
 * Round-9 deliverable. The component is a security boundary: it
 * decides whether a URL coming in via API/GraphQL `attachment.url`
 * is safe to render as an `<a href>` / `<img src>`. Round-8's
 * FIND-8-D added scheme allow-listing in `resolveAttachmentUrl`;
 * Round-9's FIND-9-O extended that to reject protocol-relative
 * URLs (`//evil.com/x.png`). These tests pin the behaviour so a
 * future refactor cannot silently re-introduce a sink.
 *
 * Test matrix:
 *   POSITIVE — must render the URL (or a base-prefixed variant):
 *     • https://cdn.example.com/img.png       (external_image_url passthrough)
 *     • http://insecure.example.com/img.png   (also passthrough; lowercase
 *                                              is the spec, not a security
 *                                              decision — TLS is enforced
 *                                              elsewhere)
 *     • /v1/attachments/abc                   (relative API path)
 *   NEGATIVE — must produce the "unsupported URL" inert chip:
 *     • data:text/html,<script>alert(1)</script>   (FIND-8-D)
 *     • javascript:alert(1)                         (FIND-8-D)
 *     • file:///etc/passwd                          (FIND-8-D)
 *     • vbscript:msgbox(1)                          (FIND-8-D)
 *     • //evil.com/foo.png                          (FIND-9-O —
 *                                                    protocol-relative)
 */

import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

import { AttachmentStrip } from "@/components/AttachmentStrip";
import { setBaseUrl } from "@/api/client";
import type { AttachmentData } from "@/types/graphql";

// Centralised factory: keep assertions independent of unrelated
// AttachmentData fields. `url` is the only field under test here.
function attachment(overrides: Partial<AttachmentData> & { url: string }): AttachmentData {
  return {
    id: "att-test-id",
    turnId: "turn-test",
    sessionId: "sess-test",
    sequenceNum: 1,
    role: "user",
    kind: "external_image_url",
    mimeType: "image/png",
    sizeBytes: 12345,
    sha256: "abc123",
    filename: null,
    width: null,
    height: null,
    ...overrides,
  };
}

describe("AttachmentStrip — resolveAttachmentUrl scheme allow-list", () => {
  beforeEach(() => {
    // Pin a known API base so relative-path resolution is
    // deterministic; otherwise getBaseUrl() reflects whatever the
    // previous test mutated.
    setBaseUrl("http://api.test.local:4000");
  });

  // ---------------------------------------------------------------
  // POSITIVE: well-formed URLs must render and link out.
  // ---------------------------------------------------------------

  it("renders an <img> for https:// external URLs untouched", () => {
    render(
      <AttachmentStrip
        attachments={[
          attachment({ id: "p1", url: "https://cdn.example.com/safe.png" }),
        ]}
      />
    );
    const img = screen.getByRole("img");
    expect(img.getAttribute("src")).toBe("https://cdn.example.com/safe.png");
    // Must NOT render the inert/rejected chip for a safe URL.
    expect(screen.queryByText(/unsupported url/i)).not.toBeInTheDocument();
  });

  it("renders an <img> for http:// external URLs untouched", () => {
    render(
      <AttachmentStrip
        attachments={[
          attachment({ id: "p2", url: "http://insecure.example.com/img.png" }),
        ]}
      />
    );
    const img = screen.getByRole("img");
    expect(img.getAttribute("src")).toBe(
      "http://insecure.example.com/img.png"
    );
    expect(screen.queryByText(/unsupported url/i)).not.toBeInTheDocument();
  });

  it("rewrites relative /v1/... paths against the API base URL", () => {
    render(
      <AttachmentStrip
        attachments={[
          attachment({
            id: "p3",
            kind: "image",
            url: "/v1/attachments/abc-123",
          }),
        ]}
      />
    );
    const img = screen.getByRole("img");
    expect(img.getAttribute("src")).toBe(
      "http://api.test.local:4000/v1/attachments/abc-123"
    );
    expect(screen.queryByText(/unsupported url/i)).not.toBeInTheDocument();
  });

  // ---------------------------------------------------------------
  // NEGATIVE: hostile schemes must render the inert chip and never
  // appear in any `href` / `src` attribute on the page.
  // ---------------------------------------------------------------

  it.each<[string, string]>([
    ["data:text/html,<script>alert(1)</script>", "data: text/html"],
    ["javascript:alert(1)", "javascript:"],
    ["file:///etc/passwd", "file:///"],
    ["vbscript:msgbox(1)", "vbscript:"],
    // FIND-9-O: protocol-relative.
    ["//evil.com/foo.png", "protocol-relative //"],
  ])(
    "rejects %s (%s) and renders the inert unsupported-URL chip",
    (rawUrl, _label) => {
      render(
        <AttachmentStrip
          attachments={[
            attachment({
              id: "n-" + rawUrl,
              kind: "external_image_url",
              url: rawUrl,
            }),
          ]}
        />
      );

      // 1. The inert chip is rendered with the visible "unsupported URL"
      //    label.
      expect(screen.getByText(/unsupported url/i)).toBeInTheDocument();

      // 2. There must be NO <img> for this attachment.
      expect(screen.queryByRole("img")).not.toBeInTheDocument();

      // 3. There must be NO <a> with href containing the hostile URL.
      //    (queryAllByRole("link") returns []; if some other link slips
      //    in, none of them should carry the hostile scheme.)
      const links = screen.queryAllByRole("link");
      for (const a of links) {
        const href = a.getAttribute("href") ?? "";
        expect(href).not.toContain(rawUrl);
        expect(href).not.toMatch(/^(javascript|data|file|vbscript):/i);
        expect(href.startsWith("//")).toBe(false);
      }

      // 4. Defence-in-depth: scan the rendered DOM textually. None of
      //    the hostile URL fragments should appear in any attribute
      //    that the browser would treat as a navigation target.
      const allLinks = document.querySelectorAll("a, img");
      for (const node of Array.from(allLinks)) {
        const href = node.getAttribute("href") ?? "";
        const src = node.getAttribute("src") ?? "";
        expect(href).not.toContain(rawUrl);
        expect(src).not.toContain(rawUrl);
      }
    }
  );

  // FIND-10-F + FIND-11-H: defence-in-depth on the dashboard. The
  // dashboard mirrors the gateway's exact-match allow-list, so any
  // mime that isn't png/jpeg/jpg/gif/webp/pdf renders as the inert
  // chip — even if the gateway DB somehow holds a legacy row with
  // an unsafe mime. The Round-10 list (svg+xml, text/html,
  // application/javascript) was a denylist that missed several
  // common XSS-staging mimes (xhtml+xml, xml, x-svg, ecmascript).
  // The new test matrix exercises those new cases too.
  it.each<[string, string]>([
    ["image/svg+xml", "SVG"],
    ["IMAGE/SVG+XML", "SVG (uppercase)"],
    ["text/html", "HTML"],
    ["application/javascript", "JS"],
    // FIND-11-H additions:
    ["application/xhtml+xml", "XHTML"],
    ["text/xml", "text/xml"],
    ["application/xml", "application/xml"],
    ["image/x-svg", "image/x-svg"],
    ["text/javascript", "text/javascript"],
    ["application/x-javascript", "application/x-javascript"],
    ["application/ecmascript", "application/ecmascript"],
    // FIND-11-H: parameterised mime strings still match the allow-
    // list via `split(';')[0].trim()`, so this should be REJECTED
    // because text/html is not allow-listed even before the param.
    ["text/html; charset=utf-8", "text/html with charset param"],
  ])(
    "renders inert chip for unsafe mime %s (%s) even with a safe URL",
    (mime, _label) => {
      render(
        <AttachmentStrip
          attachments={[
            attachment({
              id: "fmime-" + mime,
              kind: "image",
              url: "https://cdn.example.com/legacy-row.bin",
              mimeType: mime,
            }),
          ]}
        />
      );
      // Inert chip rendered, no <img>, no <a> with the hostile URL.
      expect(screen.getByText(/unsupported url/i)).toBeInTheDocument();
      expect(screen.queryByRole("img")).not.toBeInTheDocument();
      const links = screen.queryAllByRole("link");
      for (const a of links) {
        const href = a.getAttribute("href") ?? "";
        expect(href).not.toContain("legacy-row.bin");
      }
    }
  );

  // FIND-11-H positive cases: the six allow-listed mimes must
  // continue to render normally. If a future refactor accidentally
  // tightens the allow-list, these tests fail loudly.
  it.each<[string, string]>([
    ["image/png", "PNG"],
    ["image/jpeg", "JPEG"],
    ["image/jpg", "JPG"],
    ["image/gif", "GIF"],
    ["image/webp", "WebP"],
    ["application/pdf", "PDF"],
    ["IMAGE/PNG", "PNG (uppercase)"],
    ["image/png; charset=binary", "PNG with binary charset param"],
  ])(
    "renders %s (%s) as a normal attachment",
    (mime, _label) => {
      const isImage = mime.toLowerCase().startsWith("image/");
      render(
        <AttachmentStrip
          attachments={[
            attachment({
              id: "safe-" + mime,
              kind: isImage ? "image" : "pdf",
              url: "https://cdn.example.com/safe-asset",
              mimeType: mime,
            }),
          ]}
        />
      );
      // Inert chip must NOT render.
      expect(screen.queryByText(/unsupported url/i)).not.toBeInTheDocument();
      if (isImage) {
        const img = screen.getByRole("img");
        expect(img.getAttribute("src")).toBe("https://cdn.example.com/safe-asset");
      } else {
        // PDF: link chip with href to the safe URL.
        const link = screen.getByRole("link");
        expect(link.getAttribute("href")).toBe("https://cdn.example.com/safe-asset");
      }
    }
  );

  it("does not coerce an empty string into the API base URL (still inert)", () => {
    // Defensive: an empty `url` field should not become
    // `http://api.test.local:4000/` — that would be a navigation
    // sink for "open in new tab" interactions. The component is
    // expected to short-circuit on falsy input.
    const { container } = render(
      <AttachmentStrip
        attachments={[
          attachment({ id: "n-empty", kind: "external_image_url", url: "" }),
        ]}
      />
    );
    // Either nothing renders for that row, or the chip renders inert.
    const links = container.querySelectorAll("a");
    for (const a of Array.from(links)) {
      // Empty href would resolve to current page; ensure it didn't
      // get filled with the API base URL.
      expect(a.getAttribute("href")).not.toBe(
        "http://api.test.local:4000/"
      );
    }
  });
});
