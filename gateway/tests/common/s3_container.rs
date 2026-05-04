//! Ephemeral ministack container for S3-integration tests.
//!
//! Mirrors `pg_container`: process-scoped `OnceLock`, container
//! cleanup on test-binary exit, no need for `just dev-infra`.

use std::sync::OnceLock;
use std::time::Duration;
use testcontainers::core::{ContainerPort, IntoContainerPort};
use testcontainers::{ContainerAsync, GenericImage, ImageExt};
use tokio::runtime::Runtime;

/// Process-static runtime — see `pg_container::runtime` for the full
/// rationale. testcontainers-rs's `ContainerAsync` Drop calls
/// `Handle::current()`, which panics if no runtime is entered at the
/// moment of drop, silently leaking the container. Keeping the
/// runtime alive for the process lifetime + entering it during our
/// custom Drop fixes that.
fn runtime() -> &'static Runtime {
    static R: OnceLock<Runtime> = OnceLock::new();
    R.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .worker_threads(2)
            .thread_name("s3-container")
            .build()
            .expect("build s3_container runtime")
    })
}

/// Connection details for the running ministack container.
pub struct S3Endpoint {
    /// `http://127.0.0.1:<port>` — pass to `AWS_ENDPOINT_URL` or to
    /// the SDK's `endpoint_url` builder method.
    pub url: String,
    /// Pre-created bucket name for test use. Tests are free to create
    /// their own buckets too.
    pub bucket: String,
}

struct S3Instance {
    endpoint: S3Endpoint,
    container: Option<ContainerAsync<GenericImage>>,
}

impl Drop for S3Instance {
    fn drop(&mut self) {
        if let Some(container) = self.container.take() {
            runtime().block_on(async move {
                drop(container);
            });
        }
    }
}

/// Force the static `INSTANCE`'s container to drop on process exit.
/// See `pg_container::cleanup_at_exit` for the full rationale —
/// statics don't run `Drop`, so we need a `#[dtor]` to avoid leaking
/// the ministack container into the docker bridge IPv4 pool.
#[ctor::dtor]
fn cleanup_at_exit() {
    if let Some(inst) = INSTANCE.get() {
        let inst_ptr = inst as *const S3Instance as *mut S3Instance;
        let container = unsafe { (*inst_ptr).container.take() };
        if let Some(container) = container {
            runtime().block_on(async move {
                drop(container);
            });
        }
    }
}

static INSTANCE: OnceLock<S3Instance> = OnceLock::new();

/// Returns the endpoint for a process-scoped ministack container,
/// starting it on first call.
pub fn endpoint() -> &'static S3Endpoint {
    if let Some(existing) = INSTANCE.get() {
        return &existing.endpoint;
    }
    // See pg_container::instance for why we spawn on a dedicated
    // OS thread before calling block_on.
    let started = std::thread::spawn(start)
        .join()
        .expect("s3_container start thread panicked");
    &INSTANCE.get_or_init(|| started).endpoint
}

fn start() -> S3Instance {
    runtime().block_on(async {
        use testcontainers::runners::AsyncRunner;
        // No `WaitFor` — ministack's "Ready." log message can lag the
        // S3 API by tens of seconds and the testcontainers default
        // startup timeout (60s) sometimes elapses first. Instead we
        // poll `create_bucket` until it succeeds; if the API isn't
        // ready, the SDK call itself errors and we retry.
        // Retry-around-start: same docker IPv4-pool race as in
        // `pg_container.rs` — see the comment there.
        let mut last_err: Option<String> = None;
        let container = {
            let mut got = None;
            for attempt in 1..=5 {
                let res = GenericImage::new("ministackorg/ministack", "1.3.25")
                    .with_exposed_port(ContainerPort::Tcp(4566))
                    .with_env_var("SERVICES", "s3")
                    .start()
                    .await;
                match res {
                    Ok(c) => {
                        got = Some(c);
                        break;
                    }
                    Err(e) => {
                        last_err = Some(format!("{e:?}"));
                        eprintln!(
                            "[s3_container] start attempt {attempt}/5 failed: {e:?}; retrying"
                        );
                        tokio::time::sleep(Duration::from_millis(500 * attempt)).await;
                    }
                }
            }
            got.unwrap_or_else(|| {
                panic!(
                    "start ministack testcontainer: exhausted retries; last error: {:?}",
                    last_err
                )
            })
        };
        let port = container
            .get_host_port_ipv4(4566.tcp())
            .await
            .expect("get ministack host port");
        let url = format!("http://127.0.0.1:{port}");
        let bucket = "recondo-objects-dev".to_string();
        create_bucket_with_retry(&url, &bucket).await;
        S3Instance {
            endpoint: S3Endpoint { url, bucket },
            container: Some(container),
        }
    })
}

/// Create the test bucket, polling until ministack's S3 endpoint is
/// answering. Treats any error in the first 90 seconds as
/// "API not yet ready, retry" so the bucket appears as soon as
/// the service is up.
async fn create_bucket_with_retry(endpoint: &str, bucket: &str) {
    use aws_sdk_s3::{
        config::BehaviorVersion, config::Credentials, config::Region, Client, Config,
    };
    let config = Config::builder()
        .behavior_version(BehaviorVersion::latest())
        .region(Region::new("us-east-1"))
        .endpoint_url(endpoint)
        .credentials_provider(Credentials::new("test", "test", None, None, "static"))
        .force_path_style(true)
        .build();
    let client = Client::from_conf(config);

    let deadline = std::time::Instant::now() + Duration::from_secs(90);
    let mut last_err = None;
    while std::time::Instant::now() < deadline {
        match client.create_bucket().bucket(bucket).send().await {
            Ok(_) => return,
            Err(e) => {
                // BucketAlreadyOwnedByYou / BucketAlreadyExists also
                // count as success — the bucket exists either way.
                let s = format!("{e}");
                if s.contains("BucketAlreadyOwnedByYou") || s.contains("BucketAlreadyExists") {
                    return;
                }
                last_err = Some(e);
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
        }
    }
    panic!(
        "ministack S3 endpoint never became ready within 90s; last error: {:?}",
        last_err
    );
}
