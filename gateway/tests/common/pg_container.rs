//! Ephemeral postgres container for integration tests.
//!
//! Replaces the previous "expect `RECONDO_DB_URL` to point at a running
//! `recondo_test` DB" pattern with a self-contained `OnceLock`-backed
//! container. The first call into [`url`] from any test in a binary
//! starts a `postgres:17-alpine` container, runs `api/migrations/*.sql`
//! against it via `node-pg-migrate`, and returns its connection URL.
//! Subsequent calls return the same URL.
//!
//! # Lifetime
//!
//! The container is owned by a process-scoped `OnceLock`. It is
//! cleaned up automatically when the test binary exits — testcontainers
//! installs a Drop impl on `ContainerAsync` that calls `docker rm -f`.
//!
//! # Why one container per binary, not one per workspace
//!
//! cargo nextest runs each `tests/*.rs` integration test as its own
//! OS process. A `OnceLock` is per-process. The trade-off is N
//! containers vs. cross-process coordination; we take N containers
//! because they start in parallel (~5s each) and isolation is total —
//! no advisory-lock dance, no `recondo_test` shared state, no risk
//! of one binary's destructive DDL evicting a peer.

use std::sync::OnceLock;
use testcontainers::{ContainerAsync, ImageExt};
use testcontainers_modules::postgres::Postgres;
use tokio::runtime::Runtime;

/// Process-static tokio runtime used to spawn AND tear down the
/// container. Required because testcontainers-rs's `ContainerAsync`
/// Drop impl calls `tokio::runtime::Handle::current()` — if no runtime
/// is entered at the moment of drop, it panics and the container is
/// silently leaked. Letting the runtime live for the whole process
/// (`OnceLock` is never dropped on exit) means our custom
/// `PgInstance` Drop can enter it and the container's async cleanup
/// runs to completion.
fn runtime() -> &'static Runtime {
    static R: OnceLock<Runtime> = OnceLock::new();
    R.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .worker_threads(2)
            .thread_name("pg-container")
            .build()
            .expect("build pg_container runtime")
    })
}

/// Holder for the running container + its connection URL. Kept in a
/// `OnceLock` so the `ContainerAsync` Drop is deferred to process
/// exit. We wrap the container in `Option` so the custom `Drop` can
/// take ownership and drop it inside an entered runtime.
struct PgInstance {
    /// The connection string `postgres://postgres:postgres@127.0.0.1:<port>/postgres`.
    url: String,
    container: Option<ContainerAsync<Postgres>>,
}

impl Drop for PgInstance {
    fn drop(&mut self) {
        if let Some(container) = self.container.take() {
            // Drop the container while a runtime is entered so
            // testcontainers-rs's async cleanup task can run.
            // `block_on(async move { drop(container) })` ensures
            // `Handle::current()` succeeds inside the container's Drop.
            runtime().block_on(async move {
                drop(container);
            });
        }
    }
}

/// Force the static `INSTANCE`/`EMPTY_INSTANCE` containers to drop on
/// process exit. Rust does NOT run `Drop` for `static` values at exit,
/// so without this hook the testcontainers-rs `ContainerAsync` never
/// gets cleaned up and we leak postgres containers — eventually
/// exhausting the docker bridge subnet's IPv4 pool.
///
/// The dtor pulls the value out via `unsafe` interior swap because
/// `OnceLock` doesn't expose a `take()`. We call the held container's
/// async-cleanup directly while a runtime is entered.
#[ctor::dtor]
fn cleanup_at_exit() {
    cleanup_slot(&INSTANCE);
    cleanup_slot(&EMPTY_INSTANCE);
}

fn cleanup_slot(slot: &'static OnceLock<PgInstance>) {
    if let Some(inst) = slot.get() {
        // SAFETY: at process-exit dtor time no other thread is
        // accessing the OnceLock. We cast the &PgInstance to a
        // mutable pointer to take the container out of its `Option`.
        // The container is then dropped under an entered runtime.
        let inst_ptr = inst as *const PgInstance as *mut PgInstance;
        let container = unsafe { (*inst_ptr).container.take() };
        if let Some(container) = container {
            runtime().block_on(async move {
                drop(container);
            });
        }
    }
}

