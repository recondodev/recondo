/**
 * Structured query primitives for the /v1/query API surface.
 *
 * Hosts the 8 per-operation query helpers (sessions, turns, anomalies,
 * cost, tools, risk, compliance, provenance) plus a `runStructuredQuery`
 * dispatcher used by the legacy HTTP route.
 *
 * The HTTP/Fastify-shape concerns (request validation, format switching,
 * attribution lookup, response shaping, timeout handling) stay in
 * `api/src/query/builder.ts`.
 *
 * Per-operation `listStructured*` exports return `AsyncIterable<row>` so
 * new consumers (TUI, MCP, GraphQL) can stream results and honour
 * `AbortSignal` mid-iteration. The dispatcher materialises into
 * `{rows, totalCount}` for the legacy /v1/query body shape.
 */

import { getPool } from "./pool.js";
import { abortableIterable } from "./async-iter.js";
import {
  sanitizeAnomalyRow,
  sanitizeRowTextFields,
  SESSION_TEXT_FIELDS,
  TOOL_CALL_TEXT_FIELDS,
  TURN_TEXT_FIELDS,
} from "./redaction/index.js";
import type { ListOptions, QueryOptions } from "./types.js";

// ---------------------------------------------------------------------------
// SQL safety helpers
// ---------------------------------------------------------------------------

