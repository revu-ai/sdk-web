/**
 * @file Tests for the Identity layer - anonymous id, persistent user id
 * (autoIdentify), and the session id rotation rules.
 *
 * RevuClient-level transitions ($identify / $reset event emission) live
 * in client.test.js; this file covers only the Identity collaborator's
 * state contract.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { Identity } from "../src/identity.js";

const ANON_KEY = "revu_anonymous_id";
const USER_KEY = "revu_user_id";

// A loose UUID check - the SDK uses `uuid()` (RFC 4122 v4) so any UUID-shaped
// 36-char string is good enough for assertions.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

beforeEach(() => {
  if (typeof localStorage !== "undefined") localStorage.clear();
});

describe("Identity > anonymous id", () => {
  test("is generated on first visit and persisted to localStorage", () => {
    const id = new Identity();
    expect(id.anonymousId).toMatch(UUID_RE);
    expect(localStorage.getItem(ANON_KEY)).toBe(id.anonymousId);
  });

  test("survives reloads (a second Identity instance reads the same value)", () => {
    const first = new Identity();
    const second = new Identity();
    expect(second.anonymousId).toBe(first.anonymousId);
  });
});

describe("Identity > autoIdentify (default true)", () => {
  test("auto-generates a persistent userId on first visit", () => {
    const id = new Identity();
    expect(id.userId).toMatch(UUID_RE);
    expect(localStorage.getItem(USER_KEY)).toBe(id.userId);
  });

  test("restores the same userId across reloads", () => {
    const first = new Identity();
    const second = new Identity();
    expect(second.userId).toBe(first.userId);
  });

  test("anonymous and user ids are distinct (they are different identity layers)", () => {
    const id = new Identity();
    expect(id.userId).not.toBe(id.anonymousId);
  });

  test("identify() replaces the auto id with a host-supplied id and persists it", () => {
    const id = new Identity();
    const auto = id.userId;
    id.identify("real-user-42");
    expect(id.userId).toBe("real-user-42");
    expect(localStorage.getItem(USER_KEY)).toBe("real-user-42");

    const reloaded = new Identity();
    expect(reloaded.userId).toBe("real-user-42");
    // The auto id is no longer the active one; the manual id wins.
    expect(reloaded.userId).not.toBe(auto);
  });

  test("reset() rotates to a fresh auto userId so the next visitor is treated as a new person", () => {
    const id = new Identity();
    const before = id.userId;
    id.reset();
    expect(id.userId).toMatch(UUID_RE);
    expect(id.userId).not.toBe(before);
    expect(localStorage.getItem(USER_KEY)).toBe(id.userId);
  });

  test("reset() rotates the session id but preserves the anonymous (device) id", () => {
    const id = new Identity();
    const anon = id.anonymousId;
    const session = id.sessionId;
    id.reset();
    expect(id.anonymousId).toBe(anon);
    expect(id.sessionId).not.toBe(session);
  });
});

describe("Identity > autoIdentify: false", () => {
  test("userId stays null on a fresh visit until identify() is called", () => {
    const id = new Identity({ autoIdentify: false });
    expect(id.userId).toBeNull();
    expect(localStorage.getItem(USER_KEY)).toBeNull();
  });

  test("anonymous id is still generated and persisted", () => {
    const id = new Identity({ autoIdentify: false });
    expect(id.anonymousId).toMatch(UUID_RE);
    expect(localStorage.getItem(ANON_KEY)).toBe(id.anonymousId);
  });

  test("identify() sets and persists the userId", () => {
    const id = new Identity({ autoIdentify: false });
    id.identify("real-user-7");
    expect(id.userId).toBe("real-user-7");
    expect(localStorage.getItem(USER_KEY)).toBe("real-user-7");
  });

  test("a prior identify is restored on the next load even when autoIdentify is off", () => {
    // Simulates the host app turning autoIdentify off but expecting the
    // last-known identity to survive a refresh.
    new Identity().identify("logged-in-user");
    const reloaded = new Identity({ autoIdentify: false });
    expect(reloaded.userId).toBe("logged-in-user");
  });

  test("reset() clears the userId to null and does not rotate to a fresh one", () => {
    const id = new Identity({ autoIdentify: false });
    id.identify("user-99");
    id.reset();
    expect(id.userId).toBeNull();
    expect(localStorage.getItem(USER_KEY)).toBeNull();
  });
});

describe("Identity > storage failures", () => {
  test("a blocked localStorage still produces a working in-memory identity", () => {
    // Replace the global with a throw-on-touch stub for this test only.
    const original = globalThis.localStorage;
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("storage blocked");
      },
    });
    try {
      const id = new Identity();
      expect(id.anonymousId).toMatch(UUID_RE);
      // userId falls back to an in-memory auto id when storage fails.
      expect(id.userId).toMatch(UUID_RE);
      // identify still mutates in memory even though persistence fails.
      id.identify("manual-id");
      expect(id.userId).toBe("manual-id");
    } finally {
      Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        value: original,
      });
    }
  });
});

describe("Identity > identify input validation", () => {
  test("empty string is ignored", () => {
    const id = new Identity({ autoIdentify: false });
    id.identify("");
    expect(id.userId).toBeNull();
  });

  test("non-string is ignored", () => {
    const id = new Identity({ autoIdentify: false });
    id.identify(/** @type {any} */ (null));
    id.identify(/** @type {any} */ (undefined));
    id.identify(/** @type {any} */ (42));
    expect(id.userId).toBeNull();
  });
});
