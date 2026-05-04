//! Test helper: in-memory WritePipeline construction.
//!
//! All migrated capture-pipeline tests need a WritePipeline backed by an
//! in-memory SqliteGraphStore + tempfile-rooted LocalObjectStore. Centralised
//! here so the helper has one definition rather than five byte-identical
//! copies (audit round 1, FIND-1-DE-1).
//!
//! Carve-out: `attachment_scoping_tests.rs:146` retains its own local
//! `make_pipeline` because it uses variant helpers
//! (`make_pipeline_with_failing_object_store`, `make_pipeline_with_failing_graph`)
//! that wrap the base helper with custom store implementations
//! (`FailingObjectStore` / `FailingGraphStore`). That file was not in the
//! audit's enumerated 5-file E1 migration list; consolidating it would be
//! scope creep beyond E1. A future cleanup batch can address it by lifting
//! the variant helpers alongside the base helper into this module.

#![allow(dead_code)]

use recondo_gateway::storage::graph::SqliteGraphStore;
use recondo_gateway::storage::object::LocalObjectStore;
use recondo_gateway::storage::pipeline::WritePipeline;
use tempfile::TempDir;

pub fn make_pipeline() -> (WritePipeline, TempDir) {
    let tmp = TempDir::new().expect("tempdir");
    let data_dir = tmp.path().to_path_buf();
    let dlq = data_dir.join("dlq");
    let graph = SqliteGraphStore::new_in_memory().expect("in-memory sqlite graph");
    let objects = LocalObjectStore::new(&data_dir);
    let pipeline = WritePipeline::new(Box::new(graph), Box::new(objects), dlq);
    (pipeline, tmp)
}
