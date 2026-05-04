-- 012_turns-request-hash-index.sql
--
-- FIND-1-1 (adversarial workflow round 2): the orphan-recovery startup
-- hook in the gateway (`gateway/src/capture/recovery.rs`) probes
-- `turns.request_hash` once per on-disk capture metadata file to decide
-- whether the file is a true orphan or just a non-orphan whose row was
-- written by the live capture path. Without this index the probe falls
-- back to a sequential scan of `turns`, which (a) blocks the gateway's
-- TCP listener admission for O(N) on every boot and (b) makes the
-- recovery hook quadratic in the captures-dir size, with the
-- captures-dir growing unboundedly because no code path deletes
-- capture metadata files today.
--
-- The probe pattern is `WHERE request_hash = $1 LIMIT 1`, an
-- equality predicate well served by a single-column btree.
--
-- Note: the migration runner (node-pg-migrate) wraps each migration
-- in a transaction, so `CREATE INDEX CONCURRENTLY` is incompatible.
-- The plain `CREATE INDEX IF NOT EXISTS` here takes a brief
-- `SHARE` lock on `turns` during build. For deployments with very
-- large `turns` tables that cannot tolerate the lock, run the index
-- build manually with `CONCURRENTLY` outside the migration runner
-- before deploying the new gateway:
--   `psql ... -c "CREATE INDEX CONCURRENTLY IF NOT EXISTS
--    idx_turns_request_hash ON turns (request_hash);"`
-- and then re-run migrations; the IF NOT EXISTS makes the migration
-- a no-op once the index is present.
--
-- The `prevent_turn_mutation` immutability trigger added in
-- `003_triggers-indexes.sql` only fires on row-level INSERT/UPDATE/
-- DELETE — not on schema changes — so this index can be added
-- without bypassing the audit-log invariant.

CREATE INDEX IF NOT EXISTS idx_turns_request_hash ON turns (request_hash);

COMMENT ON INDEX idx_turns_request_hash IS
    'Backs the orphan-recovery dedup probe (find_turn_by_request_hash). '
    'Added in adversarial workflow round 2 — see FIND-1-1.';
