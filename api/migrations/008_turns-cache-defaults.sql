-- Migration 008: Add DEFAULT 0 to turns cache token columns.
--
-- Root cause: migration 001 copied cache_read_tokens/cache_creation_tokens from
-- the gateway DDL as BIGINT NOT NULL (correct — gateway always writes these).
-- Test fixtures in 14 test files omit these columns, relying on a DEFAULT that
-- didn't exist. This migration adds DEFAULT 0 so fixture inserts that omit
-- cache token columns produce 0 rather than a NOT NULL violation.
--
-- Semantically correct: a turn with no cache reads/writes has 0 tokens, not NULL.
-- Gateway behavior is unchanged — it always provides explicit values.

ALTER TABLE turns
  ALTER COLUMN cache_read_tokens SET DEFAULT 0,
  ALTER COLUMN cache_creation_tokens SET DEFAULT 0;
