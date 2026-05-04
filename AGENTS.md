# Repository Guidelines

## Project Structure & Module Organization
`gateway/` contains the Rust proxy and CLI; core modules live in `gateway/src/*` and suites live in `gateway/tests/*_tests.rs`. `api/` is a Fastify + GraphQL TypeScript service with runtime code in `api/src`, SQL migrations in `api/migrations`, generated schema types in `api/src/generated`, and Vitest coverage in `api/tests`. `dashboard/` is a Vite + React frontend with UI code in `dashboard/src` and browser tests in `dashboard/tests`. Deployment assets live under `deploy/` (`helm`, `terraform`, `local-dev`), and design notes live in `docs/`.

## Build, Test, and Development Commands
Prefer `just` from the repo root:

- `just build`: format, lint, and build the Rust gateway.
- `just test`: run the gateway suite with `cargo nextest`.
- `just ci`: run the same gateway checks used in CI.
- `just dev-setup`: start PostgreSQL + MiniStack and apply API migrations.
- `just api-dev` / `just dashboard-dev`: start the API on `:4000` and dashboard on `:5173`.
- `just api-test`: boot the API against `recondo_test` and run Vitest.
- `just test-pg`: run PostgreSQL-backed gateway tests.

For package-local work, use `cd api && npm run build`, `cd api && npm run codegen`, and `cd dashboard && npm run build`.

## Coding Style & Naming Conventions
Rust uses standard `rustfmt` formatting and must pass `cargo clippy -- -D warnings`; keep modules grouped by domain under `gateway/src/<area>/mod.rs`. TypeScript is `strict` in both `api` and `dashboard`; follow the existing style: 2-space indentation, double quotes, semicolons, `PascalCase.tsx` for React components/pages, and descriptive lower-case file names for API modules and tests. Do not hand-edit generated GraphQL types in `api/src/generated/graphql.ts`; regenerate from `api/codegen.ts`.

## Testing Guidelines
Name TS tests `*.test.ts` or `*.test.tsx`; gateway suites use `*_tests.rs`. API tests share a database and run sequentially, so keep fixtures isolated and deterministic. Run the narrowest relevant suite before opening a PR, then re-run the package-level command (`just test`, `just api-test`, or `cd dashboard && npm test`).

## Commit & Pull Request Guidelines
Recent history uses short imperative subjects, often with a sprint prefix, for example `Sprint D1: Dashboard polish...` or `Fix API test suite: ...`. Follow that pattern. PRs should state which surface changed (`gateway`, `api`, `dashboard`, `deploy`), list verification commands, call out migration or infra changes explicitly, and include screenshots for dashboard-visible changes.

## Security & Configuration Tips
Treat API migrations as the single source of truth for PostgreSQL schema changes. Never commit secrets, `.env` files, or local gateway artifacts from `~/.recondo/`.
