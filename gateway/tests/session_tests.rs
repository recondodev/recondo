//! Session identity tests.
//!
//! Session identity uses client metadata when available, falling back to
//! content-based hashing: sha256(len(org):org + "|" + first_user_message).
//! This works across multiple stateless gateways behind a load balancer.

use recondo_gateway::session::{self, ClientMetadata, SessionManager};
use serde_json::json;

fn user_msg(text: &str) -> serde_json::Value {
    json!({"role": "user", "content": text})
}

fn assistant_msg(text: &str) -> serde_json::Value {
    json!({"role": "assistant", "content": text})
}

/// First request creates a new session.
#[test]
fn first_request_creates_session() {
    let mut mgr = SessionManager::new();
    let msgs = vec![user_msg("What is 2+2?")];
    let r = mgr
        .resolve(
            &msgs,
            None,
            Some("system"),
            "2026-03-17T10:00:00Z",
            None,
            None,
        )
        .unwrap();
    assert!(r.is_new_session);
    assert_eq!(r.sequence_num, 1);
    assert!(!r.session_id.is_empty());
}

/// Second request with same first user message -> same session, sequence 2.
#[test]
fn same_conversation_continues_session() {
    let mut mgr = SessionManager::new();
    let msgs1 = vec![user_msg("What is 2+2?")];
    let r1 = mgr
        .resolve(
            &msgs1,
            None,
            Some("system"),
            "2026-03-17T10:00:00Z",
            None,
            None,
        )
        .unwrap();

    let msgs2 = vec![
        user_msg("What is 2+2?"),
        assistant_msg("4"),
        user_msg("And 3+3?"),
    ];
    let r2 = mgr
        .resolve(
            &msgs2,
            None,
            Some("system"),
            "2026-03-17T10:01:00Z",
            None,
            None,
        )
        .unwrap();

    assert_eq!(
        r1.session_id, r2.session_id,
        "Same first user message = same session"
    );
    assert_eq!(r2.sequence_num, 2);
    assert!(!r2.is_new_session);
}

/// Different first user message -> different session.
#[test]
fn different_conversation_creates_new_session() {
    let mut mgr = SessionManager::new();
    let msgs1 = vec![user_msg("What is 2+2?")];
    let r1 = mgr
        .resolve(&msgs1, None, None, "2026-03-17T10:00:00Z", None, None)
        .unwrap();

    let msgs2 = vec![user_msg("Write a poem about rust.")];
    let r2 = mgr
        .resolve(&msgs2, None, None, "2026-03-17T10:01:00Z", None, None)
        .unwrap();

    assert_ne!(
        r1.session_id, r2.session_id,
        "Different first message = different session"
    );
    assert!(r2.is_new_session);
    assert_eq!(r2.sequence_num, 1);
}

/// Same first message but different org_id -> different session.
#[test]
fn different_org_creates_different_session() {
    let mut mgr = SessionManager::new();
    let msgs = vec![user_msg("Hello")];
    let r1 = mgr
        .resolve(
            &msgs,
            Some("org-a"),
            None,
            "2026-03-17T10:00:00Z",
            None,
            None,
        )
        .unwrap();

    let mut mgr2 = SessionManager::new();
    let r2 = mgr2
        .resolve(
            &msgs,
            Some("org-b"),
            None,
            "2026-03-17T10:00:00Z",
            None,
            None,
        )
        .unwrap();

    assert_ne!(
        r1.session_id, r2.session_id,
        "Different orgs = different sessions"
    );
}

/// Sequence numbers increment correctly across many turns.
#[test]
fn sequence_numbers_increment() {
    let mut mgr = SessionManager::new();
    let first_msg = user_msg("Start");
    for i in 1..=5i64 {
        let mut msgs = vec![first_msg.clone()];
        for j in 1..i {
            msgs.push(assistant_msg(&format!("reply {}", j)));
            msgs.push(user_msg(&format!("follow-up {}", j)));
        }
        let r = mgr
            .resolve(&msgs, None, None, "2026-03-17T10:00:00Z", None, None)
            .unwrap();
        assert_eq!(r.sequence_num, i);
    }
}

/// Session ID is deterministic -- same inputs always produce same ID.
/// This is critical for multi-gateway consistency.
#[test]
fn session_id_is_deterministic() {
    let msgs = vec![user_msg("What is Rust?")];

    let mut mgr1 = SessionManager::new();
    let r1 = mgr1
        .resolve(
            &msgs,
            Some("org-x"),
            None,
            "2026-03-17T10:00:00Z",
            None,
            None,
        )
        .unwrap();

    let mut mgr2 = SessionManager::new();
    let r2 = mgr2
        .resolve(
            &msgs,
            Some("org-x"),
            None,
            "2026-03-20T15:30:00Z",
            None,
            None,
        )
        .unwrap();

    assert_eq!(
        r1.session_id, r2.session_id,
        "Same content = same session ID regardless of time or gateway instance"
    );
}

/// tentative_session_id is a pure function matching the manager's output
/// when no metadata session_id is provided.
#[test]
fn tentative_session_id_matches_resolve() {
    let msgs = vec![user_msg("Hello world")];
    let mut mgr = SessionManager::new();
    let r = mgr
        .resolve(
            &msgs,
            Some("org-1"),
            None,
            "2026-03-17T10:00:00Z",
            None,
            None,
        )
        .unwrap();
    let meta = ClientMetadata::default();
    let tentative = session::tentative_session_id(&meta, &msgs, Some("org-1"));
    assert_eq!(r.session_id, tentative);
}

