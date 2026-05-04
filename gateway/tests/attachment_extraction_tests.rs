//! Sprint P1B — Attachment extraction tests.
//!
//! Exercises the provider-specific extractors (Anthropic, OpenAI, Gemini)
//! plus the cross-cutting behaviors (size cap, external URL passthrough,
//! MIME sniffing, base64 decoding resilience). These tests do not hit the
//! DB or object store — they validate the pure-function extractor output.

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use recondo_gateway::capture::attachments::{
    extract_from_messages, AttachmentKind, MAX_ATTACHMENT_BYTES,
};
use serde_json::json;

// The shortest possible valid PNG: a 1x1 transparent image. Ships as a
// constant so every test exercises a real image header.
fn tiny_png_bytes() -> Vec<u8> {
    vec![
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, // PNG signature
        0x00, 0x00, 0x00, 0x0D, // IHDR length
        0x49, 0x48, 0x44, 0x52, // IHDR type
        0x00, 0x00, 0x00, 0x01, // width=1
        0x00, 0x00, 0x00, 0x01, // height=1
        0x08, 0x06, 0x00, 0x00, 0x00, // bit depth, color, compression, filter, interlace
        0x1F, 0x15, 0xC4, 0x89, // CRC
        0x00, 0x00, 0x00, 0x0A, // IDAT length
        0x49, 0x44, 0x41, 0x54, // IDAT type
        0x78, 0x9C, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, // IDAT data
        0x0D, 0x0A, 0x2D, 0xB4, // CRC
        0x00, 0x00, 0x00, 0x00, // IEND length
        0x49, 0x45, 0x4E, 0x44, // IEND type
        0xAE, 0x42, 0x60, 0x82, // CRC
    ]
}

fn tiny_jpeg_bytes() -> Vec<u8> {
    // Minimal JPEG magic bytes — enough for MIME sniffing. A real decoder
    // would reject this as truncated, but MIME detection only reads the first
    // three bytes.
    vec![0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10]
}

fn tiny_pdf_bytes() -> Vec<u8> {
    // `%PDF-` prefix is the authoritative PDF marker for MIME sniffing.
    b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n".to_vec()
}

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------

#[test]
fn anthropic_extracts_base64_image() {
    let png = tiny_png_bytes();
    let b64 = BASE64.encode(&png);
    let messages = vec![json!({
        "role": "user",
        "content": [
            { "type": "text", "text": "What's in this image?" },
            { "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": b64 } }
        ]
    })];

    let extracted = extract_from_messages("anthropic", &messages).expect("extraction must succeed");
    assert_eq!(extracted.len(), 1, "one image block -> one attachment");
    let a = &extracted[0];
    assert_eq!(a.kind, AttachmentKind::Image);
    assert_eq!(a.mime_type, "image/png", "sniffed mime wins over claimed");
    assert_eq!(a.role, "user");
    assert_eq!(a.sequence_num, 1);
    assert_eq!(a.bytes, png);
    assert!(a.source_url.is_none());
}

#[test]
fn anthropic_extracts_pdf_as_document_kind() {
    let pdf = tiny_pdf_bytes();
    let messages = vec![json!({
        "role": "user",
        "content": [
            {
                "type": "document",
                "source": { "type": "base64", "media_type": "application/pdf", "data": BASE64.encode(&pdf) },
                "title": "manual.pdf"
            }
        ]
    })];

    let extracted = extract_from_messages("anthropic", &messages).expect("extraction must succeed");
    assert_eq!(extracted.len(), 1);
    let a = &extracted[0];
    assert_eq!(a.kind, AttachmentKind::Pdf);
    assert_eq!(a.mime_type, "application/pdf");
    assert_eq!(a.filename.as_deref(), Some("manual.pdf"));
}

#[test]
fn anthropic_numbers_images_sequentially_across_messages() {
    let png = tiny_png_bytes();
    let jpg = tiny_jpeg_bytes();
    let messages = vec![
        json!({
            "role": "user",
            "content": [
                { "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": BASE64.encode(&png) } },
                { "type": "text", "text": "and" },
                { "type": "image", "source": { "type": "base64", "media_type": "image/jpeg", "data": BASE64.encode(&jpg) } }
            ]
        }),
        json!({
            "role": "user",
            "content": [
                { "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": BASE64.encode(&png) } }
            ]
        }),
    ];
    let extracted = extract_from_messages("anthropic", &messages).expect("extraction must succeed");
    assert_eq!(extracted.len(), 3);
    assert_eq!(extracted[0].sequence_num, 1);
    assert_eq!(extracted[1].sequence_num, 2);
    assert_eq!(extracted[2].sequence_num, 3);
    assert_eq!(extracted[1].mime_type, "image/jpeg");
}

