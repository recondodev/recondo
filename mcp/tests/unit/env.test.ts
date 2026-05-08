/**
 * D-C1-6 — loadEnvConfig refuses to start under unsafe configurations.
 *
 * Required env vars: DATABASE_URL, RECONDO_OBJECT_STORE_PATH.
 * Auth: must have RECONDO_API_KEY OR (RECONDO_DEV_BYPASS=1 AND NODE_ENV=development).
 *
 * loadEnvConfig accepts a plain object (not just process.env) so tests
 * can drive every branch without process-level mutation.
 */
import { describe, it, expect } from "vitest";

import { loadEnvConfig } from "../../src/config/env.js";

const minimalRequired = {
  DATABASE_URL: "postgres://localhost/recondo",
  RECONDO_OBJECT_STORE_PATH: "/tmp/recondo-objects",
};

describe("D-C1-6 loadEnvConfig", () => {
  it("throws when DATABASE_URL is missing", () => {
    expect(() =>
      loadEnvConfig({
        RECONDO_OBJECT_STORE_PATH: "/tmp/x",
        RECONDO_API_KEY: "wrt_test",
      }),
    ).toThrow(/DATABASE_URL/);
  });

  it("throws when RECONDO_OBJECT_STORE_PATH is missing", () => {
    expect(() =>
      loadEnvConfig({
        DATABASE_URL: "postgres://localhost/recondo",
        RECONDO_API_KEY: "wrt_test",
      }),
    ).toThrow(/RECONDO_OBJECT_STORE_PATH/);
  });

  it("throws when no API key, no dev bypass, NODE_ENV is production", () => {
    expect(() =>
      loadEnvConfig({
        ...minimalRequired,
        NODE_ENV: "production",
      }),
    ).toThrow(/RECONDO_API_KEY/);
  });

  it("throws when no API key, no dev bypass, NODE_ENV missing", () => {
    expect(() =>
      loadEnvConfig({
        ...minimalRequired,
      }),
    ).toThrow(/RECONDO_API_KEY/);
  });

  it("throws when RECONDO_DEV_BYPASS=1 but NODE_ENV is missing", () => {
    expect(() =>
      loadEnvConfig({
        ...minimalRequired,
        RECONDO_DEV_BYPASS: "1",
      }),
    ).toThrow(/RECONDO_API_KEY/);
  });

  it("returns config when NODE_ENV=development and dev bypass=1, no API key", () => {
    const cfg = loadEnvConfig({
      ...minimalRequired,
      NODE_ENV: "development",
      RECONDO_DEV_BYPASS: "1",
    });
    expect(cfg.databaseUrl).toBe("postgres://localhost/recondo");
    expect(cfg.objectStorePath).toBe("/tmp/recondo-objects");
    expect(cfg.devBypass).toBe(true);
    expect(cfg.nodeEnv).toBe("development");
  });

  it("refuses dev bypass when NODE_ENV is not development", () => {
    expect(() =>
      loadEnvConfig({
        ...minimalRequired,
        NODE_ENV: "production",
        RECONDO_DEV_BYPASS: "1",
      }),
    ).toThrow(/RECONDO_API_KEY/);
  });

  it("returns config when RECONDO_API_KEY is set", () => {
    const cfg = loadEnvConfig({
      ...minimalRequired,
      RECONDO_API_KEY: "wrt_real",
      NODE_ENV: "production",
    });
    expect(cfg.apiKey).toBe("wrt_real");
    expect(cfg.devBypass).toBe(false);
    expect(cfg.databaseUrl).toBe("postgres://localhost/recondo");
    expect(cfg.objectStorePath).toBe("/tmp/recondo-objects");
    expect(cfg.nodeEnv).toBe("production");
  });

  it("result shape includes the documented fields", () => {
    const cfg = loadEnvConfig({
      ...minimalRequired,
      RECONDO_API_KEY: "wrt_real",
      NODE_ENV: "development",
    });
    expect(cfg).toHaveProperty("databaseUrl");
    expect(cfg).toHaveProperty("objectStorePath");
    expect(cfg).toHaveProperty("devBypass");
    expect(cfg).toHaveProperty("nodeEnv");
    // apiKey is optional — when present it's a string.
    if ("apiKey" in cfg && cfg.apiKey !== undefined) {
      expect(typeof cfg.apiKey).toBe("string");
    }
  });
});
