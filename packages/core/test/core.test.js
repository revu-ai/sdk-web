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

  test("accepts a custom https host", () => {
    const c = resolveConfig({ apiKey: "k", host: "https://example.com" });
    expect(c.host).toBe("https://example.com");
  });

  test("accepts http://localhost for dev", () => {
    const c = resolveConfig({ apiKey: "k", host: "http://localhost:4000" });
    expect(c.host).toBe("http://localhost:4000");
  });

  test("rejects a malformed host string", () => {
    expect(() =>
      // @ts-expect-error - intentionally invalid
      resolveConfig({ apiKey: "k", host: "not a url" }),
    ).toThrow(/host must be a valid URL/);
  });

  test("rejects a non-http(s) scheme", () => {
    expect(() =>
      resolveConfig({ apiKey: "k", host: "ftp://example.com" }),
    ).toThrow(/http: or https:/);
    expect(() =>
      resolveConfig({ apiKey: "k", host: "javascript:alert(1)" }),
    ).toThrow(/http: or https:/);
  });

  test("rejects a non-string host", () => {
    expect(() =>
      // @ts-expect-error - intentionally invalid
      resolveConfig({ apiKey: "k", host: 123 }),
    ).toThrow(/host must be a non-empty string/);
    expect(() =>
      // @ts-expect-error - intentionally invalid
      resolveConfig({ apiKey: "k", host: "" }),
    ).toThrow(/host must be a non-empty string/);
  });

  test("defaults environment to production", () => {
    const c = resolveConfig({ apiKey: "k" });
    expect(c.environment).toBe("production");
  });

  test("accepts staging and development environments", () => {
    expect(resolveConfig({ apiKey: "k", environment: "staging" }).environment).toBe("staging");
    expect(resolveConfig({ apiKey: "k", environment: "development" }).environment).toBe(
      "development",
    );
  });

  test("rejects an unknown environment string", () => {
    expect(() =>
      // @ts-expect-error - intentionally invalid
      resolveConfig({ apiKey: "k", environment: "prod" }),
    ).toThrow(/environment must be/);
    expect(() =>
      // @ts-expect-error - intentionally invalid
      resolveConfig({ apiKey: "k", environment: 1 }),
    ).toThrow(/environment must be/);
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
