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

/**
 * Wipe both stores between tests. Storage now mirrors to cookie + LS by
 * default, and document.cookie persists across happy-dom test runs, so
 * an earlier test's identify("manual-id") would otherwise leak into the
 * next test's fresh-visitor expectations.
 */
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

describe("Identity > autoIdentify: false (the default)", () => {
  test("userId stays null on a fresh visit until identify() is called", () => {
    const id = new Identity();
    expect(id.userId).toBeNull();
    expect(localStorage.getItem(USER_KEY)).toBeNull();
  });

  test("anonymous id is still generated and persisted", () => {
    const id = new Identity();
    expect(id.anonymousId).toMatch(UUID_RE);
    expect(localStorage.getItem(ANON_KEY)).toBe(id.anonymousId);
  });

  test("identify() sets and persists the userId", () => {
    const id = new Identity();
    id.identify("real-user-7");
    expect(id.userId).toBe("real-user-7");
    expect(localStorage.getItem(USER_KEY)).toBe("real-user-7");
  });

  test("a prior identify is restored on the next load", () => {
    new Identity().identify("logged-in-user");
    const reloaded = new Identity();
    expect(reloaded.userId).toBe("logged-in-user");
  });

  test("reset() clears the userId to null and does not rotate to a fresh one", () => {
    const id = new Identity();
    id.identify("user-99");
    id.reset();
    expect(id.userId).toBeNull();
    expect(localStorage.getItem(USER_KEY)).toBeNull();
  });

  test("reset() rotates BOTH the session id and the anonymous (device) id", () => {
    // Logout hygiene: the device id must rotate so the next person on a
    // shared/family browser is not linked into the prior person.
    const id = new Identity();
    id.identify("user-99");
    const anon = id.anonymousId;
    const session = id.sessionId;
    id.reset();
    expect(id.anonymousId).not.toBe(anon);
    expect(id.anonymousId).toMatch(UUID_RE);
    expect(localStorage.getItem(ANON_KEY)).toBe(id.anonymousId);
    expect(id.sessionId).not.toBe(session);
  });
});

