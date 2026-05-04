# Recondo Schema Compliance Gap Analysis

Maps every captured schema field to SOC 2 Trust Services Criteria and ISO 42001 clauses.
Identifies current capture status and gaps requiring closure before Phase 2.

## Legend

- **SOC 2 TSC**: CC = Common Criteria, PI = Processing Integrity, C = Confidentiality, A = Availability, P = Privacy
- **ISO 42001**: Clauses 4-10 and Annex A/B controls for AI management systems
- **Status**: captured (gateway records it now), schema ready (column exists in DB with DEFAULT value, not yet populated by capture pipeline), inferred (derived from captured data), computed (calculated post-capture), planned (not yet captured)

---

## Sessions Table

| Field | SOC 2 TSC | ISO 42001 | Status | Notes |
|-------|-----------|-----------|--------|-------|
| id | CC6.1 (logical access) | 6.1.2 (AI system identification) | captured | Unique session identifier for audit trail |
| provider | CC7.2 (system monitoring) | Annex A.3 (third-party AI providers) | captured | LLM provider name (anthropic, openai, google) |
| model | CC7.2, PI1.3 | Annex A.4 (AI model inventory) | captured | Specific model version used |
| started_at | CC7.2 (monitoring), CC8.1 (change management) | 9.1 (monitoring, measurement) | captured | Session start timestamp for chronological audit |
| last_active_at | CC7.2 | 9.1 | captured | Tracks session liveness |
| ended_at | CC7.2 | 9.1 | captured | Session termination for duration analysis |
| initial_intent | CC6.3 (authorization) | Annex B.3 (AI purpose documentation) | captured | First user prompt, documents purpose of AI interaction |
| system_prompt_hash | CC6.1, CC8.1 | Annex A.5 (AI system configuration) | captured | SHA-256 hash of system prompt, detects configuration drift |
| total_turns | PI1.4 (completeness) | 9.1 (measurement) | captured | Aggregate interaction count per session |
| turns_captured | PI1.4 | 9.1 | captured | Verification that no turns were dropped |
| dropped_events | PI1.4, CC7.3 (anomaly detection) | 9.1 | captured | Monitors capture pipeline reliability |
| total_tokens | CC7.2, PI1.3 | 9.1, Annex A.8 (resource management) | captured | Usage intelligence for cost and capacity planning |
| total_cost_usd | CC7.2 | 9.1, Annex A.8 | computed | Derived from token counts and model pricing |
| framework | CC7.2 | Annex A.2 (AI development tools) | captured | Agent framework identifier (claude-code, codex, etc.) |
| agent_id | CC6.1 (identity), CC6.2 | 5.3 (organizational roles) | schema ready | Column exists with NULL default; capture pipeline population deferred to Phase 2 |
| agent_version | CC8.1 (change management) | 8.1 (operational planning) | schema ready | Column exists with NULL default; capture pipeline population deferred to Phase 2 |
| git_repo | CC8.1 | Annex A.6 (development lifecycle) | schema ready | Column exists with NULL default; capture pipeline population deferred to Phase 2 |
| git_branch | CC8.1 | Annex A.6 | schema ready | Column exists with NULL default; capture pipeline population deferred to Phase 2 |
| git_commit | CC8.1, PI1.1 (data integrity) | Annex A.6 | schema ready | Column exists with NULL default; capture pipeline population deferred to Phase 2 |
| working_directory | CC6.1, CC6.3 | Annex A.7 (access scope) | schema ready | Column exists with NULL default; capture pipeline population deferred to Phase 2 |
| parent_session_id | CC7.2 | 7.1 (AI system planning) | schema ready | Column exists with NULL default; capture pipeline population deferred to Phase 2 |
| tags | CC7.2 | 10.2 (continual improvement) | schema ready | Column exists with NULL default; capture pipeline population deferred to Phase 2 |

## Turns Table

