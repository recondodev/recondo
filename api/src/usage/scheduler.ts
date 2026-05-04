/**
 * Sprint 6 Deliverable 3: Materialized View Refresh Scheduler
 *
 * Background job to refresh materialized views on configurable intervals.
 * Uses REFRESH MATERIALIZED VIEW CONCURRENTLY (requires unique index).
 * Does NOT block the immutable capture write pipeline.
 */

import { getPool } from "../db.js";

interface ViewSchedule {
  viewName: string;
  intervalMs: number;
}

// BLOCKER-2 fix: Allow-list of valid materialized view names to prevent SQL injection.
// Only these view names may be interpolated into SQL statements.
const ALLOWED_VIEWS = new Set([
  "mv_usage_hourly",
  "mv_usage_daily",
  "mv_usage_weekly",
  "mv_usage_monthly",
  "mv_tool_usage",
]);

const DEFAULT_SCHEDULES: ViewSchedule[] = [
  { viewName: "mv_usage_hourly", intervalMs: 60 * 60 * 1000 },       // every hour
  { viewName: "mv_usage_daily", intervalMs: 6 * 60 * 60 * 1000 },    // every 6 hours
  { viewName: "mv_usage_weekly", intervalMs: 24 * 60 * 60 * 1000 },   // daily
  { viewName: "mv_usage_monthly", intervalMs: 24 * 60 * 60 * 1000 },  // daily
  { viewName: "mv_tool_usage", intervalMs: 6 * 60 * 60 * 1000 },     // every 6 hours
];

const timers: ReturnType<typeof setInterval>[] = [];

/**
 * Start the materialized view refresh scheduler.
 * Each view is refreshed on its own interval using REFRESH MATERIALIZED VIEW CONCURRENTLY.
 */
export function startViewRefreshScheduler(
  schedules: ViewSchedule[] = DEFAULT_SCHEDULES
): void {
  for (const schedule of schedules) {
    // BLOCKER-2 fix: Validate viewName against allow-list before SQL interpolation
    if (!ALLOWED_VIEWS.has(schedule.viewName)) {
      throw new Error(`Invalid view name: ${schedule.viewName}. Must be one of: ${[...ALLOWED_VIEWS].join(", ")}`);
    }

    const timer = setInterval(async () => {
      try {
        const pool = getPool();
        await pool.query(`REFRESH MATERIALIZED VIEW CONCURRENTLY ${schedule.viewName}`);
      } catch (err) {
        // Non-fatal: log and continue
        console.error(`Failed to refresh ${schedule.viewName}:`, err);
      }
    }, schedule.intervalMs);

    // Don't block Node.js shutdown
    timer.unref();
    timers.push(timer);
  }
}

/**
 * Stop all refresh schedulers (for graceful shutdown and testing).
 */
export function stopViewRefreshScheduler(): void {
  for (const timer of timers) {
    clearInterval(timer);
  }
  timers.length = 0;
}
