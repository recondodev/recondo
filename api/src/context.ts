import type { Loaders } from "./loaders.js";

/**
 * Information about the authenticated API key, attached to every
 * GraphQL context after successful authentication.
 */
export interface ApiKeyInfo {
  id: string;
  projectId: string | null; // null = admin (cross-project access)
  rateLimitRpm: number;
}

/**
 * The GraphQL context passed to every resolver.
 */
export interface GqlContext {
  apiKey: ApiKeyInfo;
  sourceIp: string;
  userAgent: string;
  loaders: Loaders;
}
