/**
 * Sprint 6: Shared utilities for usage module.
 *
 * W3+W4 fix: VALID_PERIODS and dateTruncExpr were duplicated in dashboard.ts
 * and cost-allocation.ts. Consolidated here as the single source of truth.
 */

/** Valid period values for usage aggregation endpoints. */
export const VALID_PERIODS = new Set(["daily", "weekly", "monthly"]);

/** Date format regex for from/to date parameter validation (W6). */
export const DATE_FORMAT_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Return a SQL DATE_TRUNC expression for the given period.
 * Assumes the table alias is `t` with a `timestamp` column of type TEXT.
 */
export function dateTruncExpr(period: string): string {
  switch (period) {
    case "weekly": return "DATE_TRUNC('week', t.timestamp::TIMESTAMPTZ)";
    case "monthly": return "DATE_TRUNC('month', t.timestamp::TIMESTAMPTZ)";
    default: return "DATE_TRUNC('day', t.timestamp::TIMESTAMPTZ)";
  }
}
