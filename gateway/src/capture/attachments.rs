//! Inline-attachment extraction.
//!
//! LLM API requests frequently carry binary payloads (images, PDFs) inline
//! with the JSON body. Each provider has its own shape:
//!
//! * Anthropic: `content[]` blocks with `type: "image"` (`{source:{type:"base64",media_type,data}}`)
//!   or `type: "document"` (same shape, PDF or text).
//! * OpenAI (Chat Completions): `content[]` parts with
//!   `type: "image_url"` where `image_url.url` is either a `data:` URL or an
//!   external `https://` URL.
//! * Gemini: `parts[]` with `inline_data: { mime_type, data }`.
//!
//! This module walks a parsed request's `messages` array once per turn and
//! produces a `Vec<ExtractedAttachment>`, each carrying the decoded raw
//! bytes plus metadata we need to write both the object-store blob and the
//! attachments DB row. It is intentionally agnostic about persistence —
//! `record_attachments` in the capture pipeline owns the upload + insert.
//!
//! Size-cap policy: any single attachment larger than [`MAX_ATTACHMENT_BYTES`]
//! is dropped with a `parse_errors`-visible warning. We never truncate — a
//! partial image is worse than no image because it looks valid on the wire.
//!
//! External URLs (OpenAI): extraction records them as kind="external_image_url"
//! without fetching. Fetch+rehost with SSRF guard is handled in a follow-up
//! pass by `fetch_and_rehost_external` so the extractor stays pure-CPU and
//! does not take out a network dependency when the only attachments are
//! inline base64.

use anyhow::{Context, Result};
use base64::{
    engine::general_purpose::{STANDARD, STANDARD_NO_PAD, URL_SAFE, URL_SAFE_NO_PAD},
    Engine as _,
};
use serde_json::Value;

/// Hard cap on a single attachment's decoded size (20 MiB). Oversized
/// attachments are skipped with a logged warning; the turn still captures.
pub const MAX_ATTACHMENT_BYTES: usize = 20 * 1024 * 1024;

/// The classification returned to the DB. Dashboard rendering dispatches on
/// this — "image" gets a thumbnail, "pdf" gets a download chip, etc.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AttachmentKind {
    Image,
    Pdf,
    Document,
    ExternalImageUrl,
    Other,
}

impl AttachmentKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Image => "image",
            Self::Pdf => "pdf",
            Self::Document => "document",
            Self::ExternalImageUrl => "external_image_url",
            Self::Other => "other",
        }
    }
}

/// A single attachment the gateway has pulled out of a request body. Bytes
/// are ready for hashing and object-store upload; the URL variant carries
/// no bytes because the source is remote (pending fetch+rehost).
#[derive(Debug, Clone)]
pub struct ExtractedAttachment {
    /// 1-based ordinal within the request, matching the order images
    /// appear in the message array. Matches `[Image #N]` placeholders.
    pub sequence_num: i64,
    /// "user" for turns initiated by the user; "assistant" for
    /// tool-result images that flow back into a subsequent turn.
    pub role: String,
    pub kind: AttachmentKind,
    /// Sniffed MIME (preferred) or claimed MIME (fallback). Never the
    /// raw claimed value unless sniffing failed.
    pub mime_type: String,
    pub bytes: Vec<u8>,
    pub filename: Option<String>,
    /// Only populated for [`AttachmentKind::ExternalImageUrl`]. `None` for
    /// inline-base64 attachments where the object comes from `bytes`.
    pub source_url: Option<String>,
}

/// Extract all inline attachments from a provider-agnostic message array.
/// Dispatches on `provider` to pick the right traversal.
///
/// Round 9 retains the legacy signature (attachments only). New
/// callers should prefer [`extract_from_messages_with_errors`]
/// (FIND-10-J), which also returns the structured parse-error list
/// — the rejection reasons (disallowed MIME, bytes-level sniff,
/// scheme rejection) that previously surfaced only as
/// `tracing::warn!` are now machine-readable, so callers can persist
/// them on the turn record's `parse_errors` column.
pub fn extract_from_messages(
    provider: &str,
    messages: &[Value],
) -> Result<Vec<ExtractedAttachment>> {
    let (attachments, _errors) = extract_from_messages_with_errors(provider, messages)?;
    Ok(attachments)
}

/// FIND-10-J: structured parse-error reporting for attachment
/// extraction. The reject reasons (disallowed MIME, hostile-bytes
/// sniff, scheme rejection, base64 decode failure, size-cap, etc.)
/// each push one line into the returned `Vec<String>` so callers can
/// surface them on the turn record's `parse_errors` JSONB column —
/// not just leave them in a tracing warn whose visibility is limited
/// to operators tailing logs.
///
/// The list is intentionally `Vec<String>` (not a typed enum) to
/// match the existing `parse_errors` schema in providers/google.rs
/// where each provider records human-readable reasons. Each entry
/// starts with a stable prefix (`attachment.mime_disallowed:`,
/// `attachment.bytes_hostile:`, etc.) so dashboards can group
/// rejections without parsing free-form text.
///
/// FIND-11-L: stable error prefixes emitted by this function and its
/// per-provider sub-extractors. Downstream consumers (dashboards,
/// alerts, log parsers) can switch on the prefix without re-parsing
/// the free-form tail. **DO NOT** rename or re-namespace these in
/// place — emit a new prefix and keep the old one alongside it for
/// at least one release if the rejection reason changes shape.
///
/// Stable prefixes:
/// * `attachment.mime_disallowed:` — the claimed (or post-sniff) mime
///   is not in the allow-list (`is_attachment_mime_allowed`).
/// * `attachment.bytes_hostile:` — `sniff_mime` returned the
///   `SNIFFED_HOSTILE_MIME` sentinel (SVG/HTML/script/XML markers,
///   UTF-16/32 BOM — see FIND-11-G/I).
/// * `attachment.scheme_disallowed:` — for OpenAI `image_url.url`
///   entries, the URL scheme was not `https`/`http`/`data`.
/// * `attachment.decode_failed:` — base64 decode rejected the payload
///   across all four engine variants.
/// * `attachment.too_large:` — payload exceeded the per-attachment
///   size cap.
///
/// FIND-13-Rust-3: payload-tail schema for the prefixes above. The
/// tail is a sequence of `key=value` tokens separated by single
/// spaces. The `provider=<anthropic|openai|gemini>` token is ALWAYS
/// present and is the first token — downstream consumers can rely
/// on it for routing/grouping. Other tokens are provider-specific:
///
///   * `block_type=<image|document>` — present for `provider=anthropic`
///     because Anthropic's wire format distinguishes image vs document
///     attachments at the block level. Omitted for OpenAI (single
///     block type — `image_url`) and Gemini (single inline block).
///   * `claimed_mime=<mime>` — claimed mime advertised by the client.
///     Present on `mime_disallowed` and `bytes_hostile`.
///   * `sniffed_mime=<mime|None>` — only on `bytes_hostile`.
///   * `scheme_preview=<first 32 chars of URL>` — only on
///     `scheme_disallowed`.
///   * `bytes=<usize>`, `cap=<usize>` — on `too_large`.
///   * `reason=<short string>` — on `decode_failed`.
///
/// Consumers that group/route on these prefixes should split the
/// tail on whitespace, then split each token on the first `=`.
/// Treat all tokens as optional except `provider=`. The free-form
/// tail (the value side of `reason=` etc.) MUST NOT be matched
/// against by automated consumers — it is allowed to change without
/// notice. To add a new key, prefer a new `<key>=<value>` token over
/// reshaping an existing one; tools that don't know the new key
/// will simply ignore it.
pub fn extract_from_messages_with_errors(
    provider: &str,
    messages: &[Value],
) -> Result<(Vec<ExtractedAttachment>, Vec<String>)> {
    let mut out = Vec::new();
    let mut errors: Vec<String> = Vec::new();
    let mut seq: i64 = 0;
    match provider {
        "anthropic" => extract_anthropic_with_errors(messages, &mut seq, &mut out, &mut errors)?,
        "openai" => extract_openai_with_errors(messages, &mut seq, &mut out, &mut errors)?,
        "google" | "gemini" => {
            extract_gemini_with_errors(messages, &mut seq, &mut out, &mut errors)?
        }
        // Generic / unknown providers: best-effort scan that handles the
        // common shapes without hard-coding a schema. Safe to return empty.
        _ => extract_generic(messages, &mut seq, &mut out, &mut errors)?,
    }
    Ok((out, errors))
}

