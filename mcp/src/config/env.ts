/**
 * Environment-variable validation for `recondo-mcp`.
 *
 * Required: DATABASE_URL and either local object-store path
 * (RECONDO_OBJECT_STORE_PATH) or S3 bucket (RECONDO_OBJECTS=s3 +
 * RECONDO_S3_BUCKET).
 * Auth: remote clients provide Authorization: Bearer on HTTP requests.
 * RECONDO_DEV_BYPASS=1 with NODE_ENV=development is the only headerless
 * auth path. RECONDO_API_KEY remains available to config helpers that
 * need an operator key, but it is not a headerless HTTP credential.
 *
 * Accepts a plain object (not just process.env) so tests can drive
 * every branch without process-level mutation.
 */

export interface EnvConfig {
  databaseUrl: string;
  objectStorePath?: string;
  objectDriver: "local" | "s3";
  s3Bucket?: string;
  apiKey?: string;
  devBypass: boolean;
  nodeEnv: string;
}

export function loadEnvConfig(env: Record<string, string | undefined>): EnvConfig {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  const objectDriverRaw = env.RECONDO_OBJECTS;
  let objectDriver: EnvConfig["objectDriver"];
  if (objectDriverRaw === undefined || objectDriverRaw === "local") {
    objectDriver = "local";
  } else if (objectDriverRaw === "s3") {
    objectDriver = "s3";
  } else {
    throw new Error("RECONDO_OBJECTS must be unset, local, or s3");
  }
  const objectStorePath = env.RECONDO_OBJECT_STORE_PATH;
  const s3Bucket = env.RECONDO_S3_BUCKET;
  if (objectDriver === "s3") {
    if (!s3Bucket) {
      throw new Error("RECONDO_S3_BUCKET is required when RECONDO_OBJECTS=s3");
    }
  } else if (!objectStorePath) {
    throw new Error("RECONDO_OBJECT_STORE_PATH is required for the local object store");
  }

  const apiKey = env.RECONDO_API_KEY;
  const devBypass = env.RECONDO_DEV_BYPASS === "1";
  const nodeEnv = env.NODE_ENV ?? "production";

  // Dev-bypass is only honored when NODE_ENV=development. Production
  // services may still boot without a service-level API key because
  // remote clients can authenticate per HTTP request.
  const allowDevBypass = devBypass && nodeEnv === "development";

  const cfg: EnvConfig = {
    databaseUrl,
    objectDriver,
    devBypass: allowDevBypass,
    nodeEnv,
  };
  if (objectStorePath !== undefined) {
    cfg.objectStorePath = objectStorePath;
  }
  if (s3Bucket !== undefined) {
    cfg.s3Bucket = s3Bucket;
  }
  if (apiKey !== undefined) {
    cfg.apiKey = apiKey;
  }
  return cfg;
}
