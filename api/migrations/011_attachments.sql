-- Migration 011: Attachments table + turns.attachment_count.
--
-- Captures image / PDF / document uploads that clients send inline with
-- chat completions (base64 in Anthropic, data URLs + external URLs in
-- OpenAI, inline_data in Gemini). The gateway extracts these at capture
-- time and stores the raw bytes in the object store (content-addressed
-- by SHA-256). This table holds the metadata that links an attachment
-- to its parent turn and points at the stored object.
--
-- Content addressing: the same image uploaded in two different requests
-- will share a single object (object_ref points at the same hash) but
-- get two rows here so we keep the parent-turn relationship intact.
--
-- Retention: attachments inherit session retention via the ON DELETE
-- CASCADE from turns; object cleanup is handled out-of-band by the
-- pipeline so a failed DB delete doesn't orphan objects.

CREATE TABLE IF NOT EXISTS attachments (
    id               TEXT PRIMARY KEY,
    turn_id          TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
    -- Denormalized from turn.session_id so API auth scoping can check
    -- session ownership without a join on every attachment read.
    session_id       TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    -- 1-based ordinal within the turn's request. Matches the "[Image #N]"
    -- placeholder the gateway writes into user_request_text, so the UI
    -- can swap placeholders for actual renderings.
    sequence_num     INTEGER NOT NULL,
    -- 'user' for attachments the user sent, 'assistant' for tool-result
    -- images / documents that flow back from tools.
    role             TEXT NOT NULL,
    -- Coarse classification: image | pdf | document | external_image_url |
    -- other. Drives dashboard rendering (thumbnail vs download chip).
    kind             TEXT NOT NULL,
    mime_type        TEXT NOT NULL,
    size_bytes       BIGINT NOT NULL,
    -- SHA-256 of the raw decoded bytes (not the base64 envelope).
    sha256           TEXT NOT NULL,
    -- Object store reference: S3 key (prod) or filesystem path (dev).
    object_ref       TEXT NOT NULL,
    -- Client-supplied filename when present. Never trusted for display;
    -- always sanitize before rendering in the browser.
    filename         TEXT,
    -- Only meaningful for images; null for PDFs / other documents.
    width            INTEGER,
    height           INTEGER,
    extracted_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index on turn_id for the Turn.attachments resolver's batch loader.
CREATE INDEX IF NOT EXISTS idx_attachments_turn
    ON attachments(turn_id);

-- Index on sha256 so dedup lookups ("do we already have this object?")
-- and content-verification queries are O(log n).
CREATE INDEX IF NOT EXISTS idx_attachments_sha
    ON attachments(sha256);

-- Denormalized count on turns so the feed + turn summary can render a
-- paperclip / count badge without a subquery. Incremented by the gateway
-- at capture time.
ALTER TABLE turns
    ADD COLUMN IF NOT EXISTS attachment_count INTEGER NOT NULL DEFAULT 0;