/// Walk Anthropic's message array. Each message has a `content` array where
/// entries can be strings, `{type:"text"}`, `{type:"image", source:{...}}`,
/// or `{type:"document", source:{...}}`. We only care about image/document.
fn extract_anthropic_with_errors(
    messages: &[Value],
    seq: &mut i64,
    out: &mut Vec<ExtractedAttachment>,
    errors: &mut Vec<String>,
) -> Result<()> {
    for msg in messages {
        let role = msg
            .get("role")
            .and_then(|r| r.as_str())
            .unwrap_or("user")
            .to_string();
        let Some(content) = msg.get("content") else {
            continue;
        };
        // `content` may be a string (plain text message) or an array of blocks.
        let Some(blocks) = content.as_array() else {
            continue;
        };
        for block in blocks {
            let block_type = block.get("type").and_then(|v| v.as_str()).unwrap_or("");
            match block_type {
                "image" | "document" => {
                    match parse_anthropic_source_with_errors(block, block_type, &role, seq, errors)
                    {
                        Ok(Some(att)) => out.push(att),
                        Ok(None) => {}
                        Err(e) => return Err(e),
                    }
                }
                _ => {}
            }
        }
    }
    Ok(())
}

fn parse_anthropic_source_with_errors(
    block: &Value,
    block_type: &str,
    role: &str,
    seq: &mut i64,
    errors: &mut Vec<String>,
) -> Result<Option<ExtractedAttachment>> {
    // source.type can be "base64" (bytes inline) or "url" (external; rare
    // for Anthropic but permitted for document). We only handle base64 for
    // now; url is surfaced as ExternalImageUrl so the dashboard can still
    // link to it.
    let Some(source) = block.get("source") else {
        return Ok(None);
    };
    let source_type = source.get("type").and_then(|v| v.as_str()).unwrap_or("");
    let claimed_mime = source
        .get("media_type")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let filename = block
        .get("title")
        .or_else(|| block.get("filename"))
        .and_then(|v| v.as_str())
        .map(str::to_string);

    // FIND-10-G: claimed_mime allow-list at extraction time. Round 9
    // gated this only on the OpenAI data: branch; Anthropic accepted
    // any `media_type`, so a request with `media_type: "text/html"`
    // would be persisted as `Document, mime_type=text/html`. The
    // dashboard then linked to the bytes; if the dashboard's
    // attachment route ever drops `X-Content-Type-Options: nosniff`
    // (or the user opens the URL in a new tab), the browser renders
    // them as HTML and any embedded `<script>` runs.
    let claimed_lower = claimed_mime.to_ascii_lowercase();
    if !claimed_lower.is_empty() && !is_attachment_mime_allowed(&claimed_lower) {
        // FIND-10-J: structured parse-error so callers can persist
        // the rejection reason on the turn record's parse_errors
        // column, not just emit a tracing warn.
        errors.push(format!(
            "attachment.mime_disallowed: provider=anthropic block_type={} claimed_mime={}",
            block_type, claimed_mime
        ));
        tracing::warn!(
            claimed_mime = %claimed_mime,
            block_type = %block_type,
            "Anthropic attachment has disallowed claimed MIME; rejecting (FIND-10-G/F). \
             Allow-list: image/png, image/jpeg, image/gif, image/webp, application/pdf."
        );
        return Ok(None);
    }

    match source_type {
        "base64" => {
            let data = source
                .get("data")
                .and_then(|v| v.as_str())
                .context("anthropic attachment source.data missing")?;
            let bytes = match decode_base64(data) {
                Ok(b) => b,
                Err(reason) => {
                    // FIND-12-B: emit the stable `decode_failed`
                    // prefix the doc-comment promised. Round 11
                    // listed it among stable prefixes but only
                    // `tracing::warn!` fired, so the dashboard's
                    // parse_errors view never saw it.
                    errors.push(format!(
                        "attachment.decode_failed: provider=anthropic block_type={} reason={}",
                        block_type, reason
                    ));
                    return Ok(None);
                }
            };
            if bytes.len() > MAX_ATTACHMENT_BYTES {
                // FIND-12-B: emit the stable `too_large` prefix.
                errors.push(format!(
                    "attachment.too_large: provider=anthropic block_type={} bytes={} cap={}",
                    block_type,
                    bytes.len(),
                    MAX_ATTACHMENT_BYTES
                ));
                tracing::warn!(
                    size = bytes.len(),
                    max = MAX_ATTACHMENT_BYTES,
                    "Attachment exceeds size cap; skipping"
                );
                return Ok(None);
            }
            // FIND-10-H: bytes-level sniff. If the payload looks
            // like SVG/HTML/JS/XML, sniff_mime returns
            // SNIFFED_HOSTILE_MIME, which fails
            // is_attachment_mime_allowed and we drop the row.
            let sniffed = sniff_mime(&bytes);
            let mime = sniffed.unwrap_or(&claimed_mime).to_string();
            if !is_attachment_mime_allowed(&mime) {
                errors.push(format!(
                    "attachment.bytes_hostile: provider=anthropic claimed_mime={} sniffed_mime={:?}",
                    claimed_mime, sniffed
                ));
                tracing::warn!(
                    claimed_mime = %claimed_mime,
                    sniffed_mime = ?sniffed,
                    "Anthropic attachment failed bytes-level sniff (FIND-10-H); rejecting"
                );
                return Ok(None);
            }
            *seq += 1;
            let kind = classify_kind(block_type, &mime);
            Ok(Some(ExtractedAttachment {
                sequence_num: *seq,
                role: role.to_string(),
                kind,
                mime_type: if mime.is_empty() {
                    "application/octet-stream".to_string()
                } else {
                    mime
                },
                bytes,
                filename,
                source_url: None,
            }))
        }
        "url" => {
            let url = source
                .get("url")
                .and_then(|v| v.as_str())
                .context("anthropic attachment source.url missing")?
                .to_string();
            *seq += 1;
            Ok(Some(ExtractedAttachment {
                sequence_num: *seq,
                role: role.to_string(),
                kind: AttachmentKind::ExternalImageUrl,
                mime_type: claimed_mime,
                bytes: Vec::new(),
                filename,
                source_url: Some(url),
            }))
        }
        _ => Ok(None),
    }
}