static INSTANCE: OnceLock<PgInstance> = OnceLock::new();
static EMPTY_INSTANCE: OnceLock<PgInstance> = OnceLock::new();

/// Returns the connection URL for a process-scoped postgres container,
/// starting it (and running migrations against it) on first call.
///
/// Panics if the container fails to start or migrations fail. Both are
/// hard failures — the test cannot proceed.
pub fn url() -> &'static str {
    &instance(&INSTANCE, /* run_migrations */ true).url
}

/// Returns the connection URL for a *second* process-scoped postgres
/// container with **no migrations applied** — the empty-DB analogue
/// used by tests that assert the gateway surfaces an actionable error
/// when recondo tables don't exist.
pub fn url_empty() -> &'static str {
    &instance(&EMPTY_INSTANCE, /* run_migrations */ false).url
}

fn instance(slot: &'static OnceLock<PgInstance>, migrate: bool) -> &'static PgInstance {
    if let Some(existing) = slot.get() {
        return existing;
    }
    // Spawn on a dedicated thread so the caller's runtime (e.g. a
    // `#[tokio::test]` worker) is not active when we call
    // `runtime().block_on(...)` — calling `block_on` from inside a
    // running runtime panics with "Cannot start a runtime from
    // within a runtime".
    let started = std::thread::spawn(move || start(migrate))
        .join()
        .expect("pg_container start thread panicked");
    slot.get_or_init(|| started)
}

fn start(migrate: bool) -> PgInstance {
    runtime().block_on(async {
        use testcontainers::runners::AsyncRunner;
        // Pin to 17-alpine — matches `just dev-infra` (single
        // canonical version across docker-compose + CI + tests).
        //
        // Retry around `start()` because moby's address allocator
        // can fail concurrent container creates with
        // "no available IPv4 addresses on this network's address
        // pools" even when the bridge subnet is far from full —
        // a known docker race under burst spawn. nextest's
        // `container-spawn` test-group caps parallelism to narrow
        // the race window; this retry mops up the residual.
        let mut last_err: Option<String> = None;
        let container = {
            let mut got = None;
            for attempt in 1..=5 {
                match Postgres::default().with_tag("17-alpine").start().await {
                    Ok(c) => {
                        got = Some(c);
                        break;
                    }
                    Err(e) => {
                        last_err = Some(format!("{e:?}"));
                        eprintln!(
                            "[pg_container] start attempt {attempt}/5 failed: {e:?}; retrying"
                        );
                        tokio::time::sleep(std::time::Duration::from_millis(500 * attempt)).await;
                    }
                }
            }
            got.unwrap_or_else(|| {
                panic!(
                    "start postgres testcontainer: exhausted retries; last error: {:?}",
                    last_err
                )
            })
        };
        let port = container
            .get_host_port_ipv4(5432)
            .await
            .expect("get postgres host port");
        let url = format!("postgres://postgres:postgres@127.0.0.1:{port}/postgres");
        if migrate {
            run_migrations(&url);
        }
        PgInstance {
            url,
            container: Some(container),
        }
    })
}

/// Apply `api/migrations/*.sql` against `url` via `node-pg-migrate`.
///
/// We shell out to the existing `npm run migrate` script so the SQL
/// file list and migration runner stay a single source of truth. The
/// caller is the gateway test binary; it inherits cwd from cargo,
/// which sets it to `gateway/`. We `cd ../api` to find the migration
/// runner.
fn run_migrations(database_url: &str) {
    let api_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("gateway crate has a parent")
        .join("api");
    if !api_dir.join("node_modules").exists() {
        panic!(
            "api/node_modules not found at {} — run `cd api && npm ci` before \
             postgres-tests so node-pg-migrate is available",
            api_dir.display()
        );
    }
    let status = std::process::Command::new("npm")
        .arg("run")
        .arg("migrate")
        .arg("--")
        .arg("up")
        .current_dir(&api_dir)
        .env("DATABASE_URL", database_url)
        .status()
        .expect("spawn `npm run migrate`");
    if !status.success() {
        panic!("npm run migrate exited with {status}");
    }
}