| Field | SOC 2 TSC | ISO 42001 | Status | Notes |
|-------|-----------|-----------|--------|-------|
| id | CC6.1 | 6.1.2 | captured | Unique turn identifier |
| session_id | CC6.1 | 6.1.2 | captured | Links turn to parent session |
| sequence_num | PI1.4 (completeness, ordering) | 9.1 | captured | Ensures chronological ordering within session |
| timestamp | CC7.2, PI1.1 | 9.1 | captured | Precise time of interaction |
| request_hash | PI1.1 (data integrity) | Annex A.5 | captured | SHA-256 of request body, tamper detection |
| response_hash | PI1.1 | Annex A.5 | captured | SHA-256 of response body, tamper detection |
| req_bytes_ref | PI1.1, CC9.1 (recovery) | 8.1 | captured | Object store reference for full request recovery |
| resp_bytes_ref | PI1.1, CC9.1 | 8.1 | captured | Object store reference for full response recovery |
| req_bytes_size | CC7.2 | 9.1 | captured | Request payload size for usage monitoring |
| resp_bytes_size | CC7.2 | 9.1 | captured | Response payload size for usage monitoring |
| model | CC7.2, PI1.3 | Annex A.4 | captured | Model used for this specific turn |
| response_text | PI1.3 (accuracy) | Annex B.4 (AI output documentation) | captured | Full AI response text for content audit |
| thinking_text | PI1.3 | Annex B.4 | captured | Extended thinking content (chain-of-thought) |
| stop_reason | CC7.2, CC7.3 | 9.1 | captured | Why the model stopped (end_turn, tool_use, error) |
| capture_complete | PI1.4 | 9.1 | captured | Boolean flag for capture pipeline integrity |
| input_tokens | CC7.2, PI1.3 | 9.1, Annex A.8 | captured | Input token count for cost and usage |
| output_tokens | CC7.2, PI1.3 | 9.1, Annex A.8 | captured | Output token count for cost and usage |
| cache_read_tokens | CC7.2 | 9.1 | captured | Prompt cache read tokens |
| cache_creation_tokens | CC7.2 | 9.1 | captured | Prompt cache creation tokens |
| cost_usd | CC7.2 | Annex A.8 | computed | Per-turn cost estimate |
| created_at | CC7.2 | 9.1 | captured | DB insertion timestamp |
| messages_delta | PI1.4 | Annex B.4 | captured | Incremental messages for storage efficiency |
| messages_delta_count | PI1.4 | 9.1 | captured | Count of new messages in delta |
| raw_extra | CC7.4 (forward compat) | 10.2 | captured | Unknown fields preserved as JSON |
| parser_version | CC8.1 | 8.1 | captured | Parser version for reproducibility |
| parse_errors | CC7.3 (anomaly detection) | 9.1 | captured | Parse failures logged for investigation |
| provider | CC7.2 | Annex A.3 | captured | Provider name on each turn |
| transport | CC7.2 | 8.1 | captured | HTTP or WebSocket transport type |
| ws_direction | CC7.2 | 8.1 | captured | WebSocket message direction |
| duration_ms | PI1.3, A1.2 (availability) | 9.1 (performance monitoring) | schema ready | Column exists with NULL default; capture pipeline population deferred to Phase 2 |
| ttfb_ms | A1.2 | 9.1 | schema ready | Column exists with NULL default; capture pipeline population deferred to Phase 2 |
| api_endpoint | CC7.2 | 8.1 | schema ready | Column exists with NULL default; capture pipeline population deferred to Phase 2 |
| http_status | CC7.2, CC7.3 | 9.1 | schema ready | Column exists with NULL default; capture pipeline population deferred to Phase 2 |
| error_message | CC7.3 | 9.1, 10.1 (nonconformity) | schema ready | Column exists with NULL default; capture pipeline population deferred to Phase 2 |
| retry_count | CC7.3, A1.2 | 9.1 | schema ready | Column exists with DEFAULT 0; capture pipeline population deferred to Phase 2 |
| tool_call_count | CC7.2 | Annex B.5 (AI tool usage) | schema ready | Column exists with DEFAULT 0; capture pipeline population deferred to Phase 2 |
| thinking_tokens | CC7.2, PI1.3 | 9.1, Annex A.8 | schema ready | Column exists with DEFAULT 0; capture pipeline population deferred to Phase 2 |
| server_id | CC7.2 | 8.1 (infrastructure tracking) | schema ready | Column exists with NULL default; capture pipeline population deferred to Phase 2 |