#[test]
fn anthropic_url_source_becomes_external_image_url() {
    // Anthropic documents support `source.type = "url"` for external refs.
    // Extraction records the URL without fetching.
    let messages = vec![json!({
        "role": "user",
        "content": [
            {
                "type": "image",
                "source": { "type": "url", "url": "https://example.com/cat.png" }
            }
        ]
    })];
    let extracted = extract_from_messages("anthropic", &messages).expect("extraction must succeed");
    assert_eq!(extracted.len(), 1);
    assert_eq!(extracted[0].kind, AttachmentKind::ExternalImageUrl);
    assert_eq!(
        extracted[0].source_url.as_deref(),
        Some("https://example.com/cat.png")
    );
    assert!(extracted[0].bytes.is_empty());
}

#[test]
fn anthropic_ignores_text_only_messages() {
    let messages = vec![json!({
        "role": "user",
        "content": [ { "type": "text", "text": "just a prompt, no image" } ]
    })];
    let extracted = extract_from_messages("anthropic", &messages).expect("extraction must succeed");
    assert!(
        extracted.is_empty(),
        "text-only content must not produce attachments"
    );
}

// ---------------------------------------------------------------------------
// OpenAI
// ---------------------------------------------------------------------------

#[test]
fn openai_extracts_data_url_image() {
    let png = tiny_png_bytes();
    let data_url = format!("data:image/png;base64,{}", BASE64.encode(&png));
    let messages = vec![json!({
        "role": "user",
        "content": [
            { "type": "text", "text": "?" },
            { "type": "image_url", "image_url": { "url": data_url } }
        ]
    })];
    let extracted = extract_from_messages("openai", &messages).expect("extraction must succeed");
    assert_eq!(extracted.len(), 1);
    let a = &extracted[0];
    assert_eq!(a.kind, AttachmentKind::Image);
    assert_eq!(a.mime_type, "image/png");
    assert_eq!(a.bytes, png);
}

#[test]
fn openai_records_external_url_without_fetching() {
    // Non-data URL: extraction must NOT fetch. It records the URL as
    // external_image_url so a later pass (or the dashboard) can decide.
    let messages = vec![json!({
        "role": "user",
        "content": [
            { "type": "image_url", "image_url": { "url": "https://cdn.example.com/pic.jpg" } }
        ]
    })];
    let extracted = extract_from_messages("openai", &messages).expect("extraction must succeed");
    assert_eq!(extracted.len(), 1);
    assert_eq!(extracted[0].kind, AttachmentKind::ExternalImageUrl);
    assert_eq!(
        extracted[0].source_url.as_deref(),
        Some("https://cdn.example.com/pic.jpg")
    );
    assert!(
        extracted[0].bytes.is_empty(),
        "extractor must not fetch bytes"
    );
}

// ---------------------------------------------------------------------------
// Gemini
// ---------------------------------------------------------------------------

#[test]
fn gemini_extracts_inline_data_snake_case() {
    let png = tiny_png_bytes();
    let messages = vec![json!({
        "role": "user",
        "parts": [
            { "text": "explain" },
            { "inline_data": { "mime_type": "image/png", "data": BASE64.encode(&png) } }
        ]
    })];
    let extracted = extract_from_messages("gemini", &messages).expect("extraction must succeed");
    assert_eq!(extracted.len(), 1);
    assert_eq!(extracted[0].kind, AttachmentKind::Image);
    assert_eq!(extracted[0].mime_type, "image/png");
}

#[test]
fn gemini_extracts_inline_data_camel_case() {
    // Gemini docs accept both snake_case and camelCase inline data keys.
    // Our extractor must handle both — clients emit either.
    let png = tiny_png_bytes();
    let messages = vec![json!({
        "role": "user",
        "parts": [
            { "inlineData": { "mimeType": "image/png", "data": BASE64.encode(&png) } }
        ]
    })];
    let extracted = extract_from_messages("gemini", &messages).expect("extraction must succeed");
    assert_eq!(extracted.len(), 1);
    assert_eq!(extracted[0].kind, AttachmentKind::Image);
}

// ---------------------------------------------------------------------------
// Cross-cutting
// ---------------------------------------------------------------------------

