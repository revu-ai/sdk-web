/**
 * @file Tests for the storage facade - the abstraction Identity uses to
 * persist ids across reloads. Covers the three storage modes
 * ("localStorage", "cookie", "both"), cookie-wins reconciliation, and
 * cross-store repair on read.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { createStorage } from "../src/storage.js";

const KEY = "revu_test_key";

function clearStores() {
  if (typeof localStorage !== "undefined") localStorage.clear();
  if (typeof document === "undefined") return;
  for (const part of document.cookie.split("; ")) {
    const name = part.split("=")[0];
    if (name) document.cookie = `${name}=; Path=/; Max-Age=0; SameSite=Lax`;
  }
}

beforeEach(() => {
  clearStores();
});

describe("storage > mode: both (default)", () => {
  test("write mirrors to localStorage and document.cookie", () => {
    const s = createStorage();
    s.write(KEY, "abc");
    expect(localStorage.getItem(KEY)).toBe("abc");
    expect(document.cookie).toContain(`${KEY}=abc`);
  });

  test("read returns the value when both stores agree", () => {
    const s = createStorage();
    s.write(KEY, "abc");
    expect(s.read(KEY)).toBe("abc");
  });

  test("remove clears both stores", () => {
    const s = createStorage();
    s.write(KEY, "abc");
    s.remove(KEY);
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(document.cookie).not.toContain(`${KEY}=abc`);
  });
});

describe("storage > reconciliation", () => {
  test("cookie wins when both stores have a value but they differ", () => {
    const s = createStorage();
    localStorage.setItem(KEY, "stale-from-ls");
    document.cookie = `${KEY}=fresh-from-cookie; Path=/; SameSite=Lax`;
    expect(s.read(KEY)).toBe("fresh-from-cookie");
  });

  test("read repairs an empty cookie when only localStorage has the value", () => {
    const s = createStorage();
    localStorage.setItem(KEY, "from-ls");
    // The cookie-only view starts empty - assert via a cookie-only reader
    // rather than inspecting document.cookie's raw string, which can carry
    // expired/empty entries until the next eviction tick.
    expect(createStorage({ mode: "cookie" }).read(KEY)).toBeNull();

    expect(s.read(KEY)).toBe("from-ls");
    // Cookie is now rehydrated so the next page load sees consistent state.
    expect(createStorage({ mode: "cookie" }).read(KEY)).toBe("from-ls");
  });

  test("read repairs empty localStorage when only the cookie has the value", () => {
    const s = createStorage();
    document.cookie = `${KEY}=from-cookie; Path=/; SameSite=Lax`;
    expect(localStorage.getItem(KEY)).toBeNull();

    expect(s.read(KEY)).toBe("from-cookie");
    expect(localStorage.getItem(KEY)).toBe("from-cookie");
  });

  test("both stores empty returns null", () => {
    const s = createStorage();
    expect(s.read(KEY)).toBeNull();
  });
});

describe("storage > mode: localStorage", () => {
  test("write touches only localStorage, not the cookie", () => {
    const s = createStorage({ mode: "localStorage" });
    s.write(KEY, "abc");
    expect(localStorage.getItem(KEY)).toBe("abc");
    expect(document.cookie).not.toContain(`${KEY}=abc`);
  });

  test("read ignores a value sitting only in the cookie", () => {
    const s = createStorage({ mode: "localStorage" });
    document.cookie = `${KEY}=cookie-only; Path=/; SameSite=Lax`;
    // The cookie is intentionally invisible to a localStorage-only
    // configuration; the host opted out of reading it.
    expect(s.read(KEY)).toBeNull();
  });
});

describe("storage > mode: cookie", () => {
  test("write touches only the cookie, not localStorage", () => {
    const s = createStorage({ mode: "cookie" });
    s.write(KEY, "abc");
    expect(document.cookie).toContain(`${KEY}=abc`);
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  test("read ignores a value sitting only in localStorage", () => {
    const s = createStorage({ mode: "cookie" });
    localStorage.setItem(KEY, "ls-only");
    expect(s.read(KEY)).toBeNull();
  });
});

describe("storage > cookie value handling", () => {
  test("values are URL-encoded so reserved chars survive a round-trip", () => {
    const s = createStorage({ mode: "cookie" });
    const value = "user@example.com; weird=value";
    s.write(KEY, value);
    expect(s.read(KEY)).toBe(value);
  });

  test("empty value reads as null (treated as absent)", () => {
    const s = createStorage({ mode: "cookie" });
    document.cookie = `${KEY}=; Path=/; SameSite=Lax`;
    expect(s.read(KEY)).toBeNull();
  });
});
