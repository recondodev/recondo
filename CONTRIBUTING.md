# Contributing to Recondo

Thanks for your interest in contributing.

## Prerequisites

- [Rust](https://rustup.rs/) (stable)
- [just](https://github.com/casey/just) (recommended)
- [Docker](https://docs.docker.com/get-docker/) (for the PostgreSQL + MiniStack dev stack)

## Local development

```bash
just setup              # one-time: installs cargo-nextest
just build              # fmt + clippy + build
just test               # all tests via nextest (~10 seconds)
just ci                 # fmt + clippy + test (what CI runs)
```

Or without `just`:

```bash
cd gateway && cargo build
cd gateway && cargo nextest run --features test-support
cd gateway && cargo clippy --features test-support --tests -- -D warnings
```

## Filing a pull request

1. **Open an issue first** if you're proposing a substantive change. A 2-line description that lets us agree on direction beats a 500-line surprise PR.
2. **Branch from `main`.** Use a descriptive branch name (`fix/openai-sse-edge-case`, `feat/redaction-rules`).
3. **Keep PRs focused.** One logical change per PR. Refactors and feature changes should be separate.
4. **Add tests.** Every behavioral change needs at least one test. The repo's testing convention is anti-fake assertions — tests should fail if the implementation is replaced with a stub.
5. **Run `just ci` locally** before pushing. CI runs fmt + clippy + the full test suite; failing locally first is faster than failing in CI.
6. **Write a clear PR description.** What changed, why, and what reviewers should look at first.

## Code style

- **Rust:** `cargo fmt` + `cargo clippy -- -D warnings`. The CI gate is strict — clippy warnings fail the build.
- **TypeScript (api/, dashboard/):** `prettier` + `tsc --strict`.
- **Comments:** prefer code that explains itself. Add comments only when the *why* is non-obvious — a hidden constraint, a workaround, an invariant a reader would otherwise miss.
- **Imports/dependencies:** before adding a new dependency, check whether the standard library or an existing dep covers it. Dependency churn is expensive.

## Repo layout

- `gateway/` — Rust gateway (the TLS-MITM proxy + capture pipeline + CLI)
- `api/` — TypeScript GraphQL API
- `dashboard/` — React + Vite dashboard
- `compliance/` — provider compatibility / control-mapping reference docs
- `docs/` — design notes and reference documentation
- `deploy/` — Terraform (AWS) and local-dev init scripts (PostgreSQL bootstrap + MiniStack AWS resources)

## Reporting bugs and security issues

- **Bugs:** open an issue with the bug-report template.
- **Security vulnerabilities:** see [`SECURITY.md`](SECURITY.md). Do **not** file public issues for vulnerabilities.

## Code of conduct

This project follows the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md). By participating you agree to abide by it.

## License

Recondo is currently licensed under the [Apache License 2.0](LICENSE).

By submitting a contribution (pull request, patch, or any other form), you agree that:

1. You have the right to submit the contribution (it is your original work, or you have permission from the rights-holder to submit it under these terms).
2. Your contribution is licensed under the project's current license, the Apache License 2.0.
3. Your contribution may be re-licensed by the project maintainers under any OSI-approved or source-available license adopted by the project in the future, without requiring additional consent from you.

Clause 3 preserves the project's ability to evolve its license (for example, to a Business Source License with a future Apache conversion) without needing to track down every past contributor. If you are not comfortable with this, please do not submit contributions.