#[test]
fn size_cap_drops_oversized_attachments() {
    // Build a base64 payload that decodes to just over the cap. Using 0x00
    // padding keeps it compressible but still over the byte limit.
    let oversized = vec![0u8; MAX_ATTACHMENT_BYTES + 1];
    let messages = vec![json!({
        "role": "user",
        "content": [
            { "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": BASE64.encode(&oversized) } }
        ]
    })];
    let extracted = extract_from_messages("anthropic", &messages).expect("extraction must succeed");
    assert!(
        extracted.is_empty(),
        "oversized attachments must be dropped (not truncated) so downstream never sees partial bytes"
    );
}

#[test]
fn mime_sniff_overrides_claimed_mime_on_mismatch() {
    // Client claims image/jpeg but sends PNG bytes. Extractor must return
    // the sniffed mime so downstream code doesn't trust a lying claim.
    let png = tiny_png_bytes();
    let messages = vec![json!({
        "role": "user",
        "content": [
            { "type": "image", "source": { "type": "base64", "media_type": "image/jpeg", "data": BASE64.encode(&png) } }
        ]
    })];
    let extracted = extract_from_messages("anthropic", &messages).expect("extraction must succeed");
    assert_eq!(extracted.len(), 1);
    assert_eq!(
        extracted[0].mime_type, "image/png",
        "sniffed PNG must override claimed JPEG"
    );
}

#[test]
fn invalid_base64_is_skipped_not_fatal() {
    // A malformed base64 payload must not fail the whole extraction. Other
    // attachments in the same message array should still come through.
    let png = tiny_png_bytes();
    let messages = vec![json!({
        "role": "user",
        "content": [
            { "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": "not-valid-base64!!!" } },
            { "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": BASE64.encode(&png) } }
        ]
    })];
    let extracted =
        extract_from_messages("anthropic", &messages).expect("extraction must return Ok");
    assert_eq!(extracted.len(), 1, "only the valid attachment survives");
    assert_eq!(extracted[0].bytes, png);
}

#[test]
fn empty_messages_yields_no_attachments() {
    for provider in ["anthropic", "openai", "gemini", "unknown"] {
        let extracted =
            extract_from_messages(provider, &[]).expect("empty messages must not error");
        assert!(
            extracted.is_empty(),
            "provider {} must return empty",
            provider
        );
    }
}

#[test]
fn same_bytes_decoded_twice_produces_identical_extraction() {
    // Content-addressed storage depends on byte-stable output. Extracting
    // the same payload twice must give byte-identical bytes (so sha256 is
    // stable downstream and dedup works).
    let png = tiny_png_bytes();
    let b64 = BASE64.encode(&png);
    let msg = json!({
        "role": "user",
        "content": [
            { "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": b64 } }
        ]
    });
    let first = extract_from_messages("anthropic", std::slice::from_ref(&msg)).unwrap();
    let second = extract_from_messages("anthropic", std::slice::from_ref(&msg)).unwrap();
    assert_eq!(first[0].bytes, second[0].bytes);
}

// ============================================================================
// FIND-9-B + FIND-9-H + FIND-9-L: data: URL scheme + MIME safety regression
// ============================================================================

/// FIND-9-B: `data:text/html;base64,<encoded HTML>` MUST NOT produce
/// an attachment. Round-8's FIND-8-D filtered by SCHEME but not MIME;
/// `text/html` passed through, decoded to bytes, and was stored as
/// `kind=Image` with mime="text/html" — clickjacking surface for the
/// dashboard renderer.
#[test]
fn data_url_text_html_is_rejected() {
    let html = b"<script>alert('xss')</script>";
    let url = format!("data:text/html;base64,{}", BASE64.encode(html));
    let msg = json!({
        "role": "user",
        "content": [
            { "type": "image_url", "image_url": { "url": url } }
        ]
    });
    let extracted = extract_from_messages("openai", std::slice::from_ref(&msg)).unwrap();
    assert!(
        extracted.is_empty(),
        "FIND-9-B: data:text/html must produce zero attachments, got {} (kinds: {:?})",
        extracted.len(),
        extracted
            .iter()
            .map(|a| a.mime_type.as_str())
            .collect::<Vec<_>>()
    );
}

/// FIND-9-B: `data:application/javascript;base64,...` MUST NOT produce
/// an attachment.
#[test]
fn data_url_application_javascript_is_rejected() {
    let js = b"alert(document.cookie)";
    let url = format!("data:application/javascript;base64,{}", BASE64.encode(js));
    let msg = json!({
        "role": "user",
        "content": [
            { "type": "image_url", "image_url": { "url": url } }
        ]
    });
    let extracted = extract_from_messages("openai", std::slice::from_ref(&msg)).unwrap();
    assert!(
        extracted.is_empty(),
        "FIND-9-B: data:application/javascript must reject"
    );
}

