/**
 * Re-export resolvers from domain-split modules (D0.5).
 *
 * This file preserves backward compatibility for any code that imports
 * from "./resolvers.js". The actual resolver logic now lives in:
 *   - resolvers/sessions.ts
 *   - resolvers/turns.ts
 *   - resolvers/anomalies.ts
 *   - resolvers/mappers.ts
 */
export { resolvers } from "./resolvers/index.js";
