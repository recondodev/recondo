/**
 * 32 KB response budget enforcement for recondo-mcp tools.
 *
 * - `enforceListBudget(items, offset, serialize)` — binary-searches the
 *   largest prefix whose serialised length fits in BUDGET_BYTES.
 * - `enforceSingleRecordBudget(record, serialize)` — returns a
 *   `response_too_large` envelope when a single record exceeds the
 *   budget, with a suggestion that mentions the field-scoping
 *   `recondo_get_turn_raw_metadata` escape hatch (per Plan D §C3).
 */

export const BUDGET_BYTES = 32 * 1024;

export interface ListBudgetResult<T> {
  items: T[];
  nextOffset: number | null;
  truncated: boolean;
}

/**
 * Find the largest k in [0, items.length] such that
 * serialize(items.slice(0, k)).length <= BUDGET_BYTES, via binary search.
 */
function largestFittingPrefix<T>(
  items: T[],
  serialize: (items: T[]) => string,
): number {
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = lo + Math.ceil((hi - lo) / 2);
    const len = serialize(items.slice(0, mid)).length;
    if (len <= BUDGET_BYTES) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return lo;
}

export function enforceListBudget<T>(
  items: T[],
  offset: number,
  serialize: (items: T[]) => string,
): ListBudgetResult<T> {
  const fullLen = serialize(items).length;
  if (fullLen <= BUDGET_BYTES) {
    return { items, nextOffset: null, truncated: false };
  }

  const k = largestFittingPrefix(items, serialize);
  return {
    items: items.slice(0, k),
    nextOffset: offset + k,
    truncated: true,
  };
}

export interface ResponseTooLargeEnvelope {
  response_too_large: true;
  suggestion: string;
  actual_bytes: number;
}

export function enforceSingleRecordBudget<T>(
  record: T,
  serialize: (record: T) => string,
): T | ResponseTooLargeEnvelope {
  const serialised = serialize(record);
  if (serialised.length <= BUDGET_BYTES) {
    return record;
  }
  return {
    response_too_large: true,
    suggestion:
      "Response exceeds the 32 KB budget. Narrow the request with `fields` " +
      "to project only the columns you need, or fall back to " +
      "`recondo_get_turn_raw_metadata` + `recondo_get_turn_raw_chunk` for " +
      "byte-level access.",
    actual_bytes: serialised.length,
  };
}
