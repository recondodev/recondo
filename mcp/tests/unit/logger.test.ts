/**
 * D-C1-4 — Logger writes to stderr only.
 *
 * The long-running service must not write normal logs to stdout. This
 * test spies on process.stdout.write and asserts ZERO calls when invoking
 * logger.{info,warn,error}; each call also produces structured JSON on
 * stderr that includes the supplied fields.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Production module under test (does not yet exist; import fails until C1
// implementer ships mcp/src/util/logger.ts).
import { logger } from "../../src/util/logger.js";

describe("D-C1-4 logger writes to stderr only", () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let stderrLines: string[];

  beforeEach(() => {
    stderrLines = [];
    stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        stderrLines.push(
          typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"),
        );
        return true;
      });
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it("logger.info writes to stderr, never stdout", () => {
    logger.info({ foo: "bar" }, "hello");
    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(stderrSpy).toHaveBeenCalled();
  });

  it("logger.warn writes to stderr, never stdout", () => {
    logger.warn({ a: 1 }, "warned");
    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(stderrSpy).toHaveBeenCalled();
  });

  it("logger.error writes to stderr, never stdout", () => {
    logger.error({ err: "boom" }, "explosion");
    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(stderrSpy).toHaveBeenCalled();
  });

  it("each stderr line is parseable JSON containing level + msg + fields", () => {
    logger.info({ traceId: "abc", count: 3 }, "msg-1");
    logger.warn({ traceId: "abc" }, "msg-2");
    logger.error({ err: "x" }, "msg-3");

    expect(stderrLines.length).toBeGreaterThanOrEqual(3);
    const joined = stderrLines.join("");
    const lines = joined
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    expect(lines.length).toBeGreaterThanOrEqual(3);

    const first = JSON.parse(lines[0]);
    expect(first).toHaveProperty("level");
    expect(first).toHaveProperty("msg");
    expect(first.msg).toBe("msg-1");
    expect(first.traceId).toBe("abc");
    expect(first.count).toBe(3);

    const second = JSON.parse(lines[1]);
    expect(second.msg).toBe("msg-2");

    const third = JSON.parse(lines[2]);
    expect(third.msg).toBe("msg-3");
    expect(third.err).toBe("x");
  });
});
