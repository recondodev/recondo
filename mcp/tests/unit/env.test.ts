/**
 * D-C1-6 — loadEnvConfig refuses to start under unsafe configurations.
 *
 * Required env vars: DATABASE_URL and either a local object-store path
 * (`RECONDO_OBJECT_STORE_PATH`) or S3 object-store configuration.
 * Auth: optional service-level RECONDO_API_KEY OR local
 * RECONDO_DEV_BYPASS=1 with NODE_ENV=development. Remote clients may
 * authenticate per request with Authorization: Bearer.
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

  it("throws when RECONDO_OBJECT_STORE_PATH is missing for the local object store", () => {
    expect(() =>
      loadEnvConfig({
        DATABASE_URL: "postgres://localhost/recondo",
        RECONDO_API_KEY: "wrt_test",
      }),
    ).toThrow(/RECONDO_OBJECT_STORE_PATH/);
  });

  it("allows S3 object store config without RECONDO_OBJECT_STORE_PATH", () => {
    const cfg = loadEnvConfig({
      DATABASE_URL: "postgres://localhost/recondo",
      RECONDO_OBJECTS: "s3",
      RECONDO_S3_BUCKET: "recondo-objects-dev",
      NODE_ENV: "development",
      RECONDO_DEV_BYPASS: "1",
    });
    expect(cfg.databaseUrl).toBe("postgres://localhost/recondo");
    expect(cfg.objectStorePath).toBeUndefined();
  });

  it("allows explicit local object store config", () => {
    const cfg = loadEnvConfig({
      ...minimalRequired,
      RECONDO_OBJECTS: "local",
    });
    expect(cfg.objectDriver).toBe("local");
    expect(cfg.objectStorePath).toBe("/tmp/recondo-objects");
  });

  it("rejects unknown object store drivers during env loading", () => {
    expect(() =>
      loadEnvConfig({
        ...minimalRequired,
        RECONDO_OBJECTS: "ministack",
      }),
    ).toThrow(/RECONDO_OBJECTS/);
    expect(() =>
      loadEnvConfig({
        ...minimalRequired,
        RECONDO_OBJECTS: "",
      }),
    ).toThrow(/RECONDO_OBJECTS/);
  });

  it("throws when RECONDO_OBJECTS=s3 but RECONDO_S3_BUCKET is missing", () => {
    expect(() =>
      loadEnvConfig({
        DATABASE_URL: "postgres://localhost/recondo",
        RECONDO_OBJECTS: "s3",
        RECONDO_API_KEY: "wrt_test",
      }),
    ).toThrow(/RECONDO_S3_BUCKET/);
  });

  it("allows production startup without a service-level API key", () => {
    const cfg = loadEnvConfig({
      ...minimalRequired,
      NODE_ENV: "production",
    });
    expect(cfg.apiKey).toBeUndefined();
    expect(cfg.devBypass).toBe(false);
  });

  it("allows startup without API key or dev bypass when NODE_ENV is missing", () => {
    const cfg = loadEnvConfig({
      ...minimalRequired,
    });
    expect(cfg.apiKey).toBeUndefined();
    expect(cfg.devBypass).toBe(false);
  });

  it("ignores RECONDO_DEV_BYPASS=1 when NODE_ENV is missing", () => {
    const cfg = loadEnvConfig({
      ...minimalRequired,
      RECONDO_DEV_BYPASS: "1",
    });
    expect(cfg.devBypass).toBe(false);
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

  it("ignores dev bypass when NODE_ENV is not development", () => {
    const cfg = loadEnvConfig({
      ...minimalRequired,
      NODE_ENV: "production",
      RECONDO_DEV_BYPASS: "1",
    });
    expect(cfg.devBypass).toBe(false);
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
