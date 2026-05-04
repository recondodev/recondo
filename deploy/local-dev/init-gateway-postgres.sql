-- Minimal PostgreSQL init for the Recondo gateway.
-- The gateway creates its own schema on startup via pg_schema_ddl.rs.
-- This file only ensures the database and extensions exist.

-- Enable extensions the gateway may need
CREATE EXTENSION IF NOT EXISTS pgcrypto;