/// FIND-9-B: `data:text/plain` MUST be rejected too — gateway only
/// captures images / PDFs as attachments.
#[test]
fn data_url_text_plain_is_rejected() {
    let url = format!("data:text/plain;base64,{}", BASE64.encode(b"hello"));
    let msg = json!({
        "role": "user",
        "content": [
            { "type": "image_url", "image_url": { "url": url } }
        ]
    });
    let extracted = extract_from_messages("openai", std::slice::from_ref(&msg)).unwrap();
    assert!(
        extracted.is_empty(),
        "FIND-9-B: data:text/plain must reject"
    );
}

/// FIND-9-B sanity: `data:image/png` MUST succeed (the legitimate case).
#[test]
fn data_url_image_png_is_accepted() {
    let png = tiny_png_bytes();
    let url = format!("data:image/png;base64,{}", BASE64.encode(&png));
    let msg = json!({
        "role": "user",
        "content": [
            { "type": "image_url", "image_url": { "url": url } }
        ]
    });
    let extracted = extract_from_messages("openai", std::slice::from_ref(&msg)).unwrap();
    assert_eq!(extracted.len(), 1, "data:image/png must succeed");
    assert_eq!(extracted[0].kind, AttachmentKind::Image);
    assert_eq!(extracted[0].bytes, png);
}

/// FIND-9-B sanity: `data:application/pdf` MUST succeed (legitimate
/// case for OpenAI document uploads via image_url shape).
#[test]
fn data_url_application_pdf_is_accepted() {
    let pdf = b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n";
    let url = format!("data:application/pdf;base64,{}", BASE64.encode(pdf));
    let msg = json!({
        "role": "user",
        "content": [
            { "type": "image_url", "image_url": { "url": url } }
        ]
    });
    let extracted = extract_from_messages("openai", std::slice::from_ref(&msg)).unwrap();
    assert_eq!(extracted.len(), 1, "data:application/pdf must succeed");
    // sniff_mime detects %PDF-, returning application/pdf; the kind
    // is derived via classify_kind which maps document → Pdf.
    // For the image_url path the kind is Image (the OpenAI shape
    // doesn't differentiate); the important assertion is the bytes
    // round-trip.
    assert_eq!(extracted[0].bytes, pdf.to_vec());
}

/// FIND-9-H: explicit non-http/non-data schemes MUST produce zero
/// attachments and emit a warn-log. We can't observe the warn log
/// from a unit test directly, but the zero-attachment outcome is
/// the load-bearing assertion.
#[test]
fn javascript_scheme_is_rejected() {
    let msg = json!({
        "role": "user",
        "content": [
            { "type": "image_url", "image_url": { "url": "javascript:alert(1)" } }
        ]
    });
    let extracted = extract_from_messages("openai", std::slice::from_ref(&msg)).unwrap();
    assert!(
        extracted.is_empty(),
        "FIND-9-H: javascript: scheme must reject"
    );
}

#[test]
fn file_scheme_is_rejected() {
    let msg = json!({
        "role": "user",
        "content": [
            { "type": "image_url", "image_url": { "url": "file:///etc/passwd" } }
        ]
    });
    let extracted = extract_from_messages("openai", std::slice::from_ref(&msg)).unwrap();
    assert!(extracted.is_empty(), "FIND-9-H: file:// scheme must reject");
}

#[test]
fn vbscript_scheme_is_rejected() {
    let msg = json!({
        "role": "user",
        "content": [
            { "type": "image_url", "image_url": { "url": "vbscript:foo" } }
        ]
    });
    let extracted = extract_from_messages("openai", std::slice::from_ref(&msg)).unwrap();
    assert!(
        extracted.is_empty(),
        "FIND-9-H: vbscript: scheme must reject"
    );
}

#[test]
fn plain_text_url_is_rejected() {
    let msg = json!({
        "role": "user",
        "content": [
            { "type": "image_url", "image_url": { "url": "not-a-url-at-all" } }
        ]
    });
    let extracted = extract_from_messages("openai", std::slice::from_ref(&msg)).unwrap();
    assert!(extracted.is_empty(), "FIND-9-H: bare strings must reject");
}

