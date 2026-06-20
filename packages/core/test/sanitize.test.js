/**
 * @file Unit tests for sanitizeProperties - the guard that makes
 * caller-supplied event properties JSON-safe so a stray value can never
 * poison the durable queue. Covers the leaf-type rules, cycle detection,
 * arrays, toJSON handling, throwing getters, and the depth cap.
 */

import { describe, expect, test } from "bun:test";
import { sanitizeProperties } from "../src/utils.js";

describe("sanitizeProperties", () => {
  test("returns undefined for non-object input", () => {
    expect(sanitizeProperties(undefined)).toBeUndefined();
    expect(sanitizeProperties(null)).toBeUndefined();
    expect(sanitizeProperties("str")).toBeUndefined();
    expect(sanitizeProperties(42)).toBeUndefined();
    expect(sanitizeProperties([1, 2, 3])).toBeUndefined(); // top-level must be a plain object
  });

  test("keeps the wire-safe leaf types and drops the rest", () => {
    const out = sanitizeProperties({
      s: "x",
      n: 1.5,
      b: true,
      z: null,
      nan: Number.NaN,
      inf: Number.POSITIVE_INFINITY,
      fn: () => {},
      big: 1n,
      sym: Symbol("s"),
      undef: undefined,
    });
    expect(out).toEqual({ s: "x", n: 1.5, b: true, z: null, nan: null, inf: null });
  });

  test("drops a circular reference but keeps the rest of the object", () => {
    const obj = /** @type {any} */ ({ a: 1 });
    obj.loop = obj;
    const out = sanitizeProperties({ obj });
    expect(out).toEqual({ obj: { a: 1 } });
    expect(() => JSON.stringify(out)).not.toThrow();
  });

  test("a repeated (non-cyclic) object is allowed in both positions", () => {
    const shared = { v: 1 };
    const out = sanitizeProperties({ x: shared, y: shared });
    expect(out).toEqual({ x: { v: 1 }, y: { v: 1 } });
  });

  test("arrays preserve positions, dropping slots become null", () => {
    const out = sanitizeProperties({ arr: ["a", () => {}, 2, undefined] });
    expect(out).toEqual({ arr: ["a", null, 2, null] });
  });

  test("toJSON output is honored and re-sanitized", () => {
    const date = new Date("2020-01-02T03:04:05.000Z");
    const out = sanitizeProperties({ when: date, cute: { toJSON: () => ({ ok: 1n, keep: "y" }) } });
    expect(out?.when).toBe("2020-01-02T03:04:05.000Z");
    // The nested toJSON result is itself sanitized: the BigInt is dropped.
    expect(out?.cute).toEqual({ keep: "y" });
  });

  test("a throwing getter is skipped, not propagated", () => {
    const out = sanitizeProperties({
      get boom() {
        throw new Error("nope");
      },
      safe: "kept",
    });
    expect(out).toEqual({ safe: "kept" });
  });

  test("respects the depth cap without throwing on deep nesting", () => {
    /** @type {any} */
    let deep = "leaf";
    for (let i = 0; i < 50; i++) deep = { next: deep };
    const out = sanitizeProperties({ deep });
    expect(() => JSON.stringify(out)).not.toThrow();
    expect(out).toBeDefined();
  });
});
