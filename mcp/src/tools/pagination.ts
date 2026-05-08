import { buildListEnvelope } from "../envelope/list.js";
import { enforceListBudget } from "../envelope/truncate.js";

export interface OffsetPage<T> {
  items: T[];
  hasMore: boolean;
}

export async function collectOffsetPage<TIn, TOut>(
  iterable: AsyncIterable<TIn>,
  options: {
    offset: number;
    limit: number;
    signal?: AbortSignal;
    project: (item: TIn) => TOut;
  },
): Promise<OffsetPage<TOut>> {
  const items: TOut[] = [];
  let skipped = 0;

  for await (const item of iterable) {
    if (options.signal?.aborted) {
      throw new DOMException("aborted", "AbortError");
    }
    if (skipped < options.offset) {
      skipped += 1;
      continue;
    }
    if (items.length >= options.limit) {
      return { items, hasMore: true };
    }
    items.push(options.project(item));
  }

  return { items, hasMore: false };
}

export function buildBudgetedOffsetEnvelope<T>(
  page: OffsetPage<T>,
  offset: number,
  serialize: (items: T[]) => string,
): unknown {
  const budget = enforceListBudget(page.items, offset, serialize);
  if (budget.truncated) {
    return buildListEnvelope({
      items: budget.items,
      nextOffset: budget.nextOffset,
      truncated: true,
    });
  }
  return buildListEnvelope({
    items: page.items,
    nextOffset: page.hasMore ? offset + page.items.length : null,
    truncated: page.hasMore,
  });
}