/// Walk OpenAI chat-completion messages. `content` is either a string or an
/// array of `{type:"text"|"image_url", ...}` parts. For `image_url`, the
/// `image_url.url` field is either a `data:image/...;base64,...` URI or
/// a remote URL. We handle both — remote is flagged as
/// [`AttachmentKind::ExternalImageUrl`] and left for `fetch_and_rehost_external`.
fn extract_openai_with_errors(
    messages: &[Value],
    seq: &mut i64,
    out: &mut Vec<ExtractedAttachment>,
    errors: &mut Vec<String>,
) -> Result<()> {
    for msg in messages {
        let role = msg
            .get("role")
            .and_then(|r| r.as_str())
            .unwrap_or("user")
            .to_string();
        let Some(content) = msg.get("content") else {
            continue;
        };
        let Some(parts) = content.as_array() else {
            continue;
        };
        for part in parts {
            let part_type = part.get("type").and_then(|v| v.as_str()).unwrap_or("");
            if part_type != "image_url" {
                continue;
            }
            let Some(image_url_obj) = part.get("image_url") else {
                continue;
            };
            let Some(url) = image_url_obj.get("url").and_then(|v| v.as_str()) else {
                continue;
            };

            // FIND-9-L: scheme matching is case-insensitive per RFC 3986.
            // `DATA:` and `data:` must both be recognised. Check the
            // case-folded prefix length, then index the ORIGINAL
            // url so the payload's case-sensitive base64 is preserved.
            let scheme_is_data =
                url.len() >= 5 && url.as_bytes()[..5].eq_ignore_ascii_case(b"data:");
            // FIND-9-L (cont): http(s) prefix matching is also
            // case-insensitive. Compute once and bind to a name so
            // the `else if` below is a plain bool condition (clippy
            // `blocks_in_conditions`).
            let scheme_is_http = {
                let lower_u = url.to_ascii_lowercase();
                lower_u.starts_with("https://") || lower_u.starts_with("http://")
            };
            if scheme_is_data {
                let stripped = &url[5..];
                // Format: data:<mime>;base64,<payload>
                let Some(comma_idx) = stripped.find(',') else {
                    continue;
                };
                let header = &stripped[..comma_idx];
                let payload = &stripped[comma_idx + 1..];
                // Split off ";base64"; anything else in the header is a
                // parameter list we ignore.
                let (claimed_mime, is_base64) =
                    match header.split(';').collect::<Vec<_>>().as_slice() {
                        [mime] => ((*mime).to_string(), false),
                        [mime, rest @ ..] => (
                            (*mime).to_string(),
                            rest.iter().any(|p| p.eq_ignore_ascii_case("base64")),
                        ),
                        _ => (String::new(), false),
                    };
                // FIND-9-B (Round 9) + FIND-10-F (Round 10): MIME
                // allow-list. Round 9's wildcard `image/*` accepted
                // `image/svg+xml`, which is XML and can carry
                // `<script>` / onload payloads (stored XSS via
                // `data:image/svg+xml;base64,...`). Round 10
                // tightens to an exact match against
                // `is_attachment_mime_allowed` (no glob).
                let claimed_lower = claimed_mime.to_ascii_lowercase();
                if !claimed_lower.is_empty() && !is_attachment_mime_allowed(&claimed_lower) {
                    errors.push(format!(
                        "attachment.mime_disallowed: provider=openai claimed_mime={}",
                        claimed_mime
                    ));
                    tracing::warn!(
                        claimed_mime = %claimed_mime,
                        "OpenAI data-URL has disallowed MIME; rejecting (FIND-10-F). \
                         Allow-list: image/png, image/jpeg, image/gif, image/webp, \
                         application/pdf. Notable rejection: image/svg+xml \
                         (carries XML/script)."
                    );
                    continue;
                }
                if !is_base64 {
                    // URL-encoded payloads are rare in OpenAI requests and
                    // carry no well-defined bytes contract; skip until a
                    // real payload forces the issue.
                    continue;
                }
                let bytes = match decode_base64(payload) {
                    Ok(b) => b,
                    Err(reason) => {
                        // FIND-12-B: stable `decode_failed` prefix
                        // for the OpenAI data-URL branch.
                        errors.push(format!(
                            "attachment.decode_failed: provider=openai reason={}",
                            reason
                        ));
                        continue;
                    }
                };
                if bytes.len() > MAX_ATTACHMENT_BYTES {
                    // FIND-12-B: stable `too_large` prefix.
                    errors.push(format!(
                        "attachment.too_large: provider=openai bytes={} cap={}",
                        bytes.len(),
                        MAX_ATTACHMENT_BYTES
                    ));
                    tracing::warn!(
                        size = bytes.len(),
                        max = MAX_ATTACHMENT_BYTES,
                        "OpenAI data-URL attachment exceeds size cap; skipping"
                    );
                    continue;
                }
                // FIND-10-H: bytes-level sniff. If the payload's
                // first bytes look like SVG/HTML/JS/XML, sniff_mime
                // returns SNIFFED_HOSTILE_MIME — a sentinel that
                // fails is_attachment_mime_allowed. Round 9 used
                // `sniff_mime(...).unwrap_or(claimed)` and only
                // sniffed PNG/JPEG/GIF/WEBP/PDF magic bytes; HTML
                // and SVG returned None and the claimed mime won.
                // A client could claim image/png while sending
                // `<svg onload="alert(1)">` and the gateway would
                // store it under image/png. The hostile-bytes
                // sniff closes that path.
                let sniffed = sniff_mime(&bytes);
                let mime = sniffed.unwrap_or(&claimed_mime).to_string();
                if !is_attachment_mime_allowed(&mime) {
                    errors.push(format!(
                        "attachment.bytes_hostile: provider=openai claimed_mime={} sniffed_mime={:?}",
                        claimed_mime, sniffed
                    ));
                    tracing::warn!(
                        claimed_mime = %claimed_mime,
                        sniffed_mime = ?sniffed,
                        "OpenAI data-URL attachment failed bytes-level sniff (FIND-10-H); rejecting"
                    );
                    continue;
                }
                *seq += 1;
                out.push(ExtractedAttachment {
                    sequence_num: *seq,
                    role: role.clone(),
                    kind: AttachmentKind::Image,
                    mime_type: if mime.is_empty() {
                        "image/png".to_string()
                    } else {
                        mime
                    },
                    bytes,
                    filename: None,
                    source_url: None,
                });
            } else if scheme_is_http {
                *seq += 1;
                out.push(ExtractedAttachment {
                    sequence_num: *seq,
                    role: role.clone(),
                    kind: AttachmentKind::ExternalImageUrl,
                    mime_type: String::new(),
                    bytes: Vec::new(),
                    filename: None,
                    source_url: Some(url.to_string()),
                });
            } else {
                // FIND-8-D: explicitly reject any other URL scheme.
                // OpenAI's `image_url.url` per the public API spec
                // accepts only `data:` URIs and `http(s)://` URLs;
                // anything else (`javascript:`, `file://`, `vbscript:`,
                // bare strings, etc.) is malformed input or — at
                // worst — an attempt to plant an XSS-ish vector for
                // a downstream renderer. Log the parse-error and
                // SKIP. Pre-FIND-8-D this branch was an implicit
                // silent skip, which let bad URLs into the
                // captured-but-not-extracted state where a later
                // dashboard render (`<a href={url}>`) could load a
                // `data:text/html,...` URL the gateway never
                // validated. Now: filtered at extraction.
                let scheme_preview: String = url.chars().take(32).collect();
                errors.push(format!(
                    "attachment.scheme_disallowed: provider=openai scheme_preview={}",
                    scheme_preview
                ));
                tracing::warn!(
                    url_scheme_preview = %scheme_preview,
                    "OpenAI image_url has unsupported scheme (not data:|http:|https:); skipping"
                );
            }
        }
    }
    Ok(())
}