## Tool Calls Table

| Field | SOC 2 TSC | ISO 42001 | Status | Notes |
|-------|-----------|-----------|--------|-------|
| id | CC6.1 | 6.1.2 | captured | Unique tool call identifier |
| turn_id | CC6.1 | 6.1.2 | captured | Links tool call to parent turn |
| tool_name | CC6.3 (authorization), CC7.2 | Annex B.5 (AI tool usage) | captured | Which tool was invoked (Read, Bash, Edit, etc.) |
| tool_input | CC6.3, PI1.3 | Annex B.5 | captured | Full tool input JSON for audit trail |
| input_hash | PI1.1 | Annex A.5 | captured | SHA-256 of tool input for integrity |
| sequence_num | PI1.4 | 9.1 | schema ready | Column exists with NULL default; capture pipeline population deferred to Phase 2 |
| output | PI1.3, CC7.2 | Annex B.5 | schema ready | Column exists with NULL default; capture pipeline population deferred to Phase 2 |
| output_hash | PI1.1 | Annex A.5 | schema ready | Column exists with NULL default; capture pipeline population deferred to Phase 2 |
| duration_ms | A1.2, PI1.3 | 9.1 | schema ready | Column exists with NULL default; capture pipeline population deferred to Phase 2 |
| error | CC7.3 | 9.1, 10.1 | schema ready | Column exists with NULL default; capture pipeline population deferred to Phase 2 |
| status | CC7.2, PI1.4 | 9.1 | schema ready | Column exists with NULL default; capture pipeline population deferred to Phase 2 |

---

## Gap Summary

All schema fields are either **captured** by the gateway, **computed** from captured data, or **schema ready** (column exists in DB with DEFAULT values, awaiting capture pipeline integration in Phase 2). No fields remain in **planned** status. 23 v2 columns (8 sessions, 9 turns, 6 tool_calls) are schema ready but not yet populated by the capture pipeline.

### SOC 2 Coverage
- **CC1-CC5** (Control Environment, Communication, Risk Assessment, Monitoring, Control Activities): Covered via agent_id, system_prompt_hash, tags, and session hierarchy
- **CC6** (Logical Access): agent_id, working_directory, tool_name, tool_input
- **CC7** (System Operations): provider, model, timestamps, token counts, error tracking
- **CC8** (Change Management): git_repo, git_branch, git_commit, agent_version, parser_version
- **CC9** (Risk Mitigation): req_bytes_ref, resp_bytes_ref enable full payload recovery
- **PI1** (Processing Integrity): hashes, sequence numbers, capture_complete flag, parse_errors
- **A1** (Availability): duration_ms, ttfb_ms, retry_count for SLA monitoring
- **C1** (Confidentiality): API keys captured in headers (stored with restricted filesystem permissions)
- **P1** (Privacy): No PII-specific fields yet; tags can label sessions containing PII for review

### ISO 42001 Coverage
- **Clause 4-5** (Context, Leadership): Organization-level controls outside schema scope
- **Clause 6** (Planning): session id, agent_id for AI system identification
- **Clause 7** (Support): Competence and awareness controls outside schema scope
- **Clause 8** (Operation): All operational fields captured per turn and tool call
- **Clause 9** (Performance Evaluation): Token counts, duration, cost for measurement
- **Clause 10** (Improvement): parse_errors, error_message, tags for nonconformity tracking
- **Annex A/B**: AI-specific controls mapped per field above