/// FIND-9-L: `DATA:image/png;...` (uppercase scheme) must be
/// accepted per RFC 3986 case-insensitive scheme matching.
#[test]
fn data_url_uppercase_scheme_is_accepted() {
    let png = tiny_png_bytes();
    let url = format!("DATA:image/png;base64,{}", BASE64.encode(&png));
    let msg = json!({
        "role": "user",
        "content": [
            { "type": "image_url", "image_url": { "url": url } }
        ]
    });
    let extracted = extract_from_messages("openai", std::slice::from_ref(&msg)).unwrap();
    assert_eq!(
        extracted.len(),
        1,
        "FIND-9-L: DATA:image/png (uppercase scheme) must be accepted"
    );
}

/// FIND-9-L: `HTTPS://example.com/foo.png` (uppercase scheme) must
/// be classified as ExternalImageUrl.
#[test]
fn https_uppercase_scheme_classified_as_external() {
    let msg = json!({
        "role": "user",
        "content": [
            { "type": "image_url", "image_url": { "url": "HTTPS://example.com/foo.png" } }
        ]
    });
    let extracted = extract_from_messages("openai", std::slice::from_ref(&msg)).unwrap();
    assert_eq!(extracted.len(), 1, "FIND-9-L: HTTPS:// must be accepted");
    assert_eq!(extracted[0].kind, AttachmentKind::ExternalImageUrl);
}

// =========================================================================
// FIND-10-F + FIND-10-G + FIND-10-H regression tests
// =========================================================================

/// FIND-10-F: SVG via OpenAI's data: URL must be rejected. Round 9
/// allowed `image/*` glob, which accepted `image/svg+xml`. SVG is
/// XML and can carry `<script>` / onload payloads (stored XSS).
#[test]
fn data_url_image_svg_xml_is_rejected_openai() {
    // base64 of `<svg onload="alert(1)">`
    let svg_payload =
        BASE64.encode(b"<svg xmlns='http://www.w3.org/2000/svg' onload=\"alert(1)\"></svg>");
    let url = format!("data:image/svg+xml;base64,{}", svg_payload);
    let msg = json!({
        "role": "user",
        "content": [{ "type": "image_url", "image_url": { "url": url } }]
    });
    let extracted = extract_from_messages("openai", std::slice::from_ref(&msg)).unwrap();
    assert!(
        extracted.is_empty(),
        "FIND-10-F: image/svg+xml MUST be rejected (XSS surface)"
    );
}

/// FIND-10-G: Anthropic with `media_type: "text/html"` must be
/// rejected. Round 9 allowed any media_type on Anthropic; this is
/// an XSS bypass equivalent to FIND-9-B but on the Anthropic path.
#[test]
fn anthropic_text_html_media_type_is_rejected() {
    let msg = json!({
        "role": "user",
        "content": [{
            "type": "document",
            "source": {
                "type": "base64",
                "media_type": "text/html",
                "data": BASE64.encode(b"<html><body>hi</body></html>")
            }
        }]
    });
    let extracted = extract_from_messages("anthropic", std::slice::from_ref(&msg)).unwrap();
    assert!(
        extracted.is_empty(),
        "FIND-10-G: Anthropic media_type=text/html MUST be rejected"
    );
}

/// FIND-10-G: Anthropic with `media_type: "image/svg+xml"` must be
/// rejected (parallel to FIND-10-F for the OpenAI path).
#[test]
fn anthropic_image_svg_xml_media_type_is_rejected() {
    let msg = json!({
        "role": "user",
        "content": [{
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": "image/svg+xml",
                "data": BASE64.encode(b"<svg onload='alert(1)'></svg>")
            }
        }]
    });
    let extracted = extract_from_messages("anthropic", std::slice::from_ref(&msg)).unwrap();
    assert!(
        extracted.is_empty(),
        "FIND-10-G: Anthropic media_type=image/svg+xml MUST be rejected"
    );
}

/// FIND-10-G: Gemini with `mime_type: "text/html"` must be rejected.
#[test]
fn gemini_text_html_mime_type_is_rejected() {
    let msg = json!({
        "role": "user",
        "parts": [{
            "inline_data": {
                "mime_type": "text/html",
                "data": BASE64.encode(b"<html><body>hi</body></html>")
            }
        }]
    });
    let extracted = extract_from_messages("gemini", std::slice::from_ref(&msg)).unwrap();
    assert!(
        extracted.is_empty(),
        "FIND-10-G: Gemini mime_type=text/html MUST be rejected"
    );
}

