/**
 * Environment-variable validation for `recondo-mcp`.
 *
 * Required: DATABASE_URL, RECONDO_OBJECT_STORE_PATH.
 * Auth: must have RECONDO_API_KEY OR (RECONDO_DEV_BYPASS=1 AND
 * NODE_ENV=development).
 *
 * Accepts a plain object (not just process.env) so tests can drive
 * every branch without process-level mutation.
 */

export interface EnvConfig {
  databaseUrl: string;
  objectStorePath: string;
  apiKey?: string;
  devBypass: boolean;
  nodeEnv: string;
}

export function loadEnvConfig(env: Record<string, string | undefined>): EnvConfig {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  const objectStorePath = env.RECONDO_OBJECT_STORE_PATH;
  if (!objectStorePath) {
    throw new Error("RECONDO_OBJECT_STORE_PATH is required");
  }

  const apiKey = env.RECONDO_API_KEY;
  const devBypass = env.RECONDO_DEV_BYPASS === "1";
  const nodeEnv = env.NODE_ENV ?? "development";

  // Auth gate: dev-bypass is only honored when NODE_ENV=development.
  // Outside development, an API key is mandatory.
  const allowDevBypass = devBypass && nodeEnv === "development";
  if (!apiKey && !allowDevBypass) {
    throw new Error(
      "RECONDO_API_KEY is required (or set RECONDO_DEV_BYPASS=1 with NODE_ENV=development)",
    );
  }

  const cfg: EnvConfig = {
    databaseUrl,
    objectStorePath,
    devBypass: allowDevBypass,
    nodeEnv,
  };
  if (apiKey !== undefined) {
    cfg.apiKey = apiKey;
  }
  return cfg;
}
