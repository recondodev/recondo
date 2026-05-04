# Database Migrations

`api/migrations/` is the single source of truth for the PostgreSQL schema.
All schema changes — new tables, columns, indexes, constraints — must be expressed
as migration files in that directory. Never apply DDL manually.

## Naming convention

The existing migrations (001–006) use a sequential `NNN_description.sql` naming
convention where `NNN` is a zero-padded three-digit sequence number and
`description` is a short kebab-case summary of what the migration does.

Examples of the sequential convention used by existing files:

```
001_core-tables.sql
002_api-tables.sql
006_add-notification-system.sql
```

New migrations created via `just api-migrate-create <name>` will receive a
**timestamp prefix** by default — this is the standard `node-pg-migrate`
behavior (e.g. `1711234567890_add-notification-system.sql`). Both
timestamp-prefixed and sequential files are valid; node-pg-migrate applies
them in lexicographic (alphabetical) order, so sequential `NNN_` files will
always sort before any future timestamp-prefixed files.

## How to create a new migration

Use the `just api-migrate-create` command, which generates a correctly-named
file in `api/migrations/`:

```bash
just api-migrate-create <name>
# e.g.
just api-migrate-create add-notification-system
```

This calls `npm run migrate create -- <name>` (node-pg-migrate) under the hood,
which creates a timestamped or sequenced file for you to fill in.

Write your `UP` SQL (and optionally `DOWN` SQL) in the generated file, then
apply it locally with:

```bash
just api-migrate
```

## How to test a migration locally

1. Start the local dev database:

   ```bash
   just dev-infra
   ```

2. Apply all pending migrations against the local dev database:

   ```bash
   just api-migrate
   ```

3. Verify the schema is correct by connecting to PostgreSQL:

   ```bash
   psql postgres://recondo:recondo_dev@localhost:5432/recondo
   ```

4. Run the API tests to confirm nothing is broken:

   ```bash
   just api-test
   ```

## Rollback

To roll back the last applied migration:

```bash
just api-migrate-down
```

This calls `npm run migrate down` (node-pg-migrate) which reverses the most
recently applied migration. Only use this during local development — never roll
back migrations in production without a coordinated deployment plan.

## Warning: never edit applied migrations

**Never edit or delete a migration file that has already been applied** to any
environment (local, staging, or production). The migration runner tracks which
files have been applied; modifying an applied migration will cause checksum
failures or schema drift.

If you need to change something introduced by an applied migration, create a new
migration file that alters or fixes it.

## Docker / fullstack

When running the fullstack Docker Compose setup (`just fullstack`), a dedicated
`migrations` init service runs `npm run migrate up` before the `gateway` and
`api` services start. Both services declare `depends_on: migrations:
condition: service_completed_successfully`, so they only start after all
migrations have been applied successfully.

The `migrations` service uses:

```
DATABASE_URL=postgres://recondo:recondo_dev@postgres:5432/recondo
```

Note the hostname is `postgres` (the Docker Compose service name), not
`localhost`.

## Reference

- Migration files: `api/migrations/`
- Apply all migrations: `just api-migrate`
- Create a migration: `just api-migrate-create <name>`
- Roll back last migration: `just api-migrate-down`