/// Walk Gemini's message array. Each entry has `parts[]` and each part may
/// carry `inline_data: { mime_type, data }` (camelCase is also accepted by
/// the API; handle both).
fn extract_gemini_with_errors(
    messages: &[Value],
    seq: &mut i64,
    out: &mut Vec<ExtractedAttachment>,
    errors: &mut Vec<String>,
) -> Result<()> {
    for msg in messages {
        let role = msg
            .get("role")
            .and_then(|r| r.as_str())
            .unwrap_or("user")
            .to_string();
        let Some(parts) = msg.get("parts").and_then(|v| v.as_array()) else {
            continue;
        };
        for part in parts {
            // Accept both snake_case and camelCase to match the API docs.
            let inline = part.get("inline_data").or_else(|| part.get("inlineData"));
            let Some(inline) = inline else { continue };
            let claimed_mime = inline
                .get("mime_type")
                .or_else(|| inline.get("mimeType"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            // FIND-10-G: claimed-mime allow-list at extraction time.
            // Round 9 left Gemini's `inline_data.mime_type` ungated;
            // a request with `mimeType: "text/html"` would persist
            // as a Document and reach the dashboard. Same surface as
            // FIND-9-B but on the Gemini path.
            let claimed_lower = claimed_mime.to_ascii_lowercase();
            if !claimed_lower.is_empty() && !is_attachment_mime_allowed(&claimed_lower) {
                errors.push(format!(
                    "attachment.mime_disallowed: provider=gemini claimed_mime={}",
                    claimed_mime
                ));
                tracing::warn!(
                    claimed_mime = %claimed_mime,
                    "Gemini attachment has disallowed claimed MIME; rejecting (FIND-10-G). \
                     Allow-list: image/png, image/jpeg, image/gif, image/webp, \
                     application/pdf."
                );
                continue;
            }
            let Some(data) = inline.get("data").and_then(|v| v.as_str()) else {
                continue;
            };
            let bytes = match decode_base64(data) {
                Ok(b) => b,
                Err(reason) => {
                    // FIND-12-B: stable `decode_failed` prefix.
                    errors.push(format!(
                        "attachment.decode_failed: provider=gemini reason={}",
                        reason
                    ));
                    continue;
                }
            };
            if bytes.len() > MAX_ATTACHMENT_BYTES {
                // FIND-12-B: stable `too_large` prefix.
                errors.push(format!(
                    "attachment.too_large: provider=gemini bytes={} cap={}",
                    bytes.len(),
                    MAX_ATTACHMENT_BYTES
                ));
                tracing::warn!(
                    size = bytes.len(),
                    max = MAX_ATTACHMENT_BYTES,
                    "Gemini attachment exceeds size cap; skipping"
                );
                continue;
            }
            // FIND-10-H: bytes-level sniff applied to Gemini too.
            let sniffed = sniff_mime(&bytes);
            let mime = sniffed.unwrap_or(&claimed_mime).to_string();
            if !is_attachment_mime_allowed(&mime) {
                errors.push(format!(
                    "attachment.bytes_hostile: provider=gemini claimed_mime={} sniffed_mime={:?}",
                    claimed_mime, sniffed
                ));
                tracing::warn!(
                    claimed_mime = %claimed_mime,
                    sniffed_mime = ?sniffed,
                    "Gemini attachment failed bytes-level sniff (FIND-10-H); rejecting"
                );
                continue;
            }
            *seq += 1;
            let kind = classify_kind_by_mime(&mime);
            out.push(ExtractedAttachment {
                sequence_num: *seq,
                role: role.clone(),
                kind,
                mime_type: if mime.is_empty() {
                    "application/octet-stream".to_string()
                } else {
                    mime
                },
                bytes,
                filename: None,
                source_url: None,
            });
        }
    }
    Ok(())
}

/// Best-effort scan for unknown providers. Handles the shapes observed
/// across the major providers: base64 under any of the common key names.
///
/// FIND-11-E: prior version constructed a local `sink: Vec<String>` and
/// dropped it on return, so MIME rejections (`attachment.mime_disallowed`),
/// hostile-bytes rejections (`attachment.bytes_hostile`), and
/// scheme-disallowed rejections silently disappeared for unknown
/// providers. The dispatcher now passes its own `errors` collector
/// through so generic-provider failures are reported the same way as
/// Anthropic / OpenAI / Gemini failures — visible in the capture
/// pipeline's structured logs and surface-able to dashboards/alerts.
fn extract_generic(
    messages: &[Value],
    seq: &mut i64,
    out: &mut Vec<ExtractedAttachment>,
    errors: &mut Vec<String>,
) -> Result<()> {
    // Fall back to Anthropic's extractor for generic providers — most
    // OpenAI-alike ones adopt the image-block shape.
    extract_anthropic_with_errors(messages, seq, out, errors)
}

/// FIND-12-B: Returns `Result<Vec<u8>, String>` so callers can push
/// `attachment.decode_failed:` parse-error entries to the per-turn
/// `errors` Vec — Round-11's doc-comment promised a stable
/// `decode_failed` prefix but the implementation only emitted a
/// tracing warn (the prefix never reached the dashboard's
/// `parse_errors` JSONB).
fn decode_base64(data: &str) -> Result<Vec<u8>, String> {
    // FIND-1-N fix: LLM-API clients send base64 in four different flavours
    // depending on provider quirks and transport. The RFC 4648 variants we
    // observe in the wild:
    //   1. STANDARD         — `+` `/` with padding (Anthropic inline images).
    //   2. STANDARD_NO_PAD  — `+` `/` without padding (some Anthropic SDK versions).
    //   3. URL_SAFE         — `-` `_` with padding (Gemini inline_data).
    //   4. URL_SAFE_NO_PAD  — `-` `_` without padding (OpenAI data URLs,
    //                         some Codex variants).
    // A strict STANDARD-only decode drops categories 2–4 entirely. Try each
    // engine in order; return the bytes from the first successful decode.
    //
    // Some clients also send base64 with embedded whitespace; strip common
    // whitespace before decoding so a line-wrapped payload still parses.
    let cleaned: String = data.chars().filter(|c| !c.is_whitespace()).collect();
    let bytes = cleaned.as_bytes();

    // Attempt each engine in priority order. First match wins. The
    // engines are `GeneralPurpose` concrete types so we can't put them
    // behind a `&dyn Engine` (the trait has generic methods and is not
    // dyn-compatible). Instead, chain `or_else` calls — each closure is
    // only evaluated when the previous decode failed, so the STANDARD
    // case pays no extra cost.
    let result = STANDARD
        .decode(bytes)
        .or_else(|_| STANDARD_NO_PAD.decode(bytes))
        .or_else(|_| URL_SAFE.decode(bytes))
        .or_else(|_| URL_SAFE_NO_PAD.decode(bytes));

    match result {
        Ok(b) => Ok(b),
        Err(e) => {
            // All four engines rejected the payload — the data is
            // genuinely corrupt. Errors are swallowed here because a
            // broken attachment should not fail the whole turn capture.
            tracing::warn!(
                error = %e,
                "Failed to base64-decode attachment payload with STANDARD / \
                 STANDARD_NO_PAD / URL_SAFE / URL_SAFE_NO_PAD engines"
            );
            Err(format!("{}", e))
        }
    }
}

/// FIND-10-F + FIND-10-G: shared MIME allow-list applied to every
/// extractor (Anthropic, OpenAI, Gemini, generic). Round 9's
/// FIND-9-B fix only applied to OpenAI's `data:` URL branch and used
/// a wildcard `image/*` glob — which accepts `image/svg+xml`. SVG is
/// XML and can carry `<script>` / `onload` payloads, so an attacker
/// can stage stored XSS by sending
/// `data:image/svg+xml;base64,<base64 of <svg onload=alert(1)>>`.
/// The list below is an EXACT match of the only formats the dashboard
/// is ever expected to render.
///
/// Notable rejections:
/// * `image/svg+xml` — XML; can carry script.
/// * `image/*` glob removed; allow-list is enumerated.
/// * `text/html`, `application/javascript`, `application/xml` —
///   common XSS vectors when the dashboard's renderer treats them
///   as fetchable references (cf. FIND-8-D, FIND-9-O on the
///   resolver side; this is the equivalent guard at extraction).
pub fn is_attachment_mime_allowed(mime: &str) -> bool {
    let lower = mime.to_ascii_lowercase();
    matches!(
        lower.as_str(),
        "image/png" | "image/jpeg" | "image/jpg" | "image/gif" | "image/webp" | "application/pdf"
    )
}

/// FIND-10-H: poison-mime sentinel returned by `sniff_mime` when the
/// payload's bytes look like SVG, HTML, JS, XML, or plain text. None
/// of these are in `is_attachment_mime_allowed`, so when an
/// extractor uses `sniff_mime(...).unwrap_or(claimed)` the resulting
/// MIME is guaranteed to fail the allow-list — the attachment is
/// rejected before any blob is written or row inserted. Sentinel is
/// chosen to be syntactically valid MIME but obviously not a media
/// type we serve, so it stands out in logs.
const SNIFFED_HOSTILE_MIME: &str = "application/x-recondo-rejected";

/// Magic-byte MIME sniff for the handful of formats we care about. Returns
/// a &'static str so the caller can fall back to the claimed mime by
/// comparison without borrow-checker gymnastics. We do NOT trust the claimed
/// mime alone because a client can misrepresent a payload to trick MIME-based
/// downstream code; sniff-first is the safer default.
///
/// FIND-10-H: extended to detect SVG (`<svg`), HTML (`<!doctype html`,
/// `<html`), `<script` tags, and XML (`<?xml`). When a payload starts
/// with one of those tokens we return `SNIFFED_HOSTILE_MIME`, which
/// fails `is_attachment_mime_allowed` — the extractor that called us
/// then drops the attachment. This closes the gap where a client
/// claimed `image/png` but sent `<script>alert(1)</script>` bytes;
/// pre-FIND-10-H the claimed mime won and the bytes were stored
/// under `image/png`, then served with `Content-Type: image/png`
/// (browsers may still render them as HTML if the dashboard opens
/// the URL in `target="_blank"` and the server's `X-Content-Type-
/// Options: nosniff` is missing).
fn sniff_mime(bytes: &[u8]) -> Option<&'static str> {
    // FIND-11-I: reject UTF-16 / UTF-32 BOM-prefixed payloads
    // outright. None of the allow-listed binary formats (PNG, JPEG,
    // GIF, WebP, PDF) begin with one of these BOMs, so any payload
    // that does is non-binary text masquerading as a media type.
    // Order: check UTF-32 LE (4 bytes) BEFORE UTF-16 LE (2 bytes)
    // because UTF-32 LE = `FF FE 00 00` shares its first two bytes
    // with UTF-16 LE = `FF FE` and we want the more specific match
    // for clarity in logs (both currently return the same sentinel,
    // but a future revision might differentiate).
    if bytes.starts_with(&[0xFF, 0xFE, 0x00, 0x00])
        || bytes.starts_with(&[0x00, 0x00, 0xFE, 0xFF])
        || bytes.starts_with(&[0xFF, 0xFE])
        || bytes.starts_with(&[0xFE, 0xFF])
    {
        return Some(SNIFFED_HOSTILE_MIME);
    }
    if bytes.len() >= 8 && bytes[..8] == [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A] {
        return Some("image/png");
    }
    if bytes.len() >= 3 && bytes[..3] == [0xFF, 0xD8, 0xFF] {
        return Some("image/jpeg");
    }
    if bytes.len() >= 6 && (&bytes[..6] == b"GIF87a" || &bytes[..6] == b"GIF89a") {
        return Some("image/gif");
    }
    if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    if bytes.len() >= 5 && &bytes[..5] == b"%PDF-" {
        return Some("application/pdf");
    }
    // FIND-10-H + FIND-11-G: text-bytes sniff for hostile formats.
    // Inspect the first 256 bytes after stripping a UTF-8 BOM and
    // any leading whitespace, then check for the markers that
    // indicate executable text.
    //
    // FIND-11-G: prior version capped the scan window at 256 bytes
    // BEFORE trimming whitespace, so an attacker could pad with
    // ≥256 whitespace bytes followed by `<svg onload=...>`. The
    // 256-cap consumed the entire scan, the trim collapsed it to
    // an empty slice, and token detection silently succeeded
    // (returned None). The bytes were then stored under whatever
    // claimed mime the client supplied (e.g. `image/png`) even
    // though the actual content was a hostile SVG.
    //
    // Fix: scan for the first non-whitespace byte across the FULL
    // input, then take up to 256 bytes starting at that position
    // for token matching. The whitespace-skipping is now bounded
    // only by the input length, not by an arbitrary 256-byte
    // window.
    // Skip UTF-8 BOM if present.
    let after_bom = if bytes.len() >= 3 && bytes[..3] == [0xEF, 0xBB, 0xBF] {
        &bytes[3..]
    } else {
        bytes
    };
    // Locate the first non-whitespace byte across the WHOLE input
    // (post-BOM). If the entire payload is whitespace, there's
    // nothing to inspect — fall through and return None.
    let trimmed_start = after_bom
        .iter()
        .position(|&b| !matches!(b, b' ' | b'\t' | b'\r' | b'\n' | 0x0B | 0x0C))
        .unwrap_or(after_bom.len());
    let scan_start = &after_bom[trimmed_start..];
    // Take up to 256 bytes of the trimmed payload for token
    // matching. The 256-byte cap bounds the work the matcher does
    // on huge payloads; the trim above ensures the cap doesn't
    // get burned by leading whitespace.
    let scan_len = scan_start.len().min(256);
    let scan = &scan_start[..scan_len];
    let lower: Vec<u8> = scan.iter().map(|b| b.to_ascii_lowercase()).collect();
    // Markers we treat as hostile. `<svg` is the canonical SVG
    // open-tag and the most common XSS staging surface; the rest
    // are belt-and-braces.
    //
    // FIND-13-D: PREFIX-ANCHORED MATCHING — the loop below uses
    // `lower.starts_with(tok)`, so each token MUST appear at the
    // very start of the payload (after BOM strip and leading-
    // whitespace skip performed above). Hostile content that is
    // EMBEDDED inside a legitimate-looking payload — for example a
    // file whose first bytes are valid PNG/JPEG/PDF magic followed
    // later by `<svg onload=...>` or `<script>` — is NOT detected
    // here. This is by design: prefix-anchored matching is O(scan)
    // worst-case and runs on every attachment; full-buffer regex
    // scanning would be too costly on large payloads.
    //
    // Defense-in-depth comes from two layers:
    //   1. `is_attachment_mime_allowed` rejects mime types outside
    //      the narrow allow-list (image/png, image/jpeg, image/gif,
    //      image/webp, application/pdf), so even if the sniff
    //      misses an embedded payload the claimed mime must still
    //      pass.
    //   2. The dashboard's `SAFE_MIMES` allow-list (see
    //      `dashboard/src/components/AttachmentStrip.tsx`) caps
    //      what the browser will render inline, regardless of what
    //      reaches storage.
    //
    // If the threat model expands (e.g. concatenated polyglot
    // files with hostile payloads after a magic-byte preamble),
    // bolt on a separate full-scan stage that runs only for the
    // PDF/image branches that are most prone to polyglots.
    const HOSTILE_TOKENS: &[&[u8]] = &[b"<svg", b"<!doctype html", b"<html", b"<script", b"<?xml"];
    for tok in HOSTILE_TOKENS {
        if lower.starts_with(tok) {
            return Some(SNIFFED_HOSTILE_MIME);
        }
    }
    None
}

fn classify_kind(block_type: &str, mime: &str) -> AttachmentKind {
    match block_type {
        "image" => AttachmentKind::Image,
        "document" => {
            if mime == "application/pdf" {
                AttachmentKind::Pdf
            } else {
                AttachmentKind::Document
            }
        }
        _ => classify_kind_by_mime(mime),
    }
}

/// Map a MIME type to the filesystem extension the gateway uses when naming
/// attachment objects. Intentionally narrow — unknown types land as `bin`
/// so the object-store path stays valid for anything we actually serve.
pub fn mime_to_ext(mime: &str) -> &'static str {
    match mime {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/svg+xml" => "svg",
        "application/pdf" => "pdf",
        "text/plain" => "txt",
        "text/markdown" => "md",
        "application/json" => "json",
        _ => "bin",
    }
}