/// W1 fix: Empty messages array produces a random UUID (not a collision-prone hash).
/// Each call with empty messages produces a different session ID.
#[test]
fn empty_messages_produces_unique_session_ids() {
    let mut mgr1 = SessionManager::new();
    let r1 = mgr1
        .resolve(&[], None, None, "2026-03-17T10:00:00Z", None, None)
        .unwrap();
    assert!(!r1.session_id.is_empty());
    assert_eq!(r1.sequence_num, 1);

    let mut mgr2 = SessionManager::new();
    let r2 = mgr2
        .resolve(&[], None, None, "2026-03-17T10:00:00Z", None, None)
        .unwrap();
    assert!(!r2.session_id.is_empty());

    // W1: two empty-message sessions must NOT collide
    assert_ne!(
        r1.session_id, r2.session_id,
        "Empty message sessions must get unique IDs (W1 fix)"
    );
}

/// System prompt changes don't split sessions -- only the first user message matters.
#[test]
fn system_prompt_changes_do_not_split_session() {
    let mut mgr = SessionManager::new();
    let msgs = vec![user_msg("What is 2+2?")];

    let r1 = mgr
        .resolve(
            &msgs,
            None,
            Some("You are helpful."),
            "2026-03-17T10:00:00Z",
            None,
            None,
        )
        .unwrap();
    let r2 = mgr
        .resolve(
            &msgs,
            None,
            Some("You are a comedian."),
            "2026-03-17T10:01:00Z",
            None,
            None,
        )
        .unwrap();

    assert_eq!(
        r1.session_id, r2.session_id,
        "System prompt change must NOT split session"
    );
}

/// extract_initial_intent still works.
#[test]
fn extract_initial_intent_from_messages() {
    let msgs = vec![user_msg("Fix the login bug in auth.ts")];
    let intent = session::extract_initial_intent(&msgs);
    assert_eq!(intent, Some("Fix the login bug in auth.ts".to_string()));
}

/// detect_agent_framework still works.
#[test]
fn detect_agent_framework_claude_code() {
    let fw = session::detect_agent_framework("You are Claude Code, Anthropic's CLI.");
    assert_eq!(fw, Some("claude_code".to_string()));
}

/// W3 fix: Pipe delimiter collision prevention.
/// org_id containing "|" must not collide with a different org + content combination.
#[test]
fn pipe_in_org_id_no_collision() {
    // org="a|b", content="c" vs org="a", content="b|c"
    // Without length-prefix: both hash "a|b|c" -> collision.
    // With length-prefix: "3:a|b|c" vs "1:a|b|c" -> no collision.
    let msgs = vec![user_msg("c")];
    let meta = ClientMetadata::default();
    let id1 = session::tentative_session_id(&meta, &msgs, Some("a|b"));

    let msgs2 = vec![user_msg("b|c")];
    let id2 = session::tentative_session_id(&meta, &msgs2, Some("a"));

    assert_ne!(id1, id2, "Pipe in org_id must not collide (W3 fix)");
}

/// N1: Cross-gateway sequence recovery test.
/// Simulates a gateway restart: create a session with 3 turns, then create a
/// NEW SessionManager (simulating restart) and resolve the same session with
/// current_max_seq = 3. The sequence must continue from 4.
#[test]
fn sequence_recovery_after_restart() {
    let mut mgr = SessionManager::new();
    let msgs = vec![user_msg("Recovery test message")];

    // Simulate 3 turns in the original gateway instance
    let r1 = mgr
        .resolve(&msgs, None, None, "2026-03-17T10:00:00Z", None, None)
        .unwrap();
    assert_eq!(r1.sequence_num, 1);
    assert!(r1.is_new_session);

    let r2 = mgr
        .resolve(&msgs, None, None, "2026-03-17T10:01:00Z", None, None)
        .unwrap();
    assert_eq!(r2.sequence_num, 2);
    assert!(!r2.is_new_session);

    let r3 = mgr
        .resolve(&msgs, None, None, "2026-03-17T10:02:00Z", None, None)
        .unwrap();
    assert_eq!(r3.sequence_num, 3);

    // Simulate gateway restart: new SessionManager, no in-memory state.
    // The caller queries the DB and finds max sequence_num = 3.
    let mut mgr2 = SessionManager::new();
    let r4 = mgr2
        .resolve(&msgs, None, None, "2026-03-17T10:03:00Z", Some(3), None)
        .unwrap();

    // B3 fix: must resume from 4 (not reset to 1)
    assert_eq!(
        r4.sequence_num, 4,
        "After restart with current_max_seq=3, sequence must resume at 4"
    );
    // When current_max_seq is provided, is_new_session should be false
    // because the session already exists in the DB.
    assert!(
        !r4.is_new_session,
        "Session with existing DB turns is not new"
    );

    // Subsequent turn in same manager should continue to 5
    let r5 = mgr2
        .resolve(&msgs, None, None, "2026-03-17T10:04:00Z", None, None)
        .unwrap();
    assert_eq!(
        r5.sequence_num, 5,
        "In-memory state continues after recovery"
    );
    assert!(!r5.is_new_session);
}
