/**
 * Auth context resolution for recondo-mcp.
 *
 * Two paths:
 *   1. Dev-bypass — synthesises an admin context, never touches the DB.
 *   2. Real key — delegates to `authenticateApiKey` from `@recondo/data`.
 *      The wire-shape (id / projectId / rateLimitRpm) maps onto the
 *      AuthContext we expose to tools (keyId / projectId / isAdmin).
 *
 * Project-scoped keys (projectId !== null) are NOT admin. Admin keys
 * have `projectId === null`.
 */

import { authenticateApiKey } from "@recondo/data";

export interface AuthContext {
  kind: "dev-bypass" | "api-key";
  isAdmin: boolean;
  projectId: string | null;
  keyId: string;
}

export interface ResolveApiKeyArgs {
  devBypass?: boolean;
  apiKey?: string;
}

export async function resolveApiKey(args: ResolveApiKeyArgs): Promise<AuthContext> {
  if (args.devBypass) {
    return {
      kind: "dev-bypass",
      isAdmin: true,
      projectId: null,
      keyId: "dev-bypass",
    };
  }

  const result = await authenticateApiKey(args.apiKey ?? null);
  if (!result) {
    throw new Error("Invalid API key");
  }

  return {
    kind: "api-key",
    isAdmin: result.projectId === null,
    projectId: result.projectId,
    keyId: result.id,
  };
}
