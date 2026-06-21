/**
 * @file Unit tests for DOM-independent core pieces (run under `bun test`).
 * DOM-based capture/transport tests will use happy-dom (added later).
 */

import { describe, expect, test } from "bun:test";
import { resolveConfig } from "../src/config.js";
import { hashUint32, safe, scrubFragment, scrubUrl, truncate, uuid } from "../src/utils.js";

describe("config", () => {
  test("applies defaults over a minimal config", () => {
    const c = resolveConfig({ apiKey: "k" });
    expect(c.apiKey).toBe("k");
    expect(c.autocapture).toBe(true);
    expect(c.host).toContain("revu.ai");
    expect(c.sampleRate).toBe(1);
  });

  test("accepts a sampleRate in [0, 1]", () => {
    expect(resolveConfig({ apiKey: "k", sampleRate: 0 }).sampleRate).toBe(0);
    expect(resolveConfig({ apiKey: "k", sampleRate: 0.25 }).sampleRate).toBe(0.25);
    expect(resolveConfig({ apiKey: "k", sampleRate: 1 }).sampleRate).toBe(1);
  });

  test("rejects a sampleRate outside [0, 1] or non-numeric", () => {
    expect(() => resolveConfig({ apiKey: "k", sampleRate: 1.5 })).toThrow();
    expect(() => resolveConfig({ apiKey: "k", sampleRate: -0.1 })).toThrow();
    // @ts-expect-error - intentionally invalid
    expect(() => resolveConfig({ apiKey: "k", sampleRate: "0.5" })).toThrow();
    expect(() => resolveConfig({ apiKey: "k", sampleRate: Number.NaN })).toThrow();
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

  test("scrubUrl redacts credential / PII params but preserves attribution", () => {
    const out = scrubUrl(
      "https://app.example.com/reset?token=abc123&utm_source=newsletter&gclid=xyz&page=2#section",
    );
    expect(out).not.toContain("abc123"); // token value gone
    expect(out).toContain("token=%5Bredacted%5D"); // replaced, not removed
    expect(out).toContain("utm_source=newsletter"); // attribution preserved
    expect(out).toContain("gclid=xyz"); // click id preserved
    expect(out).toContain("page=2"); // benign param preserved
    expect(out).toContain("#section"); // fragment preserved
    expect(out).toContain("/reset"); // path preserved
  });

  test("scrubUrl matches sensitive keys across delimiter boundaries and casing", () => {
    for (const key of ["access_token", "Reset-Token", "user_email", "PASSWORD", "client_secret"]) {
      const out = scrubUrl(`https://x.test/?${key}=leak`);
      expect(out).not.toContain("leak");
    }
    // Benign keys that merely contain a fragment of a sensitive word stay put.
    for (const url of ["https://x.test/?key=ok", "https://x.test/?code=ok", "https://x.test/?state=ok"]) {
      expect(scrubUrl(url)).toContain("=ok");
    }
  });

  test("scrubUrl leaves query-less, relative, and non-string inputs unchanged", () => {
    expect(scrubUrl("https://x.test/path")).toBe("https://x.test/path");
    expect(scrubUrl("/relative?token=abc")).toBe("/relative?token=abc"); // not absolute, left as-is
    expect(scrubUrl("")).toBe("");
    // @ts-expect-error - intentionally non-string
    expect(scrubUrl(null)).toBe(null);
  });

  test("scrubUrl redacts credential params carried in the URL fragment", () => {
    // OAuth/OIDC implicit flow returns tokens after the '#'.
    const implicit = scrubUrl(
      "https://app.example.com/cb#access_token=SECRET&id_token=SECRET2&token_type=Bearer&expires_in=3600",
    );
    expect(implicit).not.toContain("SECRET");
    expect(implicit).toContain("expires_in=3600"); // benign fragment param preserved
    // Hash-router with a query: route preserved, token redacted.
    const routed = scrubUrl("https://app.example.com/#/account?session_token=LEAK&tab=billing");
    expect(routed).not.toContain("LEAK");
    expect(routed).toContain("/account");
    expect(routed).toContain("tab=billing");
  });

  test("scrubFragment leaves non-credential fragments untouched", () => {
    expect(scrubFragment("#/pricing")).toBe("#/pricing"); // hash-router path
    expect(scrubFragment("#section-2")).toBe("#section-2"); // anchor
    expect(scrubFragment("")).toBe(""); // no fragment
    expect(scrubFragment("#/users?tab=2")).toBe("#/users?tab=2"); // benign query param
  });

  test("scrubFragment redacts sensitive params, preserving the given '#' form", () => {
    expect(scrubFragment("#access_token=abc")).not.toContain("abc");
    expect(scrubFragment("access_token=abc")).not.toContain("abc"); // no leading '#'
    expect(scrubFragment("#token=abc").charAt(0)).toBe("#");
    expect(scrubFragment("token=abc").charAt(0)).not.toBe("#");
  });

  test("hashUint32 is deterministic and an unsigned 32-bit integer", () => {
    const a = hashUint32("session-abc");
    expect(hashUint32("session-abc")).toBe(a); // stable for the same input
    expect(Number.isInteger(a)).toBe(true);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(2 ** 32);
    // Different inputs should not collide for these simple cases.
    expect(hashUint32("session-abd")).not.toBe(a);
    // Maps into [0, 1) cleanly for sampling.
    expect(a / 0x100000000).toBeLessThan(1);
  });
});
