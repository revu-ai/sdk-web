/**
 * @file Unit tests for DOM-independent core pieces (run under `bun test`).
 * DOM-based capture/transport tests will use happy-dom (added later).
 */

import { describe, expect, test } from "bun:test";
import { resolveConfig } from "../src/config.js";
import { safe, truncate, uuid } from "../src/utils.js";

describe("config", () => {
  test("applies defaults over a minimal config", () => {
    const c = resolveConfig({ apiKey: "k" });
    expect(c.apiKey).toBe("k");
    expect(c.autocapture).toBe(true);
    expect(c.host).toContain("revu.ai");
  });

  test("throws without an apiKey", () => {
    // @ts-expect-error - intentionally invalid
    expect(() => resolveConfig({})).toThrow();
  });
});

describe("utils", () => {
  test("uuid is unique and well-formed", () => {
    const a = uuid();
    const b = uuid();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f-]{36}$/i);
  });

  test("safe() never throws and swallows errors", () => {
    let caught = false;
    const fn = safe(
      () => {
        throw new Error("boom");
      },
      () => (caught = true),
    );
    expect(() => fn()).not.toThrow();
    expect(caught).toBe(true);
  });

  test("truncate caps length", () => {
    expect(truncate("hello", 3)).toBe("hel");
    expect(truncate(undefined)).toBeUndefined();
  });
});
