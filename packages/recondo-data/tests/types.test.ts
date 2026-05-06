import { describe, it, expect } from "vitest";
import type { ApiKeyInfo, ListEnvelope, SinceCursor, QueryOptions, ListOptions } from "../src/types.js";
import { DataValidationError } from "../src/types.js";

describe("@recondo/data: types module", () => {
  it("exports DataValidationError as a named class", () => {
    const err = new DataValidationError("bad input");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("DataValidationError");
    expect(err.message).toBe("bad input");
    expect(err.code).toBe("BAD_USER_INPUT");
  });

  it("DataValidationError accepts a custom code", () => {
    const err = new DataValidationError("limit too high", "LIMIT_EXCEEDED");
    expect(err.code).toBe("LIMIT_EXCEEDED");
  });

  it("DataValidationError is throw-and-catchable", () => {
    expect(() => {
      throw new DataValidationError("test");
    }).toThrow(DataValidationError);
  });

  it("ApiKeyInfo type allows null projectId (admin)", () => {
    const adminKey: ApiKeyInfo = { id: "k", projectId: null, rateLimitRpm: 1000 };
    expect(adminKey.projectId).toBeNull();
  });

  it("ApiKeyInfo type allows scoped projectId", () => {
    const scopedKey: ApiKeyInfo = { id: "k2", projectId: "p_abc", rateLimitRpm: 500 };
    expect(scopedKey.projectId).toBe("p_abc");
  });

  it("ListEnvelope shape: stream_id null, is_final true literal", () => {
    const env: ListEnvelope<number> = {
      items: [1],
      next_offset: 1,
      truncated: false,
      stream_id: null,
      is_final: true,
    };
    expect(env.stream_id).toBeNull();
    expect(env.is_final).toBe(true);
  });
});