/// FIND-10-G: Gemini with `mime_type: "image/svg+xml"` must be
/// rejected.
#[test]
fn gemini_image_svg_xml_mime_type_is_rejected() {
    let msg = json!({
        "role": "user",
        "parts": [{
            "inline_data": {
                "mime_type": "image/svg+xml",
                "data": BASE64.encode(b"<svg onload='alert(1)'></svg>")
            }
        }]
    });
    let extracted = extract_from_messages("gemini", std::slice::from_ref(&msg)).unwrap();
    assert!(
        extracted.is_empty(),
        "FIND-10-G: Gemini mime_type=image/svg+xml MUST be rejected"
    );
}

/// FIND-10-H: client claims `image/png` but sends `<svg onload>`
/// bytes. Round 9's `sniff_mime` returned None for SVG so the
/// claimed mime won and the row was persisted under image/png.
/// FIND-10-H makes `sniff_mime` return a hostile sentinel for any
/// payload starting with `<svg` / `<html` / `<!doctype html` /
/// `<script` / `<?xml`, which fails the allow-list and the
/// extractor drops the attachment.
#[test]
fn html_bytes_under_claimed_image_png_are_rejected() {
    // Anthropic path
    let html_bytes = b"<html><body><script>alert(1)</script></body></html>";
    let msg = json!({
        "role": "user",
        "content": [{
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": "image/png",
                "data": BASE64.encode(html_bytes)
            }
        }]
    });
    let extracted = extract_from_messages("anthropic", std::slice::from_ref(&msg)).unwrap();
    assert!(
        extracted.is_empty(),
        "FIND-10-H: HTML bytes under claimed image/png MUST be rejected (Anthropic)"
    );

    // OpenAI data: path
    let url_o = format!(
        "data:image/png;base64,{}",
        BASE64.encode(b"<svg onload='alert(1)'></svg>")
    );
    let msg_o = json!({
        "role": "user",
        "content": [{ "type": "image_url", "image_url": { "url": url_o } }]
    });
    let extracted_o = extract_from_messages("openai", std::slice::from_ref(&msg_o)).unwrap();
    assert!(
        extracted_o.is_empty(),
        "FIND-10-H: SVG bytes under claimed image/png MUST be rejected (OpenAI data:)"
    );

    // Gemini path
    let msg_g = json!({
        "role": "user",
        "parts": [{
            "inline_data": {
                "mime_type": "image/png",
                "data": BASE64.encode(b"<svg onload='alert(1)'></svg>")
            }
        }]
    });
    let extracted_g = extract_from_messages("gemini", std::slice::from_ref(&msg_g)).unwrap();
    assert!(
        extracted_g.is_empty(),
        "FIND-10-H: SVG bytes under claimed image/png MUST be rejected (Gemini)"
    );
}

/// FIND-10-H: payload with a UTF-8 BOM + leading whitespace before
/// `<svg` must still be sniffed as hostile. Defenders sometimes use
/// a tighter `starts_with(b"<svg")` and miss BOM-prefixed inputs.
#[test]
fn svg_with_leading_bom_and_whitespace_is_rejected() {
    let mut payload: Vec<u8> = vec![0xEF, 0xBB, 0xBF, b' ', b'\t', b'\n'];
    payload.extend_from_slice(b"<svg onload='alert(1)'></svg>");
    let url = format!("data:image/png;base64,{}", BASE64.encode(&payload));
    let msg = json!({
        "role": "user",
        "content": [{ "type": "image_url", "image_url": { "url": url } }]
    });
    let extracted = extract_from_messages("openai", std::slice::from_ref(&msg)).unwrap();
    assert!(
        extracted.is_empty(),
        "FIND-10-H: BOM + whitespace + <svg MUST be rejected"
    );
}

/// FIND-10-F sanity: image/jpeg via Anthropic (with valid JPEG magic
/// bytes) is still accepted — we tightened the allow-list, not
/// blocked legitimate content.
#[test]
fn anthropic_image_jpeg_still_accepted() {
    // Minimal JPEG magic.
    let jpeg = vec![
        0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, b'J', b'F', b'I', b'F', 0x00,
    ];
    let msg = json!({
        "role": "user",
        "content": [{
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": "image/jpeg",
                "data": BASE64.encode(&jpeg)
            }
        }]
    });
    let extracted = extract_from_messages("anthropic", std::slice::from_ref(&msg)).unwrap();
    assert_eq!(
        extracted.len(),
        1,
        "FIND-10-F sanity: image/jpeg with JPEG magic must still be accepted"
    );
    assert_eq!(extracted[0].mime_type, "image/jpeg");
}

// =========================================================================
// FIND-10-J: parse_errors writeback
// =========================================================================

use recondo_gateway::capture::attachments::extract_from_messages_with_errors;

