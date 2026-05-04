use std::io::Read as _;
use std::path::PathBuf;

use anyhow::Result;
use clap::{Parser, Subcommand};
use tracing::info;

use recondo_gateway::gateway::GatewayConfig;
use recondo_gateway::status::collect_status;
use recondo_gateway::storage::graph::GraphStore;
use recondo_gateway::tls::trust_store;
use recondo_gateway::{db, gateway, hash, session, tls};

// ---------------------------------------------------------------------------
// CLI definition
// ---------------------------------------------------------------------------

/// Recondo gateway — AI governance gateway
#[derive(Parser)]
#[command(name = "recondo-gateway", version, about)]
struct Cli {
    /// Path to the Recondo data directory (default: ~/.recondo)
    #[arg(long = "data-dir", global = true)]
    data_dir: Option<PathBuf>,

    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Start the gateway server
    Serve {
        /// Enable live trace output
        #[arg(long)]
        trace: bool,
    },
    /// Initialize the gateway: generate CA and install into system trust store
    Init,
    /// CA certificate management
    Ca {
        #[command(subcommand)]
        action: CaCommands,
    },
    /// List all captured sessions
    Sessions,
    /// Show turn-by-turn trace for a session
    Session {
        /// Session ID
        id: String,
        /// Show compact turn list (sequence, timestamp, model, tokens) without full text
        #[arg(long)]
        turns: bool,
    },
    /// Show single turn detail
    Turn {
        /// Turn ID
        id: String,
    },
    /// Search turns by content
    Search {
        /// Search query
        query: String,
    },
    /// Show aggregate statistics
    Stats,
    /// Verify content hashes for a session
    Verify {
        /// Session ID
        session_id: String,
    },
    /// Show gateway operational status
    Status,
    /// Run the Recondo Operator sidecar
    Operator,
    /// Replay orphan captures: scan `<data-dir>/captures/` and reconcile any
    /// capture metadata files whose matching `turns` row is missing. The
    /// gateway runs this same routine at startup; the CLI exposes it for
    /// on-demand maintenance / dry-run reporting.
    Reprocess {
        /// Count orphans and print the report without inserting anything.
        #[arg(long = "dry-run")]
        dry_run: bool,
    },
}

