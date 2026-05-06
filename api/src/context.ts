import type { ApiKeyInfo } from "@recondo/data";
import type { Loaders } from "./loaders.js";

// Re-export so existing consumers continue to work.
export type { ApiKeyInfo };

/**
 * The GraphQL context passed to every resolver.
 */
export interface GqlContext {
  apiKey: ApiKeyInfo;
  sourceIp: string;
  userAgent: string;
  loaders: Loaders;
}
