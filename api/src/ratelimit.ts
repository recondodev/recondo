/**
 * In-memory sliding window rate limiter.
 * Tracks per-API-key request timestamps in a 60-second window.
 */

interface WindowEntry {
  timestamps: number[];
}

const windows = new Map<string, WindowEntry>();

// W6: Track call count for periodic cleanup
let callCount = 0;
const CLEANUP_INTERVAL = 100; // Run cleanup every 100 calls

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetEpochSeconds: number;
}

/**
 * Check (and consume) a rate limit token for the given API key.
 *
 * @param keyId   The API key's UUID
 * @param limitRpm  The key's rate_limit_rpm value
 * @returns RateLimitResult with allowed, limit, remaining, reset
 */
export function checkRateLimit(keyId: string, limitRpm: number): RateLimitResult {
  // W9: Defensive check — if limitRpm is null/undefined/NaN/0, deny the request
  if (!limitRpm || !Number.isFinite(limitRpm) || limitRpm <= 0) {
    return {
      allowed: false,
      limit: 0,
      remaining: 0,
      resetEpochSeconds: Math.ceil((Date.now() + 60_000) / 1000),
    };
  }

  const now = Date.now();
  const windowMs = 60_000; // 1 minute sliding window
  const windowStart = now - windowMs;

  let entry = windows.get(keyId);
  if (!entry) {
    entry = { timestamps: [] };
    windows.set(keyId, entry);
  }

  // Evict timestamps outside the window
  entry.timestamps = entry.timestamps.filter((ts) => ts > windowStart);

  const resetEpochSeconds = Math.ceil((now + windowMs) / 1000);

  if (entry.timestamps.length >= limitRpm) {
    // W6: Periodic cleanup
    periodicCleanup();
    return {
      allowed: false,
      limit: limitRpm,
      remaining: 0,
      resetEpochSeconds,
    };
  }

  // Consume a token
  entry.timestamps.push(now);

  // W6: Periodic cleanup
  periodicCleanup();

  return {
    allowed: true,
    limit: limitRpm,
    remaining: limitRpm - entry.timestamps.length,
    resetEpochSeconds,
  };
}

/**
 * W6: Periodic cleanup — removes entries with empty timestamp arrays.
 * Runs every CLEANUP_INTERVAL calls to prevent unbounded Map growth.
 */
function periodicCleanup(): void {
  callCount++;
  if (callCount % CLEANUP_INTERVAL !== 0) return;

  const now = Date.now();
  const windowMs = 60_000;
  const windowStart = now - windowMs;

  for (const [key, entry] of windows) {
    // Evict old timestamps
    entry.timestamps = entry.timestamps.filter((ts) => ts > windowStart);
    // Remove entry if empty
    if (entry.timestamps.length === 0) {
      windows.delete(key);
    }
  }
}

/**
 * Reset all rate limit state. Useful for testing.
 */
export function resetRateLimits(): void {
  windows.clear();
  callCount = 0;
}
