import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("@recondo/data", () => ({
  getPool: vi.fn(),
  closePool: vi.fn(),
  listSessions: vi.fn(),
  getSession: vi.fn(),
  getTurn: vi.fn(),
  getTurnRawMetadata: vi.fn(),
  getTurnRawChunk: vi.fn(),
  searchTurns: vi.fn(),
  verifyIntegrity: vi.fn(),
  compareTurns: vi.fn(),
  findSimilarPrompts: vi.fn(),
  relatedTurns: vi.fn(),
  sessionEfficiency: vi.fn(),
  getRealtimeStats: vi.fn(),
  getGatewayStatus: vi.fn(),
  listRealtimeFeed: vi.fn(),
  getUsageSummary: vi.fn(),
  listSpendByProvider: vi.fn(),
  listSpendByModel: vi.fn(),
  listSpendByFramework: vi.fn(),
  listDailySpend: vi.fn(),
  getCostProjections: vi.fn(),
  getAgentSummary: vi.fn(),
  listAgentFrameworkDistribution: vi.fn(),
  listTopDevelopers: vi.fn(),
  listTopRepositories: vi.fn(),
  toolCallStats: vi.fn(),
  listAuditEvents: vi.fn(),
  listAnomalies: vi.fn(),
  getComplianceSummary: vi.fn(),
  listComplianceFrameworks: vi.fn(),
  listComplianceAuditLog: vi.fn(),
  listReports: vi.fn(),
  getReport: vi.fn(),
  listReportCoverageTrend: vi.fn(),
  listReportFindingsTrend: vi.fn(),
  getInsights: vi.fn(),
  listPolicies: vi.fn(),
  listPolicyTriggerHistory: vi.fn(),
  listApiKeys: vi.fn(),
  generateReport: vi.fn(),
  updateControlStatus: vi.fn(),
  createPolicy: vi.fn(),
  updatePolicy: vi.fn(),
  deletePolicy: vi.fn(),
  createApiKey: vi.fn(),
  revokeApiKey: vi.fn(),
  insertAuditLog: vi.fn(),
  authenticateApiKey: vi.fn(),
}));

import { ACTION_TOOLS, PROMPTS, READ_TOOLS } from "../../src/server.js";

interface PromptToolCall {
  tool: string;
  args: unknown;
}

function extractPromptToolCalls(body: string): PromptToolCall[] {
  const calls: PromptToolCall[] = [];
  const pattern =
    /tool:\s*`?(recondo_[a-z0-9_]+)`?\s*,\s*args:\s*(```json\s*([\s\S]*?)```|`({[\s\S]*?})`)/g;
  for (const match of body.matchAll(pattern)) {
    const tool = match[1];
    const json = (match[3] ?? match[4] ?? "").trim();
    calls.push({ tool, args: JSON.parse(json) });
  }
  return calls;
}

function validatePromptBody(body: string): PromptToolCall[] {
  const tools = new Map(
    [...READ_TOOLS, ...ACTION_TOOLS].map((tool) => [tool.name, tool]),
  );
  const calls = extractPromptToolCalls(body);
  if (calls.length === 0) {
    throw new Error("prompt contains no machine-validated tool call snippets");
  }
  for (const call of calls) {
    const tool = tools.get(call.tool);
    if (!tool) throw new Error(`unknown prompt tool reference: ${call.tool}`);
    tool.inputSchema.parse(call.args);
  }
  return calls;
}

describe("Group A prompt body tool-call validation", () => {
  it("rejects a deliberately broken prompt argument example", () => {
    expect(() =>
      validatePromptBody(
        'tool: `recondo_usage_summary`, args: `{"period":"last_7_days"}`',
      ),
    ).toThrow(z.ZodError);
  });

  it("every registered prompt cites only arguments accepted by the actual tool schemas", async () => {
    for (const prompt of PROMPTS) {
      const rendered = await prompt.render();
      const body = rendered.messages
        .map((message) => message.content.text)
        .join("\n");
      const calls = validatePromptBody(body);
      expect(calls.length, `${prompt.name} should cite at least one tool call`).toBeGreaterThan(0);
    }
  });
});