fn classify_kind_by_mime(mime: &str) -> AttachmentKind {
    if mime.starts_with("image/") {
        AttachmentKind::Image
    } else if mime == "application/pdf" {
        AttachmentKind::Pdf
    } else if mime.starts_with("text/") || mime == "application/json" {
        AttachmentKind::Document
    } else {
        AttachmentKind::Other
    }
}

// ---------------------------------------------------------------------------
// External-URL fetch+rehost
// ---------------------------------------------------------------------------

/// Resolve an [`ExtractedAttachment`] whose kind is `ExternalImageUrl` by
/// downloading the remote bytes into the attachment record. On success the
/// attachment is rewritten as an inline image (kind=Image, bytes populated,
/// source_url=None) so downstream handling is identical to a base64 upload.
///
/// SSRF guard: the URL host is rejected if it resolves to an RFC1918 /
/// loopback / link-local address. A 5-second timeout prevents slowloris.
/// Response size is capped at [`MAX_ATTACHMENT_BYTES`]; anything larger is
/// dropped rather than truncated.
///
/// Returns `Ok(None)` when the URL is unsafe, the fetch fails, or the
/// response is over the cap — callers should leave the original metadata
/// row alone in that case (kind=external_image_url with source_url).
pub async fn fetch_and_rehost_external(url: &str) -> Result<Option<(Vec<u8>, String)>> {
    let parsed = match url::Url::parse(url) {
        Ok(u) => u,
        Err(e) => {
            tracing::warn!(url = %url, error = %e, "External attachment URL parse failed");
            return Ok(None);
        }
    };
    if !matches!(parsed.scheme(), "http" | "https") {
        tracing::warn!(url = %url, "External attachment URL not http(s); skipping");
        return Ok(None);
    }
    // Reject IP literal hosts that fall in private ranges. DNS-name hosts
    // still need resolution-time checks — reqwest does resolution and
    // will connect to whatever DNS returns, so a full fix requires a
    // resolver hook. This is a meaningful but not complete SSRF guard;
    // treat it as defense-in-depth pending a proper hook.
    if let Some(host) = parsed.host() {
        match host {
            url::Host::Ipv4(ip)
                if ip.is_loopback()
                    || ip.is_private()
                    || ip.is_link_local()
                    || ip.is_broadcast()
                    || ip.is_documentation()
                    || ip.is_unspecified() =>
            {
                tracing::warn!(url = %url, ip = %ip, "External attachment URL IP in reserved range; skipping");
                return Ok(None);
            }
            url::Host::Ipv6(ip) if ip.is_loopback() || ip.is_unspecified() => {
                tracing::warn!(url = %url, ip = %ip, "External attachment URL v6 reserved; skipping");
                return Ok(None);
            }
            _ => {}
        }
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .redirect(reqwest::redirect::Policy::limited(3))
        .build()
        .context("failed to build reqwest client")?;
    let resp = match client.get(url).send().await {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!(url = %url, error = %e, "External attachment fetch failed");
            return Ok(None);
        }
    };
    if !resp.status().is_success() {
        tracing::warn!(url = %url, status = %resp.status(), "External attachment non-2xx; skipping");
        return Ok(None);
    }
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_string();
    let bytes = match resp.bytes().await {
        Ok(b) => b.to_vec(),
        Err(e) => {
            tracing::warn!(url = %url, error = %e, "External attachment body read failed");
            return Ok(None);
        }
    };
    if bytes.len() > MAX_ATTACHMENT_BYTES {
        tracing::warn!(url = %url, size = bytes.len(), max = MAX_ATTACHMENT_BYTES, "External attachment too large; skipping");
        return Ok(None);
    }
    // FIND-10-F + FIND-10-H: also gate the rehost path on the
    // shared allow-list. A trusted-looking https:// URL that
    // serves SVG/HTML/JS bytes (or claims `Content-Type: image/png`
    // while serving HTML) must NOT be rehosted; the dashboard
    // would then serve the bytes from /v1/attachments/:id under
    // whatever mime we record, and a downstream renderer that
    // forgets `X-Content-Type-Options: nosniff` could execute
    // them.
    let sniffed = sniff_mime(&bytes);
    let mime = sniffed.unwrap_or(&content_type).to_string();
    if !is_attachment_mime_allowed(&mime) {
        tracing::warn!(
            url = %url,
            content_type = %content_type,
            sniffed_mime = ?sniffed,
            "External attachment failed allow-list / bytes-level sniff (FIND-10-F/H); skipping rehost"
        );
        return Ok(None);
    }
    Ok(Some((bytes, mime)))
}

