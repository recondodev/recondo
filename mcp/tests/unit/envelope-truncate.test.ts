/**
 * D-C1-12 — enforceListBudget binary-searches the largest prefix that
 * fits 32 KB; enforceSingleRecordBudget returns response_too_large
 * envelope when over budget.
 */
import { describe, it, expect } from "vitest";

import {
  enforceListBudget,
  enforceSingleRecordBudget,
} from "../../src/envelope/truncate.js";

const BUDGET = 32_768;

describe("D-C1-12 enforceListBudget", () => {
  it("returns all items when under budget", () => {
    const items = [{ a: 1 }, { b: 2 }, { c: 3 }];
    const out = enforceListBudget(items, 0, JSON.stringify);
    expect(out.items).toEqual(items);
    expect(out.nextOffset).toBeNull();
    expect(out.truncated).toBe(false);
  });

  it("truncates when items exceed 32 KB and reports next_offset", () => {
    // Make ~2KB items × 30 = ~60 KB → must truncate.
    const big = "x".repeat(2000);
    const items = Array.from({ length: 30 }, (_, i) => ({ id: i, big }));
    const out = enforceListBudget(items, 0, JSON.stringify);
    expect(out.truncated).toBe(true);
    expect(out.items.length).toBeLessThan(items.length);
    expect(JSON.stringify(out.items).length).toBeLessThanOrEqual(BUDGET);
    expect(typeof out.nextOffset).toBe("number");
    expect(out.nextOffset).toBe(out.items.length);
  });

  it("binary-search property — adding the next item would exceed budget", () => {
    const big = "x".repeat(1500);
    const items = Array.from({ length: 50 }, (_, i) => ({ id: i, big }));
    const out = enforceListBudget(items, 0, JSON.stringify);
    expect(out.truncated).toBe(true);
    expect(out.items.length).toBeLessThan(items.length);
    const nextItem = items[out.items.length];
    expect(nextItem).toBeDefined();
    const withNext = JSON.stringify([...out.items, nextItem]);
    expect(withNext.length).toBeGreaterThan(BUDGET);
  });

  it("propagates offset into nextOffset (offset arithmetic)", () => {
    const big = "x".repeat(2000);
    const items = Array.from({ length: 30 }, (_, i) => ({ id: i, big }));
    const out = enforceListBudget(items, 100, JSON.stringify);
    expect(out.truncated).toBe(true);
    // nextOffset must be the absolute offset for the next page, NOT
    // just the kept-count.
    expect(out.nextOffset).toBe(100 + out.items.length);
  });
});

describe("D-C1-12 enforceSingleRecordBudget", () => {
  it("returns the record verbatim when under 32 KB", () => {
    const record = { id: "abc", payload: "ok" };
    const out = enforceSingleRecordBudget(record, JSON.stringify);
    expect(out).toEqual(record);
  });

  it("returns response_too_large envelope with non-empty suggestion when over", () => {
    const record = { id: "abc", payload: "y".repeat(40_000) };
    const out: unknown = enforceSingleRecordBudget(record, JSON.stringify);
    expect(out).toMatchObject({ response_too_large: true });
    const obj = out as { suggestion: unknown };
    expect(typeof obj.suggestion).toBe("string");
    expect((obj.suggestion as string).length).toBeGreaterThan(0);
  });
});
