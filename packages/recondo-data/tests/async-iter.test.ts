import { describe, it, expect } from "vitest";
import { rowsToAsyncIterable, abortableIterable } from "../src/async-iter.js";

describe("rowsToAsyncIterable", () => {
  it("yields each row in order", async () => {
    const out: number[] = [];
    for await (const r of rowsToAsyncIterable([1, 2, 3])) out.push(r);
    expect(out).toEqual([1, 2, 3]);
  });

  it("Array.fromAsync materializes back to array", async () => {
    const arr = await Array.fromAsync(rowsToAsyncIterable(["a", "b"]));
    expect(arr).toEqual(["a", "b"]);
  });

  it("yields zero items when input is empty", async () => {
    const arr = await Array.fromAsync(rowsToAsyncIterable<number>([]));
    expect(arr).toEqual([]);
  });
});

describe("abortableIterable", () => {
  it("throws AbortError immediately when signal is already aborted", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const it = abortableIterable(rowsToAsyncIterable([1, 2, 3, 4]), ctrl.signal);
    await expect(Array.fromAsync(it)).rejects.toThrow(/abort/i);
  });

  it("throws when signal aborts mid-iteration", async () => {
    const ctrl = new AbortController();
    const it = abortableIterable(rowsToAsyncIterable([1, 2, 3, 4]), ctrl.signal);
    const out: number[] = [];
    await expect(async () => {
      for await (const r of it) {
        out.push(r);
        if (r === 2) ctrl.abort();
      }
    }).rejects.toThrow(/abort/i);
    // Items received BEFORE the abort must be present.
    expect(out).toContain(1);
    expect(out).toContain(2);
    // Items AFTER the abort must NOT be present.
    expect(out).not.toContain(4);
  });

  it("passes through when signal never fires", async () => {
    const ctrl = new AbortController();
    const arr = await Array.fromAsync(
      abortableIterable(rowsToAsyncIterable([1, 2, 3]), ctrl.signal),
    );
    expect(arr).toEqual([1, 2, 3]);
  });

  it("passes through when signal is undefined", async () => {
    const arr = await Array.fromAsync(
      abortableIterable(rowsToAsyncIterable([10, 20]), undefined),
    );
    expect(arr).toEqual([10, 20]);
  });

  it("the AbortError name is 'AbortError'", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const it = abortableIterable(rowsToAsyncIterable([1]), ctrl.signal);
    try {
      await Array.fromAsync(it);
      expect.fail("expected to throw");
    } catch (err) {
      expect((err as Error).name).toBe("AbortError");
    }
  });
});