#[cfg(test)]
mod tests {
    //! Unit tests for the private helpers (`sniff_mime`,
    //! `decode_base64`) plus the public extractor end-to-end paths
    //! that exercise the FIND-11-G/I and FIND-12-B fixes. The
    //! integration tests in `gateway/tests/attachment_*` exercise
    //! the full pipeline; this module focuses on the helpers that
    //! were previously untested at the unit level.
    //!
    //! FIND-12-D: regression coverage for the whitespace-bypass
    //! (FIND-11-G) and 4-BOM rejection (FIND-11-I) fixes which
    //! previously existed only as code without unit tests.
    //!
    //! FIND-12-B: coverage for the new `decode_failed` and
    //! `too_large` parse-error prefixes.
    use super::*;
    use serde_json::json;

    // ---- FIND-12-D: sniff_mime regression tests ----

    #[test]
    fn whitespace_padded_svg_returns_hostile_sentinel() {
        // 300+ whitespace bytes (mix of space, tab, CR, LF, VT,
        // FF) followed by `<svg ...>`. Pre-FIND-11-G the 256-byte
        // scan window was consumed entirely by leading whitespace
        // and the trim collapsed the slice to empty, so token
        // detection silently returned None. After the fix, the
        // first non-whitespace byte is found across the whole
        // input.
        let mut bytes = vec![b' '; 100];
        bytes.extend(vec![b'\t'; 50]);
        for _ in 0..25 {
            bytes.extend_from_slice(b"\r\n");
        }
        bytes.extend(vec![0x0B; 50]); // VT
        bytes.extend(vec![0x0C; 50]); // FF
        bytes.extend_from_slice(b"<svg onload=\"alert(1)\">");
        assert!(bytes.len() > 256, "padding must exceed 256 bytes");
        assert_eq!(sniff_mime(&bytes), Some(SNIFFED_HOSTILE_MIME));
    }

