/**
 * D-RM-OR1 — `resolveObjectsRoot()` priority.
 *
 *   1. RECONDO_OBJECT_STORE_PATH wins when set.
 *   2. RECONDO_DATA_DIR + "/objects" when only that is set.
 *   3. <home>/.recondo/objects as the last-resort fallback.
 *
 * The MCP layer surfaces `RECONDO_OBJECT_STORE_PATH`; the gateway uses
 * `RECONDO_DATA_DIR`. Same data layer, two deployment modes.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";

import { resolveObjectsRoot } from "../../src/turns-raw.js";

const SAVED: { obj?: string; dat?: string } = {};

beforeEach(() => {
  SAVED.obj = process.env.RECONDO_OBJECT_STORE_PATH;
  SAVED.dat = process.env.RECONDO_DATA_DIR;
  delete process.env.RECONDO_OBJECT_STORE_PATH;
  delete process.env.RECONDO_DATA_DIR;
});

afterEach(() => {
  if (SAVED.obj === undefined) delete process.env.RECONDO_OBJECT_STORE_PATH;
  else process.env.RECONDO_OBJECT_STORE_PATH = SAVED.obj;
  if (SAVED.dat === undefined) delete process.env.RECONDO_DATA_DIR;
  else process.env.RECONDO_DATA_DIR = SAVED.dat;
});

describe("resolveObjectsRoot", () => {
  it("returns RECONDO_OBJECT_STORE_PATH verbatim when set", () => {
    process.env.RECONDO_OBJECT_STORE_PATH = "/tmp/explicit-objects";
    expect(resolveObjectsRoot()).toBe("/tmp/explicit-objects");
  });

  it("RECONDO_OBJECT_STORE_PATH wins over RECONDO_DATA_DIR", () => {
    process.env.RECONDO_OBJECT_STORE_PATH = "/tmp/explicit-objects";
    process.env.RECONDO_DATA_DIR = "/tmp/data";
    expect(resolveObjectsRoot()).toBe("/tmp/explicit-objects");
  });

  it("falls back to RECONDO_DATA_DIR + /objects when only that is set", () => {
    process.env.RECONDO_DATA_DIR = "/tmp/data";
    expect(resolveObjectsRoot()).toBe(join("/tmp/data", "objects"));
  });

  it("falls back to <home>/.recondo/objects when neither env var is set", () => {
    expect(resolveObjectsRoot()).toBe(join(homedir(), ".recondo", "objects"));
  });
});
