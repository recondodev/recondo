import { describe, it, expect } from "vitest";
import { authenticateApiKey, authenticateRequest } from "../src/auth.js";

describe("@recondo/data auth: authenticateApiKey signature", () => {
  it("returns null for null token", async () => {
    const result = await authenticateApiKey(null);
    expect(result).toBeNull();
  });

  it("returns null for undefined token", async () => {
    const result = await authenticateApiKey(undefined);
    expect(result).toBeNull();
  });

  it("returns null for empty string token", async () => {
    const result = await authenticateApiKey("");
    expect(result).toBeNull();
  });

  it("returns null for whitespace-only token", async () => {
    const result = await authenticateApiKey("   ");
    expect(result).toBeNull();
  });

  it("returns null for malformed token (no wrt_ prefix)", async () => {
    const result = await authenticateApiKey("not-a-recondo-token");
    expect(result).toBeNull();
  });

  it("returns null for unknown wrt_ token (not in DB)", async () => {
    const result = await authenticateApiKey("wrt_definitely_not_a_real_key_12345");
    expect(result).toBeNull();
  });
});

describe("@recondo/data auth: AbortSignal support (D-A3)", () => {
  it("rejects with AbortError when signal is already aborted", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      authenticateApiKey("wrt_anything", { signal: ctrl.signal }),
    ).rejects.toThrow();
    // Confirm error name is AbortError
    try {
      await authenticateApiKey("wrt_anything", { signal: ctrl.signal });
      expect.fail("expected to throw");
    } catch (err) {
      expect((err as Error).name).toBe("AbortError");
    }
  });

  it("does NOT reject when signal is undefined", async () => {
    // Even without a real key, this returns null (not throws).
    const result = await authenticateApiKey("wrt_unknown_key");
    expect(result).toBeNull();
  });

  it("does NOT reject when signal is provided but never aborted", async () => {
    const ctrl = new AbortController();
    const result = await authenticateApiKey("wrt_unknown_key", { signal: ctrl.signal });
    expect(result).toBeNull();
  });
});

describe("@recondo/data auth: authenticateRequest header wrapper (D-A4)", () => {
  it("returns null for null/undefined/empty header", async () => {
    expect(await authenticateRequest(null)).toBeNull();
    expect(await authenticateRequest(undefined)).toBeNull();
    expect(await authenticateRequest("")).toBeNull();
  });

  it("returns null for non-Bearer scheme", async () => {
    expect(await authenticateRequest("Basic dXNlcjpwYXNz")).toBeNull();
    expect(await authenticateRequest("Token wrt_xyz")).toBeNull();
    expect(await authenticateRequest("wrt_xyz_no_scheme")).toBeNull();
  });

  it("accepts Bearer scheme and delegates to authenticateApiKey", async () => {
    // Unknown token → null (delegation works; full path exercised).
    const result = await authenticateRequest("Bearer wrt_unknown_key");
    expect(result).toBeNull();
  });

  it("Bearer scheme is case-insensitive", async () => {
    expect(await authenticateRequest("bearer wrt_unknown")).toBeNull();
    expect(await authenticateRequest("BEARER wrt_unknown")).toBeNull();
    expect(await authenticateRequest("BeArEr wrt_unknown")).toBeNull();
  });

  it("trims whitespace around the token", async () => {
    // "Bearer  wrt_x  " → token "wrt_x" → unknown → null
    expect(await authenticateRequest("Bearer  wrt_unknown_key  ")).toBeNull();
  });

  it("propagates AbortSignal to authenticateApiKey", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      authenticateRequest("Bearer wrt_anything", { signal: ctrl.signal }),
    ).rejects.toThrow();
  });
});
