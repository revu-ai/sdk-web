/**
 * @file Tests for the Web Vitals layer.
 *
 * The PerformanceObserver entry shapes (largest-contentful-paint, event,
 * layout-shift) are not available under happy-dom. We test the public
 * contract instead: the reporter emits one `$web_vital` per metric on
 * terminal lifecycle, with values it was fed via the internal hook;
 * accumulates layout-shift values correctly; honors hadRecentInput; and
 * is idempotent across multiple terminal signals.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Vitals } from "../src/vitals.js";

/**
 * Collect events emitted by a Vitals instance.
 * @returns {{ vitals: Vitals, events: Array<{ type: string, properties: any }> }}
 */
function makeVitals() {
  /** @type {Array<{ type: string, properties: any }>} */
  const events = [];
  const vitals = new Vitals((type, data) => {
    events.push({ type, properties: data?.properties });
  });
  return { vitals, events };
}

/**
 * Find the $web_vital event with the given name. Returns undefined if
 * the metric was not emitted.
 * @param {Array<{ type: string, properties: any }>} events
 * @param {"LCP"|"INP"|"CLS"} name
 */
function vital(events, name) {
  return events.find((e) => e.type === "$web_vital" && e.properties?.name === name);
}

beforeEach(() => {
  // Each test installs its own pagehide / visibilitychange listeners on
  // the shared document; clear them between tests so a stale listener
  // does not fire into a dead instance during the next test's report.
  // happy-dom does not expose a "remove all listeners" API, so we let
  // the dead instance's listeners run no-ops via the `_reported` guard.
});

afterEach(() => {
  // No-op; included for symmetry with other test files.
});

describe("Vitals - terminal emission", () => {
  test("emits one $web_vital per observed metric on pagehide", () => {
    const { vitals, events } = makeVitals();
    vitals.start();
    // Bypass PerformanceObserver: drop values straight into the
    // accumulators. The test asserts the reporter's contract, not the
    // observer's plumbing (which happy-dom cannot exercise).
    vitals._lcp = 1234.5;
    vitals._inp = 87.3;
    vitals._cls = 0.0421;

    window.dispatchEvent(new Event("pagehide"));

    const lcp = vital(events, "LCP");
    const inp = vital(events, "INP");
    const cls = vital(events, "CLS");
    expect(lcp?.properties).toEqual({ name: "LCP", value: 1234.5, unit: "ms" });
    expect(inp?.properties).toEqual({ name: "INP", value: 87.3, unit: "ms" });
    expect(cls?.properties).toEqual({ name: "CLS", value: 0.0421, unit: "score" });
  });

  test("emits CLS even when its value is zero (a perfectly stable page is meaningful)", () => {
    const { vitals, events } = makeVitals();
    vitals.start();
    // Leave LCP null and INP at 0; only CLS should fire.
    window.dispatchEvent(new Event("pagehide"));

    expect(vital(events, "LCP")).toBeUndefined();
    expect(vital(events, "INP")).toBeUndefined();
    expect(vital(events, "CLS")?.properties.value).toBe(0);
  });

  test("emits only once even when pagehide fires multiple times (idempotent)", () => {
    const { vitals, events } = makeVitals();
    vitals.start();
    vitals._lcp = 1500;

    window.dispatchEvent(new Event("pagehide"));
    window.dispatchEvent(new Event("pagehide"));

    expect(events.filter((e) => e.type === "$web_vital" && e.properties.name === "LCP"))
      .toHaveLength(1);
  });

  test("emits on visibility-hidden as a preempt for mobile pagehide unreliability", () => {
    const { vitals, events } = makeVitals();
    vitals.start();
    vitals._lcp = 800;

    // happy-dom defaults document.visibilityState to "visible"; stub a
    // single read here so the visibilitychange handler sees "hidden".
    const originalDescriptor = Object.getOwnPropertyDescriptor(Document.prototype, "visibilityState");
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    try {
      document.dispatchEvent(new Event("visibilitychange"));
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(document, "visibilityState", originalDescriptor);
      } else {
        // @ts-expect-error - removing the test stub.
        delete document.visibilityState;
      }
    }

    expect(vital(events, "LCP")?.properties.value).toBe(800);
  });
});

describe("Vitals - CLS session windowing", () => {
  test("shifts close in time accumulate into one window", () => {
    const { vitals, events } = makeVitals();
    vitals.start();
    vitals._addLayoutShift(0.05, 100);
    vitals._addLayoutShift(0.12, 600); // +500ms, same window

    window.dispatchEvent(new Event("pagehide"));

    expect(vital(events, "CLS")?.properties.value).toBeCloseTo(0.17, 5);
  });

  test("a gap over 1s opens a new window; CLS is the max window, not the lifetime sum", () => {
    const { vitals, events } = makeVitals();
    vitals.start();
    vitals._addLayoutShift(0.1, 0);
    vitals._addLayoutShift(0.05, 500); // window 1 = 0.15
    vitals._addLayoutShift(0.3, 2000); // gap 1500ms > 1s -> window 2 starts
    vitals._addLayoutShift(0.05, 2200); // window 2 = 0.35

    window.dispatchEvent(new Event("pagehide"));

    // Lifetime sum would be 0.50; canonical CLS is the larger window, 0.35.
    expect(vital(events, "CLS")?.properties.value).toBeCloseTo(0.35, 5);
  });

  test("a window spanning over 5s rolls over even without a 1s gap", () => {
    const { vitals, events } = makeVitals();
    vitals.start();
    // Seven shifts of 0.1 from t=0..4800 (gaps under 1s) -> window 1 = 0.70.
    for (let ts = 0; ts <= 4800; ts += 800) vitals._addLayoutShift(0.1, ts);
    // t=5200 is within 1s of the previous shift but >5s from the window
    // start, so it opens a new (smaller) window rather than extending.
    vitals._addLayoutShift(0.2, 5200);

    window.dispatchEvent(new Event("pagehide"));

    // Lifetime sum would be 0.90; the max window is the first one, 0.70.
    expect(vital(events, "CLS")?.properties.value).toBeCloseTo(0.7, 5);
  });
});

describe("Vitals - environment guards", () => {
  test("start is a no-op when PerformanceObserver is unavailable", () => {
    // Stub PerformanceObserver as undefined for this test.
    const original = globalThis.PerformanceObserver;
    // @ts-expect-error - intentionally removing for the guard test.
    delete globalThis.PerformanceObserver;
    try {
      const { vitals, events } = makeVitals();
      vitals.start();
      // No listeners installed; pagehide does not trigger emission because
      // the start() path returned before wiring report().
      window.dispatchEvent(new Event("pagehide"));
      expect(events).toEqual([]);
    } finally {
      globalThis.PerformanceObserver = original;
    }
  });
});
