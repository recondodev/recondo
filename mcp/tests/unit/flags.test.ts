/**
 * D-C1-5 — parseFlags rejects --allow-destructive without --allow-actions.
 *
 * Final-state validation: parser collects all flags, THEN checks the
 * resulting state. Order doesn't matter — the only invariant is
 * `allowDestructive` requires `allowActions`. Unknown flags rejected.
 * Subcommand args (like `config claude-code`) flow through `remaining`
 * verbatim for the binary entrypoint to dispatch (C12).
 */
import { describe, it, expect } from "vitest";

import { parseFlags } from "../../src/config/flags.js";

describe("D-C1-5 parseFlags", () => {
  it("defaults: no flags → both gates false", () => {
    const result = parseFlags([]);
    expect(result.allowActions).toBe(false);
    expect(result.allowDestructive).toBe(false);
    expect(result.remaining).toEqual([]);
  });

  it("--allow-actions alone → actions true, destructive false", () => {
    const result = parseFlags(["--allow-actions"]);
    expect(result.allowActions).toBe(true);
    expect(result.allowDestructive).toBe(false);
  });

  it("--allow-actions --allow-destructive → both true", () => {
    const result = parseFlags(["--allow-actions", "--allow-destructive"]);
    expect(result.allowActions).toBe(true);
    expect(result.allowDestructive).toBe(true);
  });

  it("--allow-destructive WITHOUT --allow-actions throws synchronously", () => {
    expect(() => parseFlags(["--allow-destructive"])).toThrow(
      /--allow-actions/,
    );
  });

  it("flag order doesn't matter — final state is what's validated", () => {
    // --allow-destructive then --allow-actions: final state has both true,
    // so this MUST NOT throw. Implementer collects flags first, validates
    // resulting state.
    expect(() =>
      parseFlags(["--allow-destructive", "--allow-actions"]),
    ).not.toThrow();
    const result = parseFlags(["--allow-destructive", "--allow-actions"]);
    expect(result.allowActions).toBe(true);
    expect(result.allowDestructive).toBe(true);
  });

  it("rejects unknown flags", () => {
    expect(() => parseFlags(["--bogus"])).toThrow();
  });

  it("subcommand args flow through `remaining` verbatim", () => {
    // C12 will dispatch on these. C1 must surface them untouched.
    const result = parseFlags(["config", "claude-code"]);
    expect(result.remaining).toEqual(["config", "claude-code"]);
    expect(result.allowActions).toBe(false);
    expect(result.allowDestructive).toBe(false);
  });
});