    #[test]
    fn whitespace_padded_png_still_sniffs_correctly() {
        // PNG magic preceded by whitespace must NOT be detected
        // as PNG (the magic check is at offset 0, not after
        // trim). This test pins the contract: leading whitespace
        // before binary magic means the bytes are not a real
        // image and we fall through to text-token matching,
        // which finds nothing and returns None. The point is to
        // pin behaviour, not to claim leading-whitespace PNGs
        // are valid.
        let mut bytes = vec![b' '; 100];
        bytes.extend_from_slice(&[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
        bytes.extend_from_slice(&[0u8; 100]);
        // No hostile token follows, no magic at offset 0 → None.
        assert_eq!(sniff_mime(&bytes), None);
    }

    #[test]
    fn pure_whitespace_returns_none() {
        let bytes = vec![b' '; 1024];
        assert_eq!(sniff_mime(&bytes), None);
    }

    #[test]
    fn utf16_le_bom_returns_hostile_sentinel() {
        // 0xFF 0xFE = UTF-16 LE BOM (note: 4-byte UTF-32 LE BOM
        // is FF FE 00 00 — also covered, distinct test).
        let mut bytes = vec![0xFF, 0xFE];
        bytes.extend_from_slice(b"<some text>");
        assert_eq!(sniff_mime(&bytes), Some(SNIFFED_HOSTILE_MIME));
    }

    #[test]
    fn utf16_be_bom_returns_hostile_sentinel() {
        let mut bytes = vec![0xFE, 0xFF];
        bytes.extend_from_slice(b"<some text>");
        assert_eq!(sniff_mime(&bytes), Some(SNIFFED_HOSTILE_MIME));
    }

    #[test]
    fn utf32_le_bom_returns_hostile_sentinel() {
        let mut bytes = vec![0xFF, 0xFE, 0x00, 0x00];
        bytes.extend_from_slice(b"hello");
        assert_eq!(sniff_mime(&bytes), Some(SNIFFED_HOSTILE_MIME));
    }

    #[test]
    fn utf32_be_bom_returns_hostile_sentinel() {
        let mut bytes = vec![0x00, 0x00, 0xFE, 0xFF];
        bytes.extend_from_slice(b"hello");
        assert_eq!(sniff_mime(&bytes), Some(SNIFFED_HOSTILE_MIME));
    }

    // ---- FIND-12-B: decode_failed / too_large parse-error tests ----

    #[test]
    fn data_url_invalid_base64_emits_decode_failed_error() {
        // Anthropic image block with a base64 payload that fails
        // every engine (STANDARD, STANDARD_NO_PAD, URL_SAFE,
        // URL_SAFE_NO_PAD). The doc-comment on
        // extract_from_messages_with_errors promised a stable
        // `attachment.decode_failed:` prefix; pre-FIND-12-B this
        // was a tracing-only warn.
        let messages = json!([
            {
                "role": "user",
                "content": [
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": "image/png",
                            // Contains characters not valid in
                            // any of the four base64 alphabets:
                            // `*` is not in the standard table
                            // and not URL-safe.
                            "data": "not_valid_base64***!!!"
                        }
                    }
                ]
            }
        ]);
        let messages = messages.as_array().unwrap();
        let (atts, errors) =
            extract_from_messages_with_errors("anthropic", messages).expect("extract");
        assert_eq!(atts.len(), 0, "decode failure must drop the attachment");
        assert!(
            errors
                .iter()
                .any(|e| e.starts_with("attachment.decode_failed:")),
            "expected attachment.decode_failed prefix in errors: {:?}",
            errors
        );
    }