/** Escape SQL ILIKE meta-characters so user input is treated literally. */
function escapeIlike(s: string): string {
  return s.replace(/[%_\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Private query helpers (moved verbatim from api/src/query/builder.ts).
// Bodies are NOT to be edited as part of the refactor — only imports.
// ---------------------------------------------------------------------------

async function querySessions(
  projectId: string,
  filters: Record<string, unknown>,
  limit: number
): Promise<{ rows: Record<string, unknown>[]; totalCount: number }> {
  const pool = getPool();
  const conditions: string[] = ["s.project_id = $1"];
  const values: unknown[] = [projectId];
  let idx = 2;

  if (filters.sessionId) {
    conditions.push(`s.id = $${idx++}`);
    values.push(filters.sessionId);
  }
  if (filters.provider) {
    conditions.push(`s.provider = $${idx++}`);
    values.push(filters.provider);
  }
  if (filters.model) {
    conditions.push(`s.model = $${idx++}`);
    values.push(filters.model);
  }
  if (filters.agent) {
    conditions.push(`s.agent_id = $${idx++}`);
    values.push(filters.agent);
  }
  if (filters.riskLevel) {
    conditions.push(`sr.risk_level = $${idx++}`);
    values.push(filters.riskLevel);
  }
  if (filters.dateRange && typeof filters.dateRange === "object") {
    const dr = filters.dateRange as { from?: string; to?: string };
    if (dr.from) {
      conditions.push(`s.started_at::timestamptz >= $${idx++}::timestamptz`);
      values.push(dr.from);
    }
    if (dr.to) {
      conditions.push(`s.started_at::timestamptz <= $${idx++}::timestamptz`);
      values.push(dr.to);
    }
  }
  if (filters.search && typeof filters.search === "string") {
    // Full-text search via PostgreSQL tsvector with plainto_tsquery.
    // Falls back to ILIKE on initial_intent if search_vector column
    // is not available (e.g., older schema without the column).
    // The search_vector GIN index provides stemming, ranking, and
    // performance benefits over ILIKE pattern matching.
    conditions.push(
      `(EXISTS (SELECT 1 FROM turns t2 WHERE t2.session_id = s.id AND t2.search_vector @@ plainto_tsquery('english', $${idx})) OR s.initial_intent ILIKE $${idx + 1})`
    );
    values.push(filters.search);
    values.push(`%${escapeIlike(filters.search)}%`);
    idx += 2;
  }

  const riskJoin = filters.riskLevel
    ? "LEFT JOIN session_risk sr ON s.id = sr.session_id"
    : "";

  const where = conditions.join(" AND ");

  // Count query
  const countResult = await pool.query(
    `SELECT count(*)::int AS n FROM sessions s ${riskJoin} WHERE ${where}`,
    values
  );
  const totalCount = countResult.rows[0].n;

  // Data query
  values.push(limit);
  const dataResult = await pool.query(
    `SELECT s.* FROM sessions s ${riskJoin} WHERE ${where}
     ORDER BY s.started_at DESC LIMIT $${idx}`,
    values
  );

  // FIND-4-B: sanitise initial_intent (and other session text fields)
  // before returning. `SELECT s.*` emits every column, so without this
  // pass `[Image: source: /Users/.../N.png]` placeholders ship raw to
  // the /v1/query client.
  const sanitizedSessionRows = dataResult.rows.map((r) =>
    sanitizeRowTextFields(r as Record<string, unknown>, SESSION_TEXT_FIELDS),
  );
  return { rows: sanitizedSessionRows, totalCount };
}

async function queryTurns(
  projectId: string,
  filters: Record<string, unknown>,
  limit: number
): Promise<{ rows: Record<string, unknown>[]; totalCount: number }> {
  const pool = getPool();
  const conditions: string[] = ["s.project_id = $1"];
  const values: unknown[] = [projectId];
  let idx = 2;

  if (filters.sessionId) {
    conditions.push(`t.session_id = $${idx++}`);
    values.push(filters.sessionId);
  }
  if (filters.model) {
    conditions.push(`t.model = $${idx++}`);
    values.push(filters.model);
  }
  if (filters.toolName) {
    conditions.push(`t.tool_call_count > 0`);
  }
  if (filters.dateRange && typeof filters.dateRange === "object") {
    const dr = filters.dateRange as { from?: string; to?: string };
    if (dr.from) {
      conditions.push(`t.timestamp::timestamptz >= $${idx++}::timestamptz`);
      values.push(dr.from);
    }
    if (dr.to) {
      conditions.push(`t.timestamp::timestamptz <= $${idx++}::timestamptz`);
      values.push(dr.to);
    }
  }

  const where = conditions.join(" AND ");

  const countResult = await pool.query(
    `SELECT count(*)::int AS n FROM turns t
     JOIN sessions s ON t.session_id = s.id
     WHERE ${where}`,
    values
  );
  const totalCount = countResult.rows[0].n;

  values.push(limit);
  const dataResult = await pool.query(
    `SELECT t.* FROM turns t
     JOIN sessions s ON t.session_id = s.id
     WHERE ${where}
     ORDER BY t.timestamp DESC LIMIT $${idx}`,
    values
  );

  // FIND-4-B: sanitise turn text fields (`SELECT t.*` emits all columns
  // including user_request_text / response_text / thinking_text).
  const sanitizedTurnRows = dataResult.rows.map((r) =>
    sanitizeRowTextFields(r as Record<string, unknown>, TURN_TEXT_FIELDS),
  );
  return { rows: sanitizedTurnRows, totalCount };
}

async function queryAnomalies(
  projectId: string,
  filters: Record<string, unknown>,
  limit: number
): Promise<{ rows: Record<string, unknown>[]; totalCount: number }> {
  const pool = getPool();
  const conditions: string[] = ["s.project_id = $1"];
  const values: unknown[] = [projectId];
  let idx = 2;

  if (filters.severity) {
    conditions.push(`ae.severity = $${idx++}`);
    values.push(filters.severity);
  }
  if (filters.anomalyType) {
    conditions.push(`ae.anomaly_type = $${idx++}`);
    values.push(filters.anomalyType);
  }
  if (filters.resolved !== undefined) {
    // If resolved filter is used, we check metadata->resolved
    conditions.push(`(ae.metadata->>'resolved')::boolean = $${idx++}`);
    values.push(filters.resolved);
  }
  if (filters.dateRange && typeof filters.dateRange === "object") {
    const dr = filters.dateRange as { from?: string; to?: string };
    if (dr.from) {
      conditions.push(`ae.detected_at::TIMESTAMPTZ >= $${idx++}::timestamptz`);
      values.push(dr.from);
    }
    if (dr.to) {
      conditions.push(`ae.detected_at::TIMESTAMPTZ <= $${idx++}::timestamptz`);
      values.push(dr.to);
    }
  }

  const where = conditions.join(" AND ");

  const countResult = await pool.query(
    `SELECT count(*)::int AS n FROM anomaly_events ae
     JOIN sessions s ON ae.session_id = s.id
     WHERE ${where}`,
    values
  );
  const totalCount = countResult.rows[0].n;

  values.push(limit);
  const dataResult = await pool.query(
    `SELECT ae.* FROM anomaly_events ae
     JOIN sessions s ON ae.session_id = s.id
     WHERE ${where}
     ORDER BY ae.detected_at DESC LIMIT $${idx}`,
    values
  );

  // FIND-6-C + FIND-10-E: sanitise `description`, `resolution_note`,
  // AND `metadata` JSONB string values. Anomaly detection often
  // quotes the source turn's `initial_intent` / `user_request_text`
  // into the description AND persists `tool_name` into
  // `metadata.toolName`, both of which may carry the
  // `[Image: source: /path]` placeholder shape. `SELECT ae.*` emits
  // every column; without `sanitizeAnomalyRow`'s deep walk, the
  // metadata path leaks through /v1/query?queryType=anomalies.
  const sanitizedAnomalyRows = dataResult.rows.map((r) =>
    sanitizeAnomalyRow(r as Record<string, unknown>),
  );
  return { rows: sanitizedAnomalyRows, totalCount };
}

async function queryCost(
  projectId: string,
  filters: Record<string, unknown>,
  groupBy: string | undefined,
  limit: number
): Promise<{ rows: Record<string, unknown>[]; totalCount: number }> {
  const pool = getPool();
  const conditions: string[] = ["s.project_id = $1"];
  const values: unknown[] = [projectId];
  let idx = 2;

  if (filters.dateRange && typeof filters.dateRange === "object") {
    const dr = filters.dateRange as { from?: string; to?: string };
    if (dr.from) {
      conditions.push(`t.timestamp::timestamptz >= $${idx++}::timestamptz`);
      values.push(dr.from);
    }
    if (dr.to) {
      conditions.push(`t.timestamp::timestamptz <= $${idx++}::timestamptz`);
      values.push(dr.to);
    }
  }

  const where = conditions.join(" AND ");

  // Determine group by column
  let groupByCol: string;
  let selectExtra: string;
  switch (groupBy) {
    case "model":
      groupByCol = "t.model";
      selectExtra = "t.model";
      break;
    case "provider":
      groupByCol = "COALESCE(t.provider, s.provider)";
      selectExtra = "COALESCE(t.provider, s.provider) AS provider";
      break;
    case "agent":
      groupByCol = "s.agent_id";
      selectExtra = "s.agent_id AS agent";
      break;
    case "team":
      // No team column in sessions; use agent_id as a proxy
      groupByCol = "s.agent_id";
      selectExtra = "s.agent_id AS team";
      break;
    default:
      // No groupBy: aggregate all
      groupByCol = "";
      selectExtra = "";
  }

  // Period grouping (daily, weekly, monthly)
  const period = filters.period as string | undefined;
  let periodCol = "";
  if (period === "daily") {
    periodCol = "DATE_TRUNC('day', t.timestamp::timestamptz)";
  } else if (period === "weekly") {
    periodCol = "DATE_TRUNC('week', t.timestamp::timestamptz)";
  } else if (period === "monthly") {
    periodCol = "DATE_TRUNC('month', t.timestamp::timestamptz)";
  }

  // Build GROUP BY clause parts
  const groupParts: string[] = [];
  if (groupByCol) groupParts.push(groupByCol);
  if (periodCol) groupParts.push(periodCol);

  const groupClause =
    groupParts.length > 0 ? `GROUP BY ${groupParts.join(", ")}` : "";

  // Build SELECT columns list with proper comma separation
  const selectCols: string[] = [];
  if (periodCol) selectCols.push(`${periodCol} AS period_start`);
  if (selectExtra) selectCols.push(selectExtra);
  selectCols.push(
    "SUM(COALESCE(t.cost_usd, 0)) AS total_cost_usd",
    "SUM(t.input_tokens) AS total_input_tokens",
    "SUM(t.output_tokens) AS total_output_tokens",
    "COUNT(t.id) AS turn_count"
  );
  const selectParts = selectCols.join(", ");

  if (!groupByCol && !periodCol) {
    // No grouping: single aggregate row
    const dataResult = await pool.query(
      `SELECT ${selectParts}
       FROM turns t
       JOIN sessions s ON t.session_id = s.id
       WHERE ${where}`,
      values
    );
    return { rows: dataResult.rows, totalCount: dataResult.rows.length };
  }

  // Count distinct groups
  const countResult = await pool.query(
    `SELECT count(*)::int AS n FROM (
       SELECT 1 FROM turns t
       JOIN sessions s ON t.session_id = s.id
       WHERE ${where}
       ${groupClause}
     ) sub`,
    values
  );
  const totalCount = countResult.rows[0].n;

  values.push(limit);
  const dataResult = await pool.query(
    `SELECT ${selectParts}
     FROM turns t
     JOIN sessions s ON t.session_id = s.id
     WHERE ${where}
     ${groupClause}
     ORDER BY total_cost_usd DESC LIMIT $${idx}`,
    values
  );

  return { rows: dataResult.rows, totalCount };
}

async function queryTools(
  projectId: string,
  filters: Record<string, unknown>,
  limit: number
): Promise<{ rows: Record<string, unknown>[]; totalCount: number }> {
  const pool = getPool();
  const conditions: string[] = ["s.project_id = $1"];
  const values: unknown[] = [projectId];
  let idx = 2;

  if (filters.toolName) {
    conditions.push(`tc.tool_name = $${idx++}`);
    values.push(filters.toolName);
  }
  if (filters.agent) {
    conditions.push(`s.agent_id = $${idx++}`);
    values.push(filters.agent);
  }
  if (filters.dateRange && typeof filters.dateRange === "object") {
    const dr = filters.dateRange as { from?: string; to?: string };
    if (dr.from) {
      conditions.push(`t.timestamp::timestamptz >= $${idx++}::timestamptz`);
      values.push(dr.from);
    }
    if (dr.to) {
      conditions.push(`t.timestamp::timestamptz <= $${idx++}::timestamptz`);
      values.push(dr.to);
    }
  }

  const where = conditions.join(" AND ");

  const countResult = await pool.query(
    `SELECT count(*)::int AS n FROM tool_calls tc
     JOIN turns t ON tc.turn_id = t.id
     JOIN sessions s ON t.session_id = s.id
     WHERE ${where}`,
    values
  );
  const totalCount = countResult.rows[0].n;

  values.push(limit);
  const dataResult = await pool.query(
    `SELECT tc.tool_name, tc.status, tc.duration_ms, s.agent_id,
            tc.id, tc.turn_id, tc.tool_input, tc.output
     FROM tool_calls tc
     JOIN turns t ON tc.turn_id = t.id
     JOIN sessions s ON t.session_id = s.id
     WHERE ${where}
     ORDER BY tc.tool_name LIMIT $${idx}`,
    values
  );

  // FIND-1-M re-open: query-builder results feed customer-facing
  // exports and saved queries. Sanitise tool_input / output so
  // placeholder paths don't leak.
  const sanitizedRows = dataResult.rows.map((r) =>
    sanitizeRowTextFields(r as Record<string, unknown>, TOOL_CALL_TEXT_FIELDS),
  );
  return { rows: sanitizedRows, totalCount };
}

async function queryRisk(
  projectId: string,
  filters: Record<string, unknown>,
  limit: number
): Promise<{ rows: Record<string, unknown>[]; totalCount: number }> {
  const pool = getPool();
  const conditions: string[] = ["s.project_id = $1"];
  const values: unknown[] = [projectId];
  let idx = 2;

  if (filters.riskLevel) {
    conditions.push(`sr.risk_level = $${idx++}`);
    values.push(filters.riskLevel);
  }
  if (filters.dateRange && typeof filters.dateRange === "object") {
    const dr = filters.dateRange as { from?: string; to?: string };
    if (dr.from) {
      conditions.push(`s.started_at::timestamptz >= $${idx++}::timestamptz`);
      values.push(dr.from);
    }
    if (dr.to) {
      conditions.push(`s.started_at::timestamptz <= $${idx++}::timestamptz`);
      values.push(dr.to);
    }
  }

  const where = conditions.join(" AND ");

  try {
    // session_risk may not exist for all sessions, LEFT JOIN
    const countResult = await pool.query(
      `SELECT count(*)::int AS n FROM sessions s
       LEFT JOIN session_risk sr ON s.id = sr.session_id
       WHERE ${where}`,
      values
    );
    const totalCount = countResult.rows[0].n;

    values.push(limit);
    const dataResult = await pool.query(
      `SELECT s.id, s.initial_intent, s.provider, s.model,
              sr.risk_level, sr.classified_at
       FROM sessions s
       LEFT JOIN session_risk sr ON s.id = sr.session_id
       WHERE ${where}
       ORDER BY s.started_at DESC LIMIT $${idx}`,
      values
    );

    // FIND-1-M re-open: sanitize `initial_intent` before returning.
    const sanitizedRiskRows = dataResult.rows.map((r) =>
      sanitizeRowTextFields(r as Record<string, unknown>, SESSION_TEXT_FIELDS),
    );
    return { rows: sanitizedRiskRows, totalCount };
  } catch (err: unknown) {
    // Gracefully handle missing session_risk table (created at startup)
    const msg = err instanceof Error ? err.message : "";
    if (msg.includes("session_risk") && msg.includes("does not exist")) {
      return { rows: [], totalCount: 0 };
    }
    throw err;
  }
}

async function queryCompliance(
  projectId: string,
  filters: Record<string, unknown>,
  limit: number
): Promise<{ rows: Record<string, unknown>[]; totalCount: number }> {
  const pool = getPool();

  // Compliance is a derived query. We build a compliance summary from sessions:
  // - total sessions, total turns, completeness rate, anomaly count
  // - Filter by framework or clause
  const framework = filters.framework as string | undefined;
  const clause = filters.clause as string | undefined;

  // Launch independent queries in parallel, collect rows in order afterward
  type RowBuilder = () => Promise<Record<string, unknown> | null>;
  const builders: RowBuilder[] = [];

  // SOC 2 metrics
  if (!framework || framework === "soc2") {
    const sessPromise = pool.query(
      `SELECT count(*)::int AS total_sessions,
              SUM(total_turns)::int AS total_turns,
              SUM(turns_captured)::int AS turns_captured,
              SUM(dropped_events)::int AS dropped_events
       FROM sessions WHERE project_id = $1`,
      [projectId]
    );
    builders.push(async () => {
      const sessResult = await sessPromise;
      const s = sessResult.rows[0];
      const completeness =
        s.total_turns > 0
          ? ((s.turns_captured / s.total_turns) * 100).toFixed(1)
          : "100.0";
      return {
        framework: "soc2",
        clause: "PI1",
        description: "Processing Integrity",
        status: Number(completeness) >= 99 ? "compliant" : "needs_review",
        total_sessions: s.total_sessions,
        completeness_pct: Number(completeness),
        dropped_events: s.dropped_events,
      };
    });
  }

  // ISO 42001 metrics
  if (!framework || framework === "iso42001") {
    // Cl.9.1 Monitoring
    if (!clause || clause === "9.1") {
      const anomalyPromise = pool.query(
        `SELECT count(*)::int AS anomaly_count
         FROM anomaly_events ae
         JOIN sessions s ON ae.session_id = s.id
         WHERE s.project_id = $1`,
        [projectId]
      );
      builders.push(async () => {
        const anomalyResult = await anomalyPromise;
        return {
          framework: "iso42001",
          clause: "9.1",
          description: "Monitoring, measurement, analysis and evaluation",
          status: "active",
          anomaly_count: anomalyResult.rows[0].anomaly_count,
        };
      });
    }

    // Cl.9.3 Management review
    if (!clause || clause === "9.3") {
      const sessCountPromise = pool.query(
        `SELECT count(*)::int AS n FROM sessions WHERE project_id = $1`,
        [projectId]
      );
      builders.push(async () => {
        const sessCount = await sessCountPromise;
        return {
          framework: "iso42001",
          clause: "9.3",
          description: "Management review",
          status: sessCount.rows[0].n > 0 ? "data_available" : "no_data",
          total_sessions: sessCount.rows[0].n,
        };
      });
    }

    // Cl.6.1 Risk assessment
    if (!clause || clause === "6.1") {
      const riskPromise = pool.query(
        `SELECT count(*)::int AS classified
         FROM session_risk sr
         JOIN sessions s ON sr.session_id = s.id
         WHERE s.project_id = $1`,
        [projectId]
      ).catch((err: unknown) => {
        // Gracefully handle missing session_risk table (created at startup)
        const msg = err instanceof Error ? err.message : "";
        if (msg.includes("session_risk") && msg.includes("does not exist")) {
          return { rows: [{ classified: 0 }] };
        }
        throw err;
      });
      builders.push(async () => {
        const riskResult = await riskPromise;
        return {
          framework: "iso42001",
          clause: "6.1",
          description: "Risk assessment",
          status: riskResult.rows[0].classified > 0 ? "active" : "pending",
          classified_sessions: riskResult.rows[0].classified,
        };
      });
    }

    // Cl.8.5 AI System Lifecycle
    if (!clause || clause === "8.5") {
      const toolPromise = pool.query(
        `SELECT count(DISTINCT tc.tool_name)::int AS unique_tools
         FROM tool_calls tc
         JOIN turns t ON tc.turn_id = t.id
         JOIN sessions s ON t.session_id = s.id
         WHERE s.project_id = $1`,
        [projectId]
      );
      builders.push(async () => {
        const toolResult = await toolPromise;
        return {
          framework: "iso42001",
          clause: "8.5",
          description: "AI system lifecycle",
          status: "active",
          unique_tools: toolResult.rows[0].unique_tools,
        };
      });
    }
  }

  // Await all builders in parallel (queries already dispatched)
  const results = await Promise.all(builders.map((b) => b()));
  const rows = results.filter((r): r is Record<string, unknown> => r !== null);

  // Apply limit
  const limited = rows.slice(0, limit);

  return { rows: limited, totalCount: rows.length };
}

async function queryProvenance(
  projectId: string,
  filters: Record<string, unknown>,
  limit: number
): Promise<{ rows: Record<string, unknown>[]; totalCount: number }> {
  const artifactPath = filters.artifactPath as string | undefined;

  if (!artifactPath) {
    throw new Error("provenance query requires artifactPath filter");
  }

  const pool = getPool();

  // Find tool_calls that reference this artifact via tool_input or artifacts_created,
  // then walk the supersedes chain via turns.supersedes_turn_id
  const dataResult = await pool.query(
    `SELECT tc.id AS tool_call_id, tc.tool_name, tc.tool_input, tc.output,
            tc.artifacts_created, t.id AS turn_id, t.session_id,
            t.timestamp, t.supersedes_turn_id,
            s.agent_id, s.provider, s.model
     FROM tool_calls tc
     JOIN turns t ON tc.turn_id = t.id
     JOIN sessions s ON t.session_id = s.id
     WHERE s.project_id = $1
       AND (tc.tool_input ILIKE $2 ESCAPE '\\' OR tc.artifacts_created ILIKE $2 ESCAPE '\\')
     ORDER BY t.timestamp ASC
     LIMIT $3`,
    [projectId, `%${escapeIlike(artifactPath)}%`, limit]
  );

  // FIND-4-B: sanitise tc.tool_input and tc.output. `artifacts_created`
  // is a JSON array of paths the gateway extracted from tool calls and
  // never carries the `[Image: source: /path]` placeholder shape (the
  // extractor only surfaces real artifact paths from tool input
  // structure, not from sibling text blocks). Sanitising it would
  // silently rewrite the audit trail of which files a tool wrote — so
  // we deliberately leave it raw. tool_input and output do echo
  // user-attached placeholders back, so those get sanitized.
  const sanitizedProvenanceRows = dataResult.rows.map((r) =>
    sanitizeRowTextFields(r as Record<string, unknown>, TOOL_CALL_TEXT_FIELDS),
  );
  return {
    rows: sanitizedProvenanceRows,
    totalCount: dataResult.rows.length,
  };
}

// ---------------------------------------------------------------------------
// Per-operation public exports — `AsyncIterable<row>`. AbortSignal is
// checked BEFORE issuing SQL, and `abortableIterable` wraps the inner
// generator so mid-iteration aborts also throw `DOMException("aborted",
// "AbortError")`.
// ---------------------------------------------------------------------------

export function listStructuredSessions(
  projectId: string,
  filters: Record<string, unknown>,
  options: ListOptions = {},
): AsyncIterable<Record<string, unknown>> {
  const limit = options.limit ?? 100;
  const inner = (async function* () {
    if (options.signal?.aborted) {
      throw new DOMException("aborted", "AbortError");
    }
    const { rows } = await querySessions(projectId, filters, limit);
    for (const row of rows) yield row;
  })();
  return abortableIterable(inner, options.signal);
}

export function listStructuredTurns(
  projectId: string,
  filters: Record<string, unknown>,
  options: ListOptions = {},
): AsyncIterable<Record<string, unknown>> {
  const limit = options.limit ?? 100;
  const inner = (async function* () {
    if (options.signal?.aborted) {
      throw new DOMException("aborted", "AbortError");
    }
    const { rows } = await queryTurns(projectId, filters, limit);
    for (const row of rows) yield row;
  })();
  return abortableIterable(inner, options.signal);
}

export function listStructuredAnomalies(
  projectId: string,
  filters: Record<string, unknown>,
  options: ListOptions = {},
): AsyncIterable<Record<string, unknown>> {
  const limit = options.limit ?? 100;
  const inner = (async function* () {
    if (options.signal?.aborted) {
      throw new DOMException("aborted", "AbortError");
    }
    const { rows } = await queryAnomalies(projectId, filters, limit);
    for (const row of rows) yield row;
  })();
  return abortableIterable(inner, options.signal);
}

export function listStructuredCost(
  projectId: string,
  filters: Record<string, unknown>,
  groupBy: string | undefined,
  options: ListOptions = {},
): AsyncIterable<Record<string, unknown>> {
  const limit = options.limit ?? 100;
  const inner = (async function* () {
    if (options.signal?.aborted) {
      throw new DOMException("aborted", "AbortError");
    }
    const { rows } = await queryCost(projectId, filters, groupBy, limit);
    for (const row of rows) yield row;
  })();
  return abortableIterable(inner, options.signal);
}

export function listStructuredTools(
  projectId: string,
  filters: Record<string, unknown>,
  options: ListOptions = {},
): AsyncIterable<Record<string, unknown>> {
  const limit = options.limit ?? 100;
  const inner = (async function* () {
    if (options.signal?.aborted) {
      throw new DOMException("aborted", "AbortError");
    }
    const { rows } = await queryTools(projectId, filters, limit);
    for (const row of rows) yield row;
  })();
  return abortableIterable(inner, options.signal);
}

export function listStructuredRisk(
  projectId: string,
  filters: Record<string, unknown>,
  options: ListOptions = {},
): AsyncIterable<Record<string, unknown>> {
  const limit = options.limit ?? 100;
  const inner = (async function* () {
    if (options.signal?.aborted) {
      throw new DOMException("aborted", "AbortError");
    }
    const { rows } = await queryRisk(projectId, filters, limit);
    for (const row of rows) yield row;
  })();
  return abortableIterable(inner, options.signal);
}

export function listStructuredCompliance(
  projectId: string,
  filters: Record<string, unknown>,
  options: ListOptions = {},
): AsyncIterable<Record<string, unknown>> {
  const limit = options.limit ?? 100;
  const inner = (async function* () {
    if (options.signal?.aborted) {
      throw new DOMException("aborted", "AbortError");
    }
    const { rows } = await queryCompliance(projectId, filters, limit);
    for (const row of rows) yield row;
  })();
  return abortableIterable(inner, options.signal);
}

export function listStructuredProvenance(
  projectId: string,
  filters: Record<string, unknown>,
  options: ListOptions = {},
): AsyncIterable<Record<string, unknown>> {
  const limit = options.limit ?? 100;
  const inner = (async function* () {
    if (options.signal?.aborted) {
      throw new DOMException("aborted", "AbortError");
    }
    // Provenance requires `artifactPath`. The legacy /v1/query route
    // pre-validates this and returns 400; the data-layer iterable
    // surface treats the missing-filter case as an empty result so
    // that callers iterating over results (TUI, MCP) don't have to
    // special-case the throw. The dispatcher mirrors this behaviour.
    if (typeof filters.artifactPath !== "string" || filters.artifactPath.length === 0) {
      return;
    }
    const { rows } = await queryProvenance(projectId, filters, limit);
    for (const row of rows) yield row;
  })();
  return abortableIterable(inner, options.signal);
}

// ---------------------------------------------------------------------------
// Compatibility dispatcher
// ---------------------------------------------------------------------------

/**
 * Switch-dispatch over `queryType` for the legacy /v1/query HTTP route.
 * Returns the materialised `{rows, totalCount}` shape because that
 * route emits one JSON body. New consumers should call the
 * per-operation `listStructured*` functions directly and use
 * `Array.fromAsync` if they need a buffered array.
 */
export async function runStructuredQuery(
  queryType: string,
  projectId: string,
  filters: Record<string, unknown>,
  groupBy: string | undefined,
  limit: number,
  options: QueryOptions = {},
): Promise<{ rows: Record<string, unknown>[]; totalCount: number }> {
  if (options.signal?.aborted) {
    throw new DOMException("aborted", "AbortError");
  }
  switch (queryType) {
    case "sessions":
      return querySessions(projectId, filters, limit);
    case "turns":
      return queryTurns(projectId, filters, limit);
    case "anomalies":
      return queryAnomalies(projectId, filters, limit);
    case "cost":
      return queryCost(projectId, filters, groupBy, limit);
    case "tools":
      return queryTools(projectId, filters, limit);
    case "risk":
      return queryRisk(projectId, filters, limit);
    case "compliance":
      return queryCompliance(projectId, filters, limit);
    case "provenance":
      // Mirror the iterable surface: empty result when artifactPath is
      // absent. The legacy HTTP route pre-validates and returns 400
      // before reaching the dispatcher, so this branch only runs for
      // direct (non-HTTP) callers that pass empty filters.
      if (typeof filters.artifactPath !== "string" || filters.artifactPath.length === 0) {
        return { rows: [], totalCount: 0 };
      }
      return queryProvenance(projectId, filters, limit);
    default:
      throw new Error(`Unknown queryType: ${queryType}`);
  }
}
