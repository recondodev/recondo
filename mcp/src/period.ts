/**
 * Period translation between the MCP human-readable enum and the
 * `@recondo/data` cost-layer enum (`DAY_1` / `DAY_7` / `DAY_30` /
 * `DAY_90`).
 *
 * The MCP surface exposes day/week/month/quarter so the downstream
 * agent reads natural strings; the data layer accepts the `DAY_<n>`
 * tokens (see `packages/recondo-data/src/cost.ts:resolveDateRange`).
 * Tools translate at the boundary so neither side leaks the other's
 * vocabulary.
 */
export type McpPeriod = "day" | "week" | "month" | "quarter";

/**
 * Map an MCP-layer period to the `DAY_<n>` token consumed by the data
 * layer. Returns `undefined` when no period is supplied so the caller
 * can omit the field from the args bag.
 */
export function toDataLayerPeriod(period?: McpPeriod): string | undefined {
  switch (period) {
    case "day":
      return "DAY_1";
    case "week":
      return "DAY_7";
    case "month":
      return "DAY_30";
    case "quarter":
      return "DAY_90";
    default:
      return undefined;
  }
}