/// FIND-10-J: rejecting an SVG via OpenAI's data: branch must
/// populate the parse_errors list with a structured entry, not just
/// a tracing::warn!. Round 9 claimed parse_errors writeback existed
/// but the rejection only emitted a log line.
#[test]
fn data_url_image_svg_xml_emits_parse_error_openai() {
    let url = format!(
        "data:image/svg+xml;base64,{}",
        BASE64.encode(b"<svg onload='alert(1)'></svg>")
    );
    let msg = json!({
        "role": "user",
        "content": [{ "type": "image_url", "image_url": { "url": url } }]
    });
    let (extracted, errors) =
        extract_from_messages_with_errors("openai", std::slice::from_ref(&msg)).unwrap();
    assert!(extracted.is_empty(), "FIND-10-F: must reject SVG");
    assert!(
        errors
            .iter()
            .any(|e| e.starts_with("attachment.mime_disallowed")
                && e.contains("provider=openai")
                && e.contains("image/svg+xml")),
        "FIND-10-J: parse_errors must contain a structured rejection entry; got: {:?}",
        errors
    );
}

/// FIND-10-J: text/html via Anthropic must produce a parse_errors entry.
#[test]
fn anthropic_text_html_emits_parse_error() {
    let msg = json!({
        "role": "user",
        "content": [{
            "type": "document",
            "source": {
                "type": "base64",
                "media_type": "text/html",
                "data": BASE64.encode(b"<html></html>")
            }
        }]
    });
    let (extracted, errors) =
        extract_from_messages_with_errors("anthropic", std::slice::from_ref(&msg)).unwrap();
    assert!(extracted.is_empty());
    assert!(
        errors.iter().any(
            |e| e.starts_with("attachment.mime_disallowed") && e.contains("provider=anthropic")
        ),
        "FIND-10-J: anthropic mime rejection must populate parse_errors; got: {:?}",
        errors
    );
}

/// FIND-10-J: HTML bytes under image/png via Anthropic must
/// produce a `attachment.bytes_hostile` parse error (not the
/// claimed-mime path; the bytes path).
#[test]
fn anthropic_html_bytes_under_image_png_emits_bytes_hostile_error() {
    let msg = json!({
        "role": "user",
        "content": [{
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": "image/png",
                "data": BASE64.encode(b"<html></html>")
            }
        }]
    });
    let (extracted, errors) =
        extract_from_messages_with_errors("anthropic", std::slice::from_ref(&msg)).unwrap();
    assert!(extracted.is_empty());
    assert!(
        errors
            .iter()
            .any(|e| e.starts_with("attachment.bytes_hostile") && e.contains("provider=anthropic")),
        "FIND-10-J: bytes_hostile rejection must populate parse_errors; got: {:?}",
        errors
    );
}

/// FIND-10-J: javascript: scheme via OpenAI must produce a
/// `attachment.scheme_disallowed` parse error.
#[test]
fn javascript_scheme_emits_parse_error() {
    let msg = json!({
        "role": "user",
        "content": [{ "type": "image_url", "image_url": { "url": "javascript:alert(1)" } }]
    });
    let (extracted, errors) =
        extract_from_messages_with_errors("openai", std::slice::from_ref(&msg)).unwrap();
    assert!(extracted.is_empty());
    assert!(
        errors.iter().any(|e| e.starts_with("attachment.scheme_disallowed")
            && e.contains("provider=openai")),
        "FIND-10-J: scheme rejection must populate parse_errors; got: {:?}",
        errors
    );
}

/// FIND-10-J sanity: a clean PNG produces zero parse errors.
#[test]
fn clean_png_produces_no_parse_errors() {
    let png = tiny_png_bytes();
    let url = format!("data:image/png;base64,{}", BASE64.encode(&png));
    let msg = json!({
        "role": "user",
        "content": [{ "type": "image_url", "image_url": { "url": url } }]
    });
    let (extracted, errors) =
        extract_from_messages_with_errors("openai", std::slice::from_ref(&msg)).unwrap();
    assert_eq!(extracted.len(), 1);
    assert!(
        errors.is_empty(),
        "FIND-10-J: a successful extraction must NOT add parse_errors; got: {:?}",
        errors
    );
}

