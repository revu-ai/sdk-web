/**
 * @file DOM-based tests for the autocapture layer. Driven by happy-dom (loaded
 * via the root `bunfig.toml` preload) so a real `window`, `document`, and
 * `history` are available; no manual JSDOM bootstrap inside the test file.
 *
 * The tests exercise the observable contract of `Capture`:
 * - emits `$pageview` on start, with the expected properties shape
 * - emits `$autocapture` on click, with a fingerprint and the current screen
 * - SPA route changes (pushState/replaceState) re-emit a pageview when the
 *   pathname changes, and are a no-op when it does not
 * - hash-only changes do NOT re-emit (documents the current pathname-based
 *   behavior; if/when we add hash-router support, this test will flip)
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { Capture } from "../src/capture.js";

/**
 * @typedef {{ type: string, data: { fingerprint?: any, properties?: any } }} CapturedEvent
 */

/**
 * Build a fresh Capture instance whose emitted events go into a local array.
 * @returns {{ cap: Capture, events: CapturedEvent[] }}
 */
function makeCapture() {
  /** @type {CapturedEvent[]} */
  const events = [];
  const cap = new Capture((type, data) => events.push({ type, data: data || {} }), {
    maskAllInputs: true,
  });
  return { cap, events };
}

/** Filter helper: only `$pageview` events. */
function pageviews(/** @type {CapturedEvent[]} */ events) {
  return events.filter((e) => e.type === "$pageview");
}

beforeEach(() => {
  // Reset URL and DOM so the next test installs SPA listeners against a clean
  // baseline. `replaceState` runs before any Capture instance is constructed,
  // so it goes through the unpatched History API.
  history.replaceState(null, "", "/");
  document.title = "";
  document.body.innerHTML = "";
});

describe("Capture", () => {
  test("emits $pageview on start with url, path, referrer, title", () => {
    document.title = "Home";
    const { cap, events } = makeCapture();
    cap.start();

    expect(events).toHaveLength(1);
    const [pv] = events;
    expect(pv.type).toBe("$pageview");
    expect(pv.data.properties.path).toBe("/");
    expect(pv.data.properties.url).toContain("/");
    expect(pv.data.properties.title).toBe("Home");
    // `referrer` may be empty in happy-dom; we just assert the key shape is
    // either undefined or a string, never something exotic.
    const ref = pv.data.properties.referrer;
    expect(ref === undefined || typeof ref === "string").toBe(true);
  });

  test("emits $autocapture on click with a fingerprint and current screen", () => {
    const btn = document.createElement("button");
    btn.id = "go";
    btn.textContent = "Go";
    document.body.appendChild(btn);

    const { cap, events } = makeCapture();
    cap.start();
    btn.click();

    const click = events.find((e) => e.type === "$autocapture");
    expect(click).toBeDefined();
    expect(click?.data.fingerprint).toBeDefined();
    expect(click?.data.properties.path).toBe("/");
  });

  test("pushState to a new path emits a $pageview", () => {
    const { cap, events } = makeCapture();
    cap.start();
    events.length = 0;

    history.pushState(null, "", "/pricing");

    const pv = pageviews(events);
    expect(pv).toHaveLength(1);
    expect(pv[0].data.properties.path).toBe("/pricing");
  });

  test("pushState to the same path does NOT re-emit a $pageview", () => {
    const { cap, events } = makeCapture();
    cap.start();
    events.length = 0;

    history.pushState(null, "", "/");

    expect(pageviews(events)).toHaveLength(0);
  });

  test("replaceState to a new path emits a $pageview", () => {
    const { cap, events } = makeCapture();
    cap.start();
    events.length = 0;

    history.replaceState(null, "", "/about");

    expect(pageviews(events)).toHaveLength(1);
    expect(pageviews(events)[0].data.properties.path).toBe("/about");
  });

  test("hash-only change does NOT emit a $pageview (pathname-based)", () => {
    // Documents the current behavior: hash-router SPAs would need a separate
    // `hashchange` listener. Adding that is a follow-up slice.
    const { cap, events } = makeCapture();
    cap.start();
    events.length = 0;

    history.pushState(null, "", "/#section-2");

    expect(pageviews(events)).toHaveLength(0);
  });
});
