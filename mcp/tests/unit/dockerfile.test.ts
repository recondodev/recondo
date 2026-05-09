import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("Dockerfile.mcp", () => {
  it("binds the containerized MCP service to all interfaces by default", () => {
    const dockerfile = readFileSync(
      new URL("../../../Dockerfile.mcp", import.meta.url),
      "utf8",
    );

    expect(dockerfile).toMatch(/\bENV\s+RECONDO_MCP_HOST=0\.0\.0\.0\b/);
  });
});
