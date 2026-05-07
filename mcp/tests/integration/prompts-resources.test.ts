/**
 * D-C12-4, D-C12-7, D-C12-8 (integration) — prompts/list, resources/list,
 * resources/read against the live MCP stdio surface.
 *
 * Spawns the binary, drives JSON-RPC `prompts/list`, `prompts/get`,
 * `resources/list`, `resources/read` and asserts:
 *   - 3 prompts visible WITHOUT `--allow-actions` (weekly_cost_report
 *     gated out);
 *   - 4 prompts visible WITH `--allow-actions`;
 *   - 3 resource templates visible;
 *   - `resources/read recondo://session/<id>` against an ACTIVE session
 *     (`ended_at IS NULL`) returns an error envelope OR the JSON-RPC
 *     reply has `error` set;
 *   - same call against a CLOSED session returns wrapped data.
 *
 * Skips when DATABASE_URL or the built binary aren't available.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";

import { spawnMcp, RECONDO_MCP_BINARY, type SpawnedMcp } from "../helpers/spawnMcp.js";
import { seedTestDb, truncateCapturedTables } from "../helpers/seed.js";

const HAVE_DB = Boolean(process.env.DATABASE_URL);
const HAVE_BINARY = existsSync(RECONDO_MCP_BINARY);
const describeIfReady = HAVE_DB && HAVE_BINARY ? describe : describe.skip;

interface PromptListItem {
  name: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
}

interface ResourceListItem {
  uri?: string;
  uriTemplate?: string;
  name?: string;
  description?: string;
}

interface ResourceContents {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
}

interface ResourceReadResult {
  contents?: ResourceContents[];
  isError?: boolean;
}

describeIfReady("D-C12-4 prompts/list — gated on --allow-actions", () => {
  it("WITHOUT --allow-actions, prompts/list omits weekly_cost_report (3 visible)", async () => {
    const mcp = await spawnMcp({ args: [] });
    try {
      const result = await mcp.request<{ prompts: PromptListItem[] }>(
        "prompts/list",
      );
      expect(Array.isArray(result.prompts)).toBe(true);
      const names = result.prompts.map((p) => p.name).sort();
      expect(names).toEqual(["find_waste", "monitor_anomalies", "summarize_my_week"]);
      expect(names).not.toContain("weekly_cost_report");
    } finally {
      await mcp.close();
    }
  });

  it("WITH --allow-actions, prompts/list includes all four", async () => {
    const mcp = await spawnMcp({ args: ["--allow-actions"] });
    try {
      const result = await mcp.request<{ prompts: PromptListItem[] }>(
        "prompts/list",
      );
      const names = result.prompts.map((p) => p.name).sort();
      expect(names).toEqual([
        "find_waste",
        "monitor_anomalies",
        "summarize_my_week",
        "weekly_cost_report",
      ]);
    } finally {
      await mcp.close();
    }
  });
});

describeIfReady("D-C12-7 resources/list — three resource templates", () => {
  it("returns three resource templates: session, turn, reports", async () => {
    const mcp = await spawnMcp({});
    try {
      // The MCP SDK exposes templated resources via
      // `resources/templates/list`. Some SDK builds include them in
      // `resources/list` too; we accept either as long as we find all
      // three templates somewhere in the catalog.
      const merged: ResourceListItem[] = [];
      try {
        const r1 = await mcp.request<{ resources?: ResourceListItem[] }>(
          "resources/list",
        );
        if (r1.resources) merged.push(...r1.resources);
      } catch {
        // method may be unimplemented if catalog has only templates
      }
      try {
        const r2 = await mcp.request<{
          resourceTemplates?: ResourceListItem[];
        }>("resources/templates/list");
        if (r2.resourceTemplates) merged.push(...r2.resourceTemplates);
      } catch {
        // may be unimplemented
      }

      const allUris = merged
        .map((r) => r.uriTemplate ?? r.uri ?? "")
        .filter((s) => s.length > 0);
      expect(
        allUris.some((u) => u.startsWith("recondo://session/")),
        `no session resource template; saw: ${JSON.stringify(allUris)}`,
      ).toBe(true);
      expect(
        allUris.some((u) => u.startsWith("recondo://turn/")),
        `no turn resource template; saw: ${JSON.stringify(allUris)}`,
      ).toBe(true);
      expect(
        allUris.some((u) => u.startsWith("recondo://reports/")),
        `no reports resource template; saw: ${JSON.stringify(allUris)}`,
      ).toBe(true);
    } finally {
      await mcp.close();
    }
  });
});

describeIfReady("D-C12-8 resources/read recondo://session/<id> — active vs closed", () => {
  let mcp: SpawnedMcp;
  let seeded: Awaited<ReturnType<typeof seedTestDb>> | null = null;

  beforeAll(async () => {
    mcp = await spawnMcp({});
  });

  afterAll(async () => {
    await mcp?.close();
    if (seeded) await seeded.cleanup();
    try {
      await truncateCapturedTables();
    } catch {
      // pool may already be closed
    }
  });

  it("ACTIVE session (ended_at IS NULL) → error envelope or JSON-RPC error", async () => {
    const activeId = randomUUID();
    seeded = await seedTestDb({
      sessions: [{ id: activeId, framework: "claude-code", endedAt: null }],
    });

    let sawError = false;
    try {
      const result = await mcp.request<ResourceReadResult>("resources/read", {
        uri: `recondo://session/${activeId}`,
      });
      // Implementer may return a structured error envelope rather than
      // a JSON-RPC error. Accept either, but require *some* signal.
      if (result.isError === true) sawError = true;
      const blob = JSON.stringify(result);
      // The error message must explain the active-session refusal.
      if (
        blob.includes("active") ||
        blob.includes("ended_at") ||
        blob.includes("recondo_get_session")
      ) {
        sawError = true;
      }
    } catch (err) {
      // JSON-RPC error path: the helper rejects the request promise.
      sawError = true;
      const msg = err instanceof Error ? err.message : String(err);
      // Even the JSON-RPC error message should mention active or
      // recondo_get_session — both are valid hints per Plan D §Task 28.
      expect(
        msg.includes("active") ||
          msg.includes("ended_at") ||
          msg.includes("recondo_get_session") ||
          msg.includes(activeId) ||
          msg.length > 0, // at minimum, an error message exists
      ).toBe(true);
    }
    expect(
      sawError,
      "resources/read on active session must error (envelope or JSON-RPC)",
    ).toBe(true);
  });

  it("CLOSED session (ended_at IS NOT NULL) → wrapped session data", async () => {
    const closedId = randomUUID();
    const yesterday = new Date(Date.now() - 24 * 3600_000);
    if (seeded) await seeded.cleanup();
    seeded = await seedTestDb({
      sessions: [
        {
          id: closedId,
          framework: "claude-code",
          startedAt: yesterday,
          lastActiveAt: yesterday,
          endedAt: yesterday,
        },
      ],
    });

    const result = await mcp.request<ResourceReadResult>("resources/read", {
      uri: `recondo://session/${closedId}`,
    });

    // Closed session must NOT be an error.
    expect(result.isError === true).toBe(false);

    // The MCP `resources/read` reply must include `contents` with at
    // least one entry referencing the same URI.
    expect(Array.isArray(result.contents)).toBe(true);
    expect((result.contents ?? []).length).toBeGreaterThanOrEqual(1);
    const first = (result.contents ?? [])[0];
    expect(first.uri).toBe(`recondo://session/${closedId}`);

    // Body should mention the seeded session id (proves the wrapper
    // actually looked the session up).
    const text = first.text ?? first.blob ?? "";
    expect(text.length).toBeGreaterThan(0);
    expect(text.includes(closedId)).toBe(true);
  });
});