#[derive(Subcommand)]
enum CaCommands {
    /// Generate a CA certificate and install into system trust store
    Init,
    /// Show CA certificate info (fingerprint, subject, validity)
    Show,
    /// Export the CA certificate to a file or stdout
    Export {
        /// Output file path (prints to stdout if omitted)
        output: Option<PathBuf>,
    },
    /// Remove the CA certificate from the system trust store
    Revoke,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn default_data_dir() -> Result<PathBuf> {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map(|h| PathBuf::from(h).join(".recondo"))
        .map_err(|_| {
            anyhow::anyhow!(
                "Neither HOME nor USERPROFILE environment variable is set. \
                 Cannot determine data directory."
            )
        })
}

fn resolve_data_dir(explicit: Option<PathBuf>) -> Result<PathBuf> {
    match explicit {
        Some(p) => Ok(p),
        None => default_data_dir(),
    }
}

fn open_db(data_dir: &std::path::Path) -> Result<rusqlite::Connection> {
    let db_path = data_dir.join("recondo.db");
    let conn = db::open(&db_path)?;
    db::initialize(&conn)?;
    Ok(conn)
}

/// Open the appropriate GraphStore based on RECONDO_STORE env var.
/// When RECONDO_STORE=postgres, connects to PostgreSQL via RECONDO_DB_URL.
/// Otherwise falls back to SQLite at data_dir/recondo.db.
fn open_graph_store(data_dir: &std::path::Path) -> Result<Box<dyn GraphStore>> {
    use recondo_gateway::storage::pool::ConnectionPool;

    let store_type = std::env::var("RECONDO_STORE").unwrap_or_else(|_| "sqlite".into());
    match store_type.as_str() {
        #[cfg(feature = "postgres")]
        "postgres" => {
            let db_url = std::env::var("RECONDO_DB_URL").map_err(|_| {
                anyhow::anyhow!("RECONDO_DB_URL must be set when RECONDO_STORE=postgres")
            })?;
            let pool = ConnectionPool::postgres(&db_url)?;
            Ok(pool.graph_store())
        }
        #[cfg(not(feature = "postgres"))]
        "postgres" => {
            anyhow::bail!(
                "RECONDO_STORE=postgres but binary compiled without 'postgres' feature. \
                 Rebuild with: cargo build --features postgres"
            );
        }
        _ => {
            let db_path = data_dir.join("recondo.db");
            let pool = ConnectionPool::sqlite(&db_path)?;
            Ok(pool.graph_store())
        }
    }
}

// ---------------------------------------------------------------------------
// Command implementations
// ---------------------------------------------------------------------------

fn cmd_sessions(data_dir: &std::path::Path) -> Result<()> {
    let store = open_graph_store(data_dir)?;
    let sessions = store.list_sessions(None)?;

    if sessions.is_empty() {
        println!("No sessions found.");
        return Ok(());
    }

    // Print header
    let header_intent = "Intent";
    println!(
        "{:<20} {:<30} {:>6} {:>8} {:>8} {:<22} {}",
        "ID", "Model", "Turns", "Tokens", "Cost", "Started", header_intent
    );
    println!("{}", "-".repeat(110));

    for s in &sessions {
        let model = s.model.as_deref().unwrap_or("-");
        let intent_raw = s.initial_intent.as_deref().unwrap_or("-");
        // Truncate intent to first line, max 50 chars for clean table display.
        // Use .chars().count() / .chars().take() to avoid panicking on multi-byte UTF-8.
        let intent_line = intent_raw.lines().next().unwrap_or("-");
        let intent = if intent_line.chars().count() > 50 {
            format!("{}...", intent_line.chars().take(47).collect::<String>())
        } else {
            intent_line.to_string()
        };
        println!(
            "{:<20} {:<30} {:>6} {:>8} {:>8.2} {:<22} {}",
            s.id, model, s.total_turns, s.total_tokens, s.total_cost_usd, s.started_at, intent
        );
    }

    Ok(())
}

fn cmd_session(data_dir: &std::path::Path, id: &str, compact_turns: bool) -> Result<()> {
    let store = open_graph_store(data_dir)?;

    let session = store.get_session(id)?;
    let session = match session {
        Some(s) => s,
        None => {
            eprintln!("No session found with ID: {}", id);
            std::process::exit(1);
        }
    };

    // Print session header
    println!("Session: {}", session.id);
    println!("Provider: {}", session.provider);
    println!("Model: {}", session.model.as_deref().unwrap_or("-"));
    println!("Started: {}", session.started_at);
    println!(
        "Turns: {}/{} captured | Dropped: {}",
        session.turns_captured, session.total_turns, session.dropped_events
    );
    println!("Total tokens: {}", session.total_tokens);
    println!("Total cost: ${:.2}", session.total_cost_usd);
    println!(
        "Intent: {}",
        session.initial_intent.as_deref().unwrap_or("-")
    );
    println!();

    // Print turns
    let turns = store.get_turns_for_session(id)?;
    if turns.is_empty() {
        println!("No turns recorded for this session.");
        return Ok(());
    }

    if compact_turns {
        // Compact turn list: sequence, timestamp, model, tokens, cost (no response text)
        println!(
            "{:>4}  {:<24} {:<30} {:>6} {:>6} {:>8}",
            "Seq", "Timestamp", "Model", "In", "Out", "Cost"
        );
        println!("{}", "-".repeat(90));
        for t in &turns {
            println!(
                "{:>4}  {:<24} {:<30} {:>6} {:>6} {:>8}",
                t.sequence_num,
                t.timestamp,
                t.model.as_deref().unwrap_or("-"),
                t.input_tokens,
                t.output_tokens,
                t.cost_usd
                    .map(|c| format!("${:.2}", c))
                    .unwrap_or_else(|| "-".to_string())
            );
        }
    } else {
        for t in &turns {
            println!("--- Turn {} [{}] ---", t.sequence_num, t.timestamp);
            println!(
                "  Model: {}  Stop: {}",
                t.model.as_deref().unwrap_or("-"),
                t.stop_reason
            );
            // N2 fix: Show total input including cache tokens so the user sees
            // the real token footprint, not just the non-cached portion.
            let total_input = t.input_tokens + t.cache_read_tokens + t.cache_creation_tokens;
            let cache_total = t.cache_read_tokens + t.cache_creation_tokens;
            if cache_total > 0 {
                println!(
                    "  Tokens: {} in ({} + {} cache) / {} out  Cost: {}",
                    total_input,
                    t.input_tokens,
                    cache_total,
                    t.output_tokens,
                    t.cost_usd
                        .map(|c| format!("${:.2}", c))
                        .unwrap_or_else(|| "-".to_string())
                );
            } else {
                println!(
                    "  Tokens: {} in / {} out  Cost: {}",
                    t.input_tokens,
                    t.output_tokens,
                    t.cost_usd
                        .map(|c| format!("${:.2}", c))
                        .unwrap_or_else(|| "-".to_string())
                );
            }
            if let Some(ref delta) = t.messages_delta {
                if let Some(user_msg) = session::extract_last_user_message(delta) {
                    println!("  User: {}", user_msg);
                }
            }
            if let Some(ref text) = t.response_text {
                println!("  Response: {}", text);
            }
            if let Some(ref thinking) = t.thinking_text {
                if !thinking.is_empty() {
                    println!("  Thinking: {}", thinking);
                }
            }
            println!();
        }
    }

    Ok(())
}

fn cmd_turn(data_dir: &std::path::Path, id: &str) -> Result<()> {
    let store = open_graph_store(data_dir)?;

    let turn = store.get_turn(id)?;
    let turn = match turn {
        Some(t) => t,
        None => {
            eprintln!("No turn found with ID: {}", id);
            std::process::exit(1);
        }
    };

    println!("Turn: {}", turn.id);
    println!("Session: {}", turn.session_id);
    println!("Sequence: {}", turn.sequence_num);
    println!("Timestamp: {}", turn.timestamp);
    println!("Model: {}", turn.model.as_deref().unwrap_or("-"));
    println!("Stop reason: {}", turn.stop_reason);
    println!("Capture complete: {}", turn.capture_complete);
    println!();
    println!("Tokens:");
    println!("  Input:          {}", turn.input_tokens);
    println!("  Output:         {}", turn.output_tokens);
    println!("  Cache read:     {}", turn.cache_read_tokens);
    println!("  Cache creation: {}", turn.cache_creation_tokens);
    println!(
        "  Cost:           {}",
        turn.cost_usd
            .map(|c| format!("${:.2}", c))
            .unwrap_or_else(|| "-".to_string())
    );
    println!();
    println!("Hashes:");
    println!("  Request:  {}", turn.request_hash);
    println!("  Response: {}", turn.response_hash);
    if let Some(ref r) = turn.req_bytes_ref {
        println!(
            "  Req file: {} ({} bytes)",
            r,
            turn.req_bytes_size.unwrap_or(0)
        );
    }
    if let Some(ref r) = turn.resp_bytes_ref {
        println!(
            "  Resp file: {} ({} bytes)",
            r,
            turn.resp_bytes_size.unwrap_or(0)
        );
    }
    println!();

    if let Some(ref delta) = turn.messages_delta {
        if let Some(user_msg) = session::extract_last_user_message(delta) {
            println!("User message:\n{}", user_msg);
            println!();
        }
    }
    if let Some(ref text) = turn.response_text {
        println!("Response text:");
        println!("{}", text);
        println!();
    }
    if let Some(ref thinking) = turn.thinking_text {
        if !thinking.is_empty() {
            println!("Thinking text:");
            println!("{}", thinking);
            println!();
        }
    }

    // Show tool calls
    let tool_calls = store.get_tool_calls_for_turn(id)?;
    if !tool_calls.is_empty() {
        println!("Tool calls:");
        for tc in &tool_calls {
            println!("  {} [{}]: {}", tc.tool_name, tc.id, tc.tool_input);
        }
        println!();
    }

    Ok(())
}

fn cmd_search(data_dir: &std::path::Path, query: &str) -> Result<()> {
    if std::env::var("RECONDO_STORE").unwrap_or_default() == "postgres" {
        anyhow::bail!("'search' command requires the SQLite backend; for PostgreSQL, use the GraphQL API search query instead.");
    }
    let conn = open_db(data_dir)?;
    let results = db::search_turns(&conn, query, None)?;

    if results.is_empty() {
        println!("No matching turns found.");
        return Ok(());
    }

    println!("Found {} matching turn(s):", results.len());
    println!();

    for t in &results {
        println!(
            "  {} (session {}, seq {}) [{}]",
            t.id,
            t.session_id,
            t.sequence_num,
            t.model.as_deref().unwrap_or("-")
        );
        if let Some(ref text) = t.response_text {
            // Show first 120 chars of response text.
            // Use .chars().count() / .chars().take() to avoid panicking on multi-byte UTF-8.
            let preview = if text.chars().count() > 120 {
                format!("{}...", text.chars().take(120).collect::<String>())
            } else {
                text.clone()
            };
            println!("    {}", preview);
        }
        println!();
    }

    Ok(())
}

fn cmd_stats(data_dir: &std::path::Path) -> Result<()> {
    if std::env::var("RECONDO_STORE").unwrap_or_default() == "postgres" {
        anyhow::bail!(
            "'stats' command requires the SQLite backend; for PostgreSQL, use the GraphQL API instead."
        );
    }
    let conn = open_db(data_dir)?;
    let stats = db::get_stats(&conn)?;

    println!("Recondo Statistics");
    println!("==================");
    println!("Sessions:     {}", stats.total_sessions);
    println!("Turns:        {}", stats.total_turns);
    println!("Total tokens: {}", stats.total_tokens);
    println!(
        "Models used:  {}",
        if stats.models_used.is_empty() {
            "none".to_string()
        } else {
            stats.models_used.join(", ")
        }
    );

    Ok(())
}

fn cmd_init(data_dir: &std::path::Path) -> Result<()> {
    tls::ensure_ca(data_dir)?;
    println!(
        "CA certificate generated at {}",
        data_dir.join("ca").join("ca.crt").display()
    );

    let ca_cert_path = data_dir.join("ca").join("ca.crt");
    match trust_store::install_ca(&ca_cert_path) {
        Ok(()) => println!("CA certificate installed into system trust store"),
        Err(e) => {
            eprintln!(
                "Warning: Could not install CA into system trust store: {}",
                e
            );
            eprintln!("You may need to run with elevated privileges (sudo) or install manually.");
        }
    }

    Ok(())
}

fn cmd_ca_init(data_dir: &std::path::Path) -> Result<()> {
    cmd_init(data_dir)
}

fn cmd_ca_show(data_dir: &std::path::Path) -> Result<()> {
    let fingerprint = tls::ca_fingerprint(data_dir)?;
    let subject = tls::ca_subject(data_dir)?;
    let (not_before, not_after) = tls::ca_validity(data_dir)?;

    println!("Fingerprint (SHA-256): {}", fingerprint);
    println!("Subject: {}", subject);
    println!("Valid from: {}", not_before);
    println!("Valid until: {}", not_after);

    Ok(())
}

fn cmd_ca_export(data_dir: &std::path::Path, output: Option<&std::path::Path>) -> Result<()> {
    let ca_cert_path = data_dir.join("ca").join("ca.crt");
    let pem_data = std::fs::read_to_string(&ca_cert_path).map_err(|_| {
        anyhow::anyhow!("CA certificate not found. Run 'recondo-gateway init' first.")
    })?;

    match output {
        Some(path) => {
            std::fs::write(path, &pem_data)?;
            println!("CA certificate exported to {}", path.display());
        }
        None => {
            print!("{}", pem_data);
        }
    }

    Ok(())
}

fn cmd_ca_revoke(data_dir: &std::path::Path) -> Result<()> {
    let ca_cert_path = data_dir.join("ca").join("ca.crt");
    trust_store::remove_ca(&ca_cert_path)?;
    println!("CA certificate removed from system trust store");
    Ok(())
}

fn cmd_verify(data_dir: &std::path::Path, session_id: &str) -> Result<()> {
    let store = open_graph_store(data_dir)?;

    let session = store.get_session(session_id)?;
    if session.is_none() {
        eprintln!("No session found with ID: {}", session_id);
        std::process::exit(1);
    }

    let turns = store.get_turns_for_session(session_id)?;
    if turns.is_empty() {
        println!("No turns to verify for session {}", session_id);
        return Ok(());
    }

    println!("Verifying session: {}", session_id);
    println!();

    let mut pass_count = 0;
    let mut fail_count = 0;
    let mut skip_count = 0;

    for t in &turns {
        print!("Turn {} ({}): ", t.sequence_num, t.id);

        // Check request object
        let req_ok = verify_object(data_dir, t.req_bytes_ref.as_deref(), &t.request_hash, "req");
        // Check response object
        let resp_ok = verify_object(
            data_dir,
            t.resp_bytes_ref.as_deref(),
            &t.response_hash,
            "resp",
        );

        match (&req_ok, &resp_ok) {
            (VerifyResult::Pass, VerifyResult::Pass) => {
                println!("PASS (req OK, resp OK)");
                pass_count += 1;
            }
            (VerifyResult::Skip, VerifyResult::Skip) => {
                println!("SKIP (no object refs)");
                skip_count += 1;
            }
            (VerifyResult::Skip, VerifyResult::Pass) | (VerifyResult::Pass, VerifyResult::Skip) => {
                println!("PASS (partial - some refs missing)");
                pass_count += 1;
            }
            _ => {
                let req_str = match &req_ok {
                    VerifyResult::Pass => "req OK".to_string(),
                    VerifyResult::Fail(msg) => msg.clone(),
                    VerifyResult::Skip => "req skipped".to_string(),
                };
                let resp_str = match &resp_ok {
                    VerifyResult::Pass => "resp OK".to_string(),
                    VerifyResult::Fail(msg) => msg.clone(),
                    VerifyResult::Skip => "resp skipped".to_string(),
                };
                println!("FAIL ({}, {})", req_str, resp_str);
                fail_count += 1;
            }
        }
    }

    println!();
    println!(
        "Summary: {} passed, {} failed, {} skipped out of {} turns",
        pass_count,
        fail_count,
        skip_count,
        turns.len()
    );

    if fail_count > 0 {
        std::process::exit(1);
    }

    Ok(())
}

enum VerifyResult {
    Pass,
    Fail(String),
    Skip,
}

fn verify_object(
    data_dir: &std::path::Path,
    bytes_ref: Option<&str>,
    expected_hash: &str,
    label: &str,
) -> VerifyResult {
    let bytes_ref = match bytes_ref {
        Some(r) => r,
        None => return VerifyResult::Skip,
    };

    let file_path = data_dir.join(bytes_ref);
    if !file_path.exists() {
        return VerifyResult::Fail(format!("{} missing: {}", label, bytes_ref));
    }

    // Read and decompress gzip
    let compressed = match std::fs::read(&file_path) {
        Ok(data) => data,
        Err(e) => return VerifyResult::Fail(format!("{} read error: {}", label, e)),
    };

    let mut decoder = flate2::read::GzDecoder::new(compressed.as_slice());
    let mut decompressed = Vec::new();
    match decoder.read_to_end(&mut decompressed) {
        Ok(_) => {}
        Err(e) => return VerifyResult::Fail(format!("{} decompress error: {}", label, e)),
    }

    let actual_hash = hash::sha256_hex(&decompressed);
    if actual_hash == expected_hash {
        VerifyResult::Pass
    } else {
        VerifyResult::Fail(format!(
            "{} MISMATCH: expected {}, got {}",
            label, expected_hash, actual_hash
        ))
    }
}

/// `recondo-gateway reprocess [--dry-run]` — scan captures dir, recover
/// orphans (or, in dry-run mode, just classify and report).
fn cmd_reprocess(data_dir: &std::path::Path, dry_run: bool) -> Result<()> {
    use recondo_gateway::capture::recovery::{recover_orphan_captures, RecoveryConfig};
    use recondo_gateway::storage::object::LocalObjectStore;

    let graph = open_graph_store(data_dir)?;
    let objects = LocalObjectStore::new(data_dir);

    let config = if dry_run {
        RecoveryConfig::dry_run()
    } else {
        RecoveryConfig::default()
    };

    let report = recover_orphan_captures(data_dir, &*graph, &objects, &config)?;

    // Machine-readable single-line summary (parsed by tests + ops tooling).
    // FIND-2-3 (round 3): include `attachments_recovered=` so operators
    // running `recondo reprocess` can see whether attachment rows were
    // re-persisted alongside the recovered turns. The round-2 fix added
    // the field to RecoveryReport but never surfaced it.
    println!(
        "scanned={} orphans_found={} recovered={} attachments_recovered={} failed={} dry_run={}",
        report.scanned,
        report.orphans_found,
        report.recovered,
        report.attachments_recovered,
        report.failed.len(),
        dry_run
    );
    // Human-readable expanded form on subsequent lines (also keyed by the
    // canonical field names so grep-by-name works on either format).
    println!("Recovery report ({}):", data_dir.display());
    println!("  scanned: {}", report.scanned);
    println!("  orphans_found: {}", report.orphans_found);
    println!("  recovered: {}", report.recovered);
    println!("  attachments_recovered: {}", report.attachments_recovered);
    println!("  failed: {}", report.failed.len());
    if dry_run {
        println!("  mode: dry-run (no DB writes)");
    }
    if !report.failed.is_empty() {
        println!("Failures:");
        for (path, err) in &report.failed {
            println!("  - {}: {}", path.display(), err);
        }
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/// Read the configured tokio worker thread count from the environment.
///
/// Defaults to `available_parallelism * 2` per audit finding E5 — the
/// 2× multiplier absorbs sync-bridge churn (e.g., S3 ObjectStore's
/// `block_in_place` calls; see audit finding E4) without starving the
/// worker pool on small containers.
///
/// Override via `RECONDO_TOKIO_WORKERS=N` (must be > 0; otherwise
/// falls back to default).
fn recondo_tokio_workers() -> usize {
    std::env::var("RECONDO_TOKIO_WORKERS")
        .ok()
        .and_then(|s| s.parse::<usize>().ok())
        .filter(|&n| n > 0)
        .unwrap_or_else(|| {
            let cores = std::thread::available_parallelism()
                .map(|p| p.get())
                .unwrap_or(2);
            cores.saturating_mul(2)
        })
}

fn main() -> Result<()> {
    let workers = recondo_tokio_workers();
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(workers)
        .enable_all()
        .build()
        .expect("Failed to build tokio runtime");
    runtime.block_on(async_main())
}

async fn async_main() -> Result<()> {
    let cli = Cli::parse();
    let data_dir = resolve_data_dir(cli.data_dir)?;

    match cli.command {
        Commands::Serve { trace } => {
            // Initialize tracing for the gateway server (logs go to stderr)
            tracing_subscriber::fmt()
                .with_env_filter(
                    tracing_subscriber::EnvFilter::try_from_default_env()
                        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
                )
                .with_writer(std::io::stderr)
                .init();

            info!("Recondo gateway starting, data_dir={}", data_dir.display());

            // B2 fix: Load recondo.toml if it exists, apply env overrides.
            // Falls back to env-var-only defaults if no config file is present.
            let toml_path = data_dir.join("recondo.toml");
            let recondo_config = if toml_path.exists() {
                let toml_str = std::fs::read_to_string(&toml_path)?;
                let cfg = recondo_gateway::config::parse_recondo_toml(&toml_str)?;
                info!("Loaded configuration from {}", toml_path.display());
                Some(cfg)
            } else {
                info!("No recondo.toml found, using env-var-only defaults");
                None
            };

            // H1 fix: Propagate recondo.toml store/objects settings into env vars
            // so that run_listener (which reads env vars directly) picks them up.
            // Env vars take precedence: we only set them if they are NOT already set.
            if let Some(ref cfg) = recondo_config {
                if std::env::var("RECONDO_STORE").is_err() && !cfg.store.backend.is_empty() {
                    std::env::set_var("RECONDO_STORE", &cfg.store.backend);
                    info!(backend = %cfg.store.backend, "Set RECONDO_STORE from recondo.toml");
                }
                if std::env::var("RECONDO_DB_URL").is_err() {
                    if let Some(ref uri) = cfg.store.postgres_uri {
                        std::env::set_var("RECONDO_DB_URL", uri);
                        info!("Set RECONDO_DB_URL from recondo.toml");
                    }
                }
                if std::env::var("RECONDO_OBJECTS").is_err() && !cfg.objects.backend.is_empty() {
                    std::env::set_var("RECONDO_OBJECTS", &cfg.objects.backend);
                    info!(backend = %cfg.objects.backend, "Set RECONDO_OBJECTS from recondo.toml");
                }
                if std::env::var("RECONDO_S3_BUCKET").is_err() {
                    if let Some(ref bucket) = cfg.objects.s3_bucket {
                        std::env::set_var("RECONDO_S3_BUCKET", bucket);
                        info!(bucket = %bucket, "Set RECONDO_S3_BUCKET from recondo.toml");
                    }
                }
            }

            // Derive port and bind address from config or defaults
            let (port, bind_addr) = match &recondo_config {
                Some(cfg) => {
                    // Parse listen address "host:port"
                    let listen = &cfg.gateway.listen;
                    if let Some(colon) = listen.rfind(':') {
                        let addr = listen[..colon].to_string();
                        let p: u16 = listen[colon + 1..].parse().unwrap_or(8443);
                        (p, addr)
                    } else {
                        (8443, "0.0.0.0".to_string())
                    }
                }
                None => (8443, "0.0.0.0".to_string()),
            };

            // Ensure CA exists on startup
            tls::ensure_ca(&data_dir)?;
            info!("CA certificate ready");

            std::fs::create_dir_all(&data_dir)?;

            // B1 fix: Map config::FailMode → wal::FailMode and propagate to GatewayConfig.
            let wal_fail_mode: recondo_gateway::wal::FailMode = recondo_config
                .as_ref()
                .map(|cfg| cfg.gateway.fail_mode)
                .unwrap_or_default()
                .into();

            let config = GatewayConfig::new(port, data_dir)
                .with_bind_addr(bind_addr)
                .with_trace(trace)
                .with_fail_mode(wal_fail_mode);
            info!(
                "Starting gateway on {}:{}",
                config.bind_addr(),
                config.port()
            );
            gateway::start_gateway(config).await?;
        }
        Commands::Init => {
            cmd_init(&data_dir)?;
        }
        Commands::Ca { action } => match action {
            CaCommands::Init => cmd_ca_init(&data_dir)?,
            CaCommands::Show => cmd_ca_show(&data_dir)?,
            CaCommands::Export { output } => cmd_ca_export(&data_dir, output.as_deref())?,
            CaCommands::Revoke => cmd_ca_revoke(&data_dir)?,
        },
        Commands::Sessions => {
            cmd_sessions(&data_dir)?;
        }
        Commands::Session { id, turns } => {
            cmd_session(&data_dir, &id, turns)?;
        }
        Commands::Turn { id } => {
            cmd_turn(&data_dir, &id)?;
        }
        Commands::Search { query } => {
            cmd_search(&data_dir, &query)?;
        }
        Commands::Stats => {
            cmd_stats(&data_dir)?;
        }
        Commands::Verify { session_id } => {
            cmd_verify(&data_dir, &session_id)?;
        }
        Commands::Status => {
            // H3 fix: recondo status CLI — opens DB, collects status, prints it.
            let conn = open_db(&data_dir)?;
            let db_backend = std::env::var("RECONDO_STORE").unwrap_or_else(|_| "sqlite".into());
            let fail_mode_str = "open"; // default fail mode for status display
            let status = collect_status(&conn, "0.0.0.0:8443", &db_backend, fail_mode_str, 0)?;
            println!("{}", status);
        }
        Commands::Reprocess { dry_run } => {
            cmd_reprocess(&data_dir, dry_run)?;
        }
        Commands::Operator => {
            // H4 fix: Wire OperatorRuntime with config from recondo.toml.
            // Initialize tracing for the operator process.
            tracing_subscriber::fmt()
                .with_env_filter(
                    tracing_subscriber::EnvFilter::try_from_default_env()
                        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
                )
                .with_writer(std::io::stderr)
                .init();

            let toml_path = data_dir.join("recondo.toml");
            let recondo_config = if toml_path.exists() {
                let toml_str = std::fs::read_to_string(&toml_path)?;
                Some(recondo_gateway::config::parse_recondo_toml(&toml_str)?)
            } else {
                None
            };

            let operator_section =
                recondo_config.and_then(|cfg| cfg.operator).ok_or_else(|| {
                    anyhow::anyhow!(
                        "No [operator] section found in {}. \
                         The operator requires control_plane and token settings.",
                        toml_path.display()
                    )
                })?;

            info!(
                control_plane = %operator_section.control_plane,
                heartbeat_interval = operator_section.heartbeat_interval,
                metrics_interval = operator_section.metrics_interval,
                "Starting Recondo Operator"
            );

            let client = recondo_gateway::operator::runtime::LoggingControlPlaneClient::new(
                operator_section.control_plane.clone(),
            );
            let runtime =
                recondo_gateway::operator::runtime::OperatorRuntime::new(operator_section, client);
            let handle = runtime.start();
            info!("Operator running — press Ctrl+C to stop");

            // Keep the process alive until Ctrl+C
            tokio::signal::ctrl_c().await?;
            info!("Received shutdown signal, stopping operator");
            handle.stop().await;
            info!("Operator stopped");
        }
    }

    Ok(())
}
