/**
 * Shared format helpers used across dashboard pages.
 */

export function formatTokens(tokens: number): string {
  return tokens.toLocaleString();
}

export function formatCost(cost: number): string {
  return `$${cost.toFixed(2)}`;
}

/** Format large cost values with commas (e.g. $4,218.00). */
export function formatLargeCost(cost: number): string {
  if (cost === 0) return "$0";
  return "$" + cost.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function formatDuration(seconds: number | null): string {
  if (seconds === null) return "--";
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (mins === 0) return `${secs}s`;
  return `${mins}m ${secs}s`;
}

export function formatLatency(ms: number | null): string {
  if (ms === null) return "--";
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}

export function truncateId(id: string): string {
  if (id.length <= 10) return id;
  return `${id.slice(0, 6)}...${id.slice(-4)}`;
}
