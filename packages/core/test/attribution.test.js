/**
 * @file Tests for the Attribution layer - durable first-touch / last-touch
 * campaign capture. First touch is written once and never overwritten; last
 * touch is rewritten on a genuinely new touch. First touch is stamped under
 * `$initial_*`, last touch under the bare `$utm_*` / `$gclid` / `$fbclid`
 * convention.
 *
 * Runs under happy-dom: `history.replaceState` seeds the query string and
 * `document.referrer` is stubbed where a test needs an external referrer.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { Attribution } from "../src/attribution.js";

const ORIGINAL_HREF = location.href;

/** A minimal in-memory Storage facade so tests do not touch real storage. */
function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    read: (k) => (map.has(k) ? map.get(k) : null),
    write: (k, v) => map.set(k, v),
    remove: (k) => map.delete(k),
    _map: map,
  };
}

/** Stub document.referrer for one test; returns a restore function. */
function withReferrer(value) {
  const original = Object.getOwnPropertyDescriptor(document, "referrer");
  Object.defineProperty(document, "referrer", { configurable: true, value });
  return () => {
    if (original) Object.defineProperty(document, "referrer", original);
    else Object.defineProperty(document, "referrer", { configurable: true, value: "" });
  };
}

afterEach(() => {
  history.replaceState({}, "", ORIGINAL_HREF);
});

describe("Attribution > first touch", () => {
  test("stamps campaign params under $initial_* and persists them", () => {
    history.replaceState({}, "", "/?utm_source=google&utm_medium=cpc&utm_campaign=summer&gclid=abc");
    const store = memoryStorage();
    const props = new Attribution({ storage: store }).properties();

    expect(props.$initial_utm_source).toBe("google");
    expect(props.$initial_utm_medium).toBe("cpc");
    expect(props.$initial_utm_campaign).toBe("summer");
    expect(props.$initial_gclid).toBe("abc");
    // Persisted for the next page load / session.
    expect(store.read("revu_attribution_first")).toContain("google");
  });

  test("records landing path and time even for a direct visit (no params)", () => {
    history.replaceState({}, "", "/pricing");
    const props = new Attribution({ storage: memoryStorage() }).properties();
    expect(props.$initial_landing_path).toBe("/pricing");
    expect(typeof props.$initial_seen_at).toBe("string");
    // No campaign params on a direct visit.
    expect(props.$initial_utm_source).toBeUndefined();
  });

  test("is written once and never overwritten by a later campaign", () => {
    const store = memoryStorage();
    history.replaceState({}, "", "/?utm_source=first&utm_campaign=acquire");
    new Attribution({ storage: store });

    history.replaceState({}, "", "/?utm_source=second&utm_campaign=retarget");
    const props = new Attribution({ storage: store }).properties();

    // First touch stays the acquisition campaign...
    expect(props.$initial_utm_source).toBe("first");
    // ...while last touch moves to the most recent one.
    expect(props.$utm_source).toBe("second");
  });
});

describe("Attribution > last touch", () => {
  test("stamps the current campaign under the bare $utm_* convention", () => {
    history.replaceState({}, "", "/?utm_source=newsletter&utm_medium=email&fbclid=xyz");
    const props = new Attribution({ storage: memoryStorage() }).properties();
    expect(props.$utm_source).toBe("newsletter");
    expect(props.$utm_medium).toBe("email");
    expect(props.$fbclid).toBe("xyz");
  });

  test("updates on a new campaign touch, leaving first touch intact", () => {
    const store = memoryStorage();
    history.replaceState({}, "", "/?utm_source=alpha");
    new Attribution({ storage: store });

    history.replaceState({}, "", "/?utm_source=beta");
    const props = new Attribution({ storage: store }).properties();
    expect(props.$initial_utm_source).toBe("alpha");
    expect(props.$utm_source).toBe("beta");
    expect(store.read("revu_attribution_last")).toContain("beta");
  });

  test("an external referrer counts as a new touch", () => {
    const store = memoryStorage();
    history.replaceState({}, "", "/?utm_source=alpha");
    new Attribution({ storage: store });
    const before = store.read("revu_attribution_last");

    // A later internal landing with no params and no external referrer must
    // NOT overwrite last touch...
    history.replaceState({}, "", "/dashboard");
    new Attribution({ storage: store });
    expect(store.read("revu_attribution_last")).toBe(before);

    // ...but a landing from an external referrer is a fresh touch.
    history.replaceState({}, "", "/landing");
    const restore = withReferrer("https://news.example.com/article");
    try {
      new Attribution({ storage: store });
      expect(store.read("revu_attribution_last")).toContain("/landing");
    } finally {
      restore();
    }
  });
});

describe("Attribution > resilience", () => {
  test("a malformed persisted record is tolerated (re-seeded, never throws)", () => {
    const store = memoryStorage({
      revu_attribution_first: "{not json",
      revu_attribution_last: "{not json",
    });
    history.replaceState({}, "", "/?utm_source=recovered");
    let props;
    expect(() => {
      props = new Attribution({ storage: store }).properties();
    }).not.toThrow();
    expect(props.$initial_utm_source).toBe("recovered");
  });

  test("works without a storage facade (in-memory only, never throws)", () => {
    history.replaceState({}, "", "/?utm_source=memoryonly");
    const props = new Attribution().properties();
    expect(props.$initial_utm_source).toBe("memoryonly");
    expect(props.$utm_source).toBe("memoryonly");
  });
});
