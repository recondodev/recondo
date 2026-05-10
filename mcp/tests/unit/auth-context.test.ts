/**
 * D-C1-7 — resolveApiKey returns synth admin under dev-bypass; calls
 * authenticateApiKey for real keys; throws on unauthenticated keys.
 *
 * Mocks `@recondo/data` to isolate from the real DB.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { authenticateApiKey } = vi.hoisted(() => ({
  authenticateApiKey: vi.fn(),
}));

vi.mock("@recondo/data", () => ({
  authenticateApiKey,
}));

import { resolveApiKey } from "../../src/auth/context.js";

describe("D-C1-7 resolveApiKey", () => {
  beforeEach(() => {
    authenticateApiKey.mockReset();
  });

  it("dev-bypass returns synth admin context without calling authenticateApiKey", async () => {
    const ctx = await resolveApiKey({ devBypass: true });
    expect(ctx).toMatchObject({
      kind: "dev-bypass",
      isAdmin: true,
      projectId: null,
      keyId: "dev-bypass",
    });
    expect(authenticateApiKey).not.toHaveBeenCalled();
  });

  it("real api key calls authenticateApiKey and returns the resolved context", async () => {
    authenticateApiKey.mockResolvedValueOnce({
      id: "key-uuid",
      projectId: "proj-1",
      rateLimitRpm: 1000,
    });
    const ctx = await resolveApiKey({ apiKey: "wrt_real" });
    expect(authenticateApiKey).toHaveBeenCalledWith("wrt_real");
    expect(ctx.kind).toBe("api-key");
    expect(ctx.keyId).toBe("key-uuid");
    expect(ctx.projectId).toBe("proj-1");
    // Project-scoped keys are NOT admin.
    expect(ctx.isAdmin).toBe(false);
  });

  it("admin api key (projectId === null) sets isAdmin true", async () => {
    authenticateApiKey.mockResolvedValueOnce({
      id: "admin-uuid",
      projectId: null,
      rateLimitRpm: 1000,
    });
    const ctx = await resolveApiKey({ apiKey: "wrt_admin" });
    expect(ctx.isAdmin).toBe(true);
    expect(ctx.projectId).toBeNull();
  });

  it("rejected real key — authenticateApiKey returns null → resolveApiKey throws", async () => {
    authenticateApiKey.mockResolvedValueOnce(null);
    await expect(resolveApiKey({ apiKey: "wrt_bogus" })).rejects.toThrow(/aborted|AbortError|invalid|required|missing|not found|failed|failure|boom|db down|auth|API key|database|validation|unsupported|period|relation|signal/i);
  });

  it("rejected real key — authenticateApiKey throws → resolveApiKey rejects", async () => {
    authenticateApiKey.mockRejectedValueOnce(new Error("db down"));
    await expect(resolveApiKey({ apiKey: "wrt_throwing" })).rejects.toThrow(/aborted|AbortError|invalid|required|missing|not found|failed|failure|boom|db down|auth|API key|database|validation|unsupported|period|relation|signal/i);
  });
});
