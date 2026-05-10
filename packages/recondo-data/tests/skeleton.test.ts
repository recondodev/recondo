import { describe, it, expect } from "vitest";

describe("@recondo/data: package skeleton", () => {
  it("exposes a barrel that imports without throwing", async () => {
    // The barrel is empty in C1 — just an `export {};`. This test passes
    // once the package compiles and is linkable from its own tests.
    const data = await import("../src/index.js");
    expect(data).toBeDefined();
  });
});