describe("Identity > autoIdentify: true (opt-in)", () => {
  test("auto-generates a persistent userId on first visit", () => {
    const id = new Identity({ autoIdentify: true });
    expect(id.userId).toMatch(UUID_RE);
    expect(localStorage.getItem(USER_KEY)).toBe(id.userId);
  });

  test("restores the same userId across reloads", () => {
    const first = new Identity({ autoIdentify: true });
    const second = new Identity({ autoIdentify: true });
    expect(second.userId).toBe(first.userId);
  });

  test("anonymous and user ids are distinct (they are different identity layers)", () => {
    const id = new Identity({ autoIdentify: true });
    expect(id.userId).not.toBe(id.anonymousId);
  });

  test("identify() replaces the auto id with a host-supplied id and persists it", () => {
    const id = new Identity({ autoIdentify: true });
    const auto = id.userId;
    id.identify("real-user-42");
    expect(id.userId).toBe("real-user-42");
    expect(localStorage.getItem(USER_KEY)).toBe("real-user-42");

    const reloaded = new Identity({ autoIdentify: true });
    expect(reloaded.userId).toBe("real-user-42");
    // The auto id is no longer the active one; the manual id wins.
    expect(reloaded.userId).not.toBe(auto);
  });

  test("reset() rotates to a fresh auto userId so the next visitor is treated as a new person", () => {
    const id = new Identity({ autoIdentify: true });
    const before = id.userId;
    id.reset();
    expect(id.userId).toMatch(UUID_RE);
    expect(id.userId).not.toBe(before);
    expect(localStorage.getItem(USER_KEY)).toBe(id.userId);
  });

  test("reset() rotates BOTH the session id and the anonymous (device) id", () => {
    const id = new Identity({ autoIdentify: true });
    const anon = id.anonymousId;
    const session = id.sessionId;
    id.reset();
    expect(id.anonymousId).not.toBe(anon);
    expect(id.sessionId).not.toBe(session);
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
      // Default autoIdentify is off, so userId starts null even when
      // storage is blocked (no auto id to fall back to).
      expect(id.userId).toBeNull();
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

describe("Identity > session continuation", () => {
  const SESSION_KEY = "revu_session_id";
  const SESSION_SEEN_KEY = "revu_session_last_seen";
  // Pin these tests to localStorage-only so they exercise pure session
  // continuation logic without fighting happy-dom's cookie behavior
  // (Max-Age=0 in test teardown does not always evict cookie values
  // between tests in happy-dom's implementation). Cookie persistence has
  // its own test coverage in storage.test.js.
  const LS_ONLY = { persistentStorage: /** @type {const} */ ("localStorage") };

  /**
   * Pin Date.now() for the duration of fn, then restore. Lets tests
   * advance "wall clock" deterministically across multiple Identity
   * constructions to simulate gaps between page loads.
   * @param {(advance: (ms: number) => void) => void} fn
   */
  function withMockClock(fn) {
    const realNow = Date.now;
    let now = 1_700_000_000_000;
    Date.now = () => now;
    try {
      fn((ms) => { now += ms; });
    } finally {
      Date.now = realNow;
    }
  }

  test("the first construction generates and persists a fresh session id + last_seen", () => {
    const id = new Identity(LS_ONLY);
    expect(id.sessionId).toMatch(/^[0-9a-f]{8}-/i);
    expect(localStorage.getItem(SESSION_KEY)).toBe(id.sessionId);
    expect(localStorage.getItem(SESSION_SEEN_KEY)).toBeTruthy();
  });

  test("a second construction within the timeout reuses the prior session id", () => {
    withMockClock((advance) => {
      const first = new Identity({ ...LS_ONLY, sessionTimeoutMs: 60_000 });
      advance(30_000);
      const second = new Identity({ ...LS_ONLY, sessionTimeoutMs: 60_000 });
      expect(second.sessionId).toBe(first.sessionId);
    });
  });

  test("a second construction after the timeout rotates to a fresh session id", () => {
    withMockClock((advance) => {
      const first = new Identity({ ...LS_ONLY, sessionTimeoutMs: 60_000 });
      advance(90_000);
      const second = new Identity({ ...LS_ONLY, sessionTimeoutMs: 60_000 });
      expect(second.sessionId).not.toBe(first.sessionId);
    });
  });

  test("touchSession updates the persisted last_seen so the window slides", () => {
    withMockClock((advance) => {
      const first = new Identity({ ...LS_ONLY, sessionTimeoutMs: 60_000 });
      const originalSession = first.sessionId;
      advance(50_000); // still inside the window
      first.touchSession();
      advance(50_000); // would be past the original window from t=0, but the
                      // touch resets the clock - total elapsed since the last
                      // touch is 50s, still inside the 60s window.
      const reloaded = new Identity({ ...LS_ONLY, sessionTimeoutMs: 60_000 });
      expect(reloaded.sessionId).toBe(originalSession);
    });
  });

  test("touchSession writes are throttled to once per ~5s", () => {
    withMockClock((advance) => {
      const id = new Identity({ ...LS_ONLY, sessionTimeoutMs: 60_000 });
      const initialSeen = localStorage.getItem(SESSION_SEEN_KEY);
      advance(1000);
      id.touchSession(); // inside throttle window; should NOT persist
      expect(localStorage.getItem(SESSION_SEEN_KEY)).toBe(initialSeen);
      advance(5000); // now past the throttle
      id.touchSession();
      expect(localStorage.getItem(SESSION_SEEN_KEY)).not.toBe(initialSeen);
    });
  });

  test("sessionTimeoutMs: 0 disables continuation - every construction rotates", () => {
    withMockClock((advance) => {
      const first = new Identity({ ...LS_ONLY, sessionTimeoutMs: 0 });
      advance(1000);
      const second = new Identity({ ...LS_ONLY, sessionTimeoutMs: 0 });
      expect(second.sessionId).not.toBe(first.sessionId);
      // And nothing is persisted to storage.
      expect(localStorage.getItem(SESSION_KEY)).toBeNull();
    });
  });

  test("reset() rotates the session even inside the continuation window", () => {
    // Logout is a hard boundary that should NEVER survive the continuation
    // window - a freshly-logged-out browser is treated as a new visit, not
    // a continuation of the prior one.
    withMockClock((advance) => {
      const id = new Identity({ ...LS_ONLY, sessionTimeoutMs: 60_000 });
      const original = id.sessionId;
      id.reset();
      expect(id.sessionId).not.toBe(original);
      advance(1000);
      const reloaded = new Identity({ ...LS_ONLY, sessionTimeoutMs: 60_000 });
      expect(reloaded.sessionId).toBe(id.sessionId);
      expect(reloaded.sessionId).not.toBe(original);
    });
  });

  const SESSION_START_KEY = "revu_session_started_at";

  test("an active session rotates once it exceeds sessionMaxMs (absolute cap)", () => {
    withMockClock((advance) => {
      const opts = { ...LS_ONLY, sessionTimeoutMs: 60_000, sessionMaxMs: 100_000 };
      const first = new Identity(opts);
      const original = first.sessionId;
      // Keep it continuously active across the cap: touch every 40 s (inside
      // the 60 s idle window) so only the absolute cap can trigger rotation.
      advance(40_000); first.touchSession();
      advance(40_000); first.touchSession();
      advance(40_000); // 120 s since start, 40 s since last touch (still active)
      const reloaded = new Identity(opts);
      expect(reloaded.sessionId).not.toBe(original); // rotated by the cap
    });
  });

  test("sessionMaxMs: 0 disables the cap - an active session continues indefinitely", () => {
    withMockClock((advance) => {
      const opts = { ...LS_ONLY, sessionTimeoutMs: 60_000, sessionMaxMs: 0 };
      const first = new Identity(opts);
      const original = first.sessionId;
      advance(40_000); first.touchSession();
      advance(40_000); first.touchSession();
      advance(40_000);
      const reloaded = new Identity(opts);
      expect(reloaded.sessionId).toBe(original); // no cap, still continuing
    });
  });

  test("a legacy session with no start timestamp is not force-rotated by the cap", () => {
    withMockClock(() => {
      // Simulate a session persisted by a pre-cap build: id + recent last_seen,
      // but no started_at key.
      const now = Date.now();
      localStorage.setItem(SESSION_KEY, "legacy-session");
      localStorage.setItem(SESSION_SEEN_KEY, String(now));
      expect(localStorage.getItem(SESSION_START_KEY)).toBeNull();
      const id = new Identity({ ...LS_ONLY, sessionTimeoutMs: 60_000, sessionMaxMs: 100_000 });
      expect(id.sessionId).toBe("legacy-session"); // continued, not rotated
    });
  });

  test("corrupt persisted last_seen (non-numeric) is treated as expired", () => {
    // Defense in depth: a stray value, a buggy older version's write, or
    // a user editing storage by hand should not crash the SDK or restore
    // the wrong session - just rotate.
    withMockClock(() => {
      const first = new Identity({ ...LS_ONLY, sessionTimeoutMs: 60_000 });
      localStorage.setItem(SESSION_SEEN_KEY, "not-a-number");
      const second = new Identity({ ...LS_ONLY, sessionTimeoutMs: 60_000 });
      expect(second.sessionId).not.toBe(first.sessionId);
    });
  });
});