/// FIND-11-G: payload prefixed with ≥256 bytes of whitespace before
/// `<svg onload>` must still be rejected. Round 10's `sniff_mime`
/// took `bytes.len().min(256)` BEFORE skipping whitespace, so
/// whitespace padding consumed the entire scan window and the
/// subsequent token check ran against an empty slice — bypass.
#[test]
fn whitespace_padded_svg_is_rejected() {
    // 300 bytes of mixed whitespace, well past the 256-byte cap.
    let mut payload: Vec<u8> = vec![b' '; 200];
    payload.extend(std::iter::repeat_n(b'\t', 50));
    payload.extend(std::iter::repeat_n(b'\n', 50));
    payload.extend_from_slice(b"<svg onload='alert(1)'></svg>");

    // Anthropic path
    let msg = json!({
        "role": "user",
        "content": [{
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": "image/png",
                "data": BASE64.encode(&payload)
            }
        }]
    });
    let extracted = extract_from_messages("anthropic", std::slice::from_ref(&msg)).unwrap();
    assert!(
        extracted.is_empty(),
        "FIND-11-G: whitespace-padded SVG MUST still be rejected via sniff_mime"
    );

    // OpenAI data: path
    let url = format!("data:image/png;base64,{}", BASE64.encode(&payload));
    let msg_o = json!({
        "role": "user",
        "content": [{ "type": "image_url", "image_url": { "url": url } }]
    });
    let extracted_o = extract_from_messages("openai", std::slice::from_ref(&msg_o)).unwrap();
    assert!(
        extracted_o.is_empty(),
        "FIND-11-G: whitespace-padded SVG MUST be rejected via OpenAI extractor"
    );
}

/// FIND-11-G regression: the original (non-padded) `<svg>` payload
/// is still rejected — fix must not regress the Round-10 behaviour.
#[test]
fn unpadded_svg_still_rejected_after_find_11_g() {
    let payload = b"<svg onload='alert(1)'></svg>";
    let msg = json!({
        "role": "user",
        "content": [{
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": "image/png",
                "data": BASE64.encode(payload)
            }
        }]
    });
    let extracted = extract_from_messages("anthropic", std::slice::from_ref(&msg)).unwrap();
    assert!(
        extracted.is_empty(),
        "FIND-11-G: unpadded SVG bytes must remain rejected"
    );
}

/// FIND-11-I: any payload led by a UTF-16/UTF-32 BOM is hostile —
/// no allow-listed binary format starts with one. The check fires
/// before any other sniff so the byte content past the BOM does
/// not matter.
#[test]
fn utf16_le_bom_is_rejected() {
    let mut payload: Vec<u8> = vec![0xFF, 0xFE];
    payload.extend_from_slice(b"<svg>");
    let msg = json!({
        "role": "user",
        "content": [{
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": "image/png",
                "data": BASE64.encode(&payload)
            }
        }]
    });
    let extracted = extract_from_messages("anthropic", std::slice::from_ref(&msg)).unwrap();
    assert!(
        extracted.is_empty(),
        "FIND-11-I: UTF-16 LE BOM-prefixed payload must be rejected"
    );
}

#[test]
fn utf16_be_bom_is_rejected() {
    let mut payload: Vec<u8> = vec![0xFE, 0xFF];
    payload.extend_from_slice(b"<svg>");
    let msg = json!({
        "role": "user",
        "content": [{
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": "image/png",
                "data": BASE64.encode(&payload)
            }
        }]
    });
    let extracted = extract_from_messages("anthropic", std::slice::from_ref(&msg)).unwrap();
    assert!(
        extracted.is_empty(),
        "FIND-11-I: UTF-16 BE BOM-prefixed payload must be rejected"
    );
}

#[test]
fn utf32_le_bom_is_rejected() {
    let mut payload: Vec<u8> = vec![0xFF, 0xFE, 0x00, 0x00];
    payload.extend_from_slice(b"<svg>");
    let msg = json!({
        "role": "user",
        "content": [{
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": "image/png",
                "data": BASE64.encode(&payload)
            }
        }]
    });
    let extracted = extract_from_messages("anthropic", std::slice::from_ref(&msg)).unwrap();
    assert!(
        extracted.is_empty(),
        "FIND-11-I: UTF-32 LE BOM-prefixed payload must be rejected"
    );
}

#[test]
fn utf32_be_bom_is_rejected() {
    let mut payload: Vec<u8> = vec![0x00, 0x00, 0xFE, 0xFF];
    payload.extend_from_slice(b"<svg>");
    let msg = json!({
        "role": "user",
        "content": [{
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": "image/png",
                "data": BASE64.encode(&payload)
            }
        }]
    });
    let extracted = extract_from_messages("anthropic", std::slice::from_ref(&msg)).unwrap();
    assert!(
        extracted.is_empty(),
        "FIND-11-I: UTF-32 BE BOM-prefixed payload must be rejected"
    );
}
