/**
 * Adapt a synchronous iterable (e.g. `pg.QueryResult.rows`) into an
 * `AsyncIterable<T>` so the data layer can return uniform iterables
 * regardless of whether the underlying source is sync or async.
 */
export async function* rowsToAsyncIterable<T>(
  rows: Iterable<T>,
): AsyncIterable<T> {
  for (const row of rows) {
    yield row;
  }
}

/**
 * Wrap an `AsyncIterable<T>` so that an `AbortSignal` short-circuits
 * iteration with a `DOMException("aborted", "AbortError")`.
 *
 * Semantics:
 *   - signal undefined → passthrough.
 *   - signal already aborted at call time → throw before yielding
 *     anything.
 *   - signal fires during iteration → next iteration after the abort
 *     throws. Items yielded before the abort are observable to the
 *     consumer.
 */
export async function* abortableIterable<T>(
  inner: AsyncIterable<T>,
  signal?: AbortSignal,
): AsyncIterable<T> {
  if (!signal) {
    yield* inner;
    return;
  }
  if (signal.aborted) {
    throw new DOMException("aborted", "AbortError");
  }
  for await (const item of inner) {
    if (signal.aborted) {
      throw new DOMException("aborted", "AbortError");
    }
    yield item;
  }
}