    #[test]
    fn data_url_oversized_payload_emits_too_large_error() {
        // 21 MiB of 0x89 bytes (base64-encoded). The decoded
        // payload exceeds MAX_ATTACHMENT_BYTES (20 MiB) so the
        // size-cap branch fires. Pre-FIND-12-B this was a
        // tracing-only warn.
        //
        // We use the OpenAI data-URL path because it's the
        // shortest construction (one branch, no nested source
        // object) and the cap logic is identical across the
        // three providers.
        let oversized: Vec<u8> = vec![0x89; MAX_ATTACHMENT_BYTES + 1024 * 1024];
        let b64 = STANDARD.encode(&oversized);
        let data_url = format!("data:image/png;base64,{}", b64);
        let messages = json!([
            {
                "role": "user",
                "content": [
                    {
                        "type": "image_url",
                        "image_url": { "url": data_url }
                    }
                ]
            }
        ]);
        let messages = messages.as_array().unwrap();
        let (atts, errors) =
            extract_from_messages_with_errors("openai", messages).expect("extract");
        assert_eq!(atts.len(), 0, "oversize must drop the attachment");
        assert!(
            errors
                .iter()
                .any(|e| e.starts_with("attachment.too_large:")),
            "expected attachment.too_large prefix in errors: {:?}",
            errors
        );
    }

    // ---- decode_base64 happy-path sanity check ----

    #[test]
    fn decode_base64_accepts_all_four_engines() {
        // STANDARD with padding.
        assert_eq!(decode_base64("aGVsbG8=").unwrap(), b"hello");
        // STANDARD_NO_PAD.
        assert_eq!(decode_base64("aGVsbG8").unwrap(), b"hello");
        // URL_SAFE — `?` payload that uses `_` (URL-safe `/`).
        // Use bytes that base64 to a `_`/`-` to exercise the
        // URL-safe alphabet specifically.
        let urlsafe = URL_SAFE.encode([0xFB, 0xFF, 0xFE]);
        assert_eq!(decode_base64(&urlsafe).unwrap(), vec![0xFB, 0xFF, 0xFE]);
        // URL_SAFE_NO_PAD.
        let urlsafe_no_pad = URL_SAFE_NO_PAD.encode([0xFB, 0xFF, 0xFE]);
        assert_eq!(
            decode_base64(&urlsafe_no_pad).unwrap(),
            vec![0xFB, 0xFF, 0xFE]
        );
    }

    #[test]
    fn decode_base64_rejects_garbage() {
        let res = decode_base64("not_valid_base64***!!!");
        assert!(res.is_err());
    }
}
