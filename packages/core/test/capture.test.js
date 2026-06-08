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

describe("Capture - input masking", () => {
  /** Helper: emit and return the click event captured by `cap`. */
  function clickAndGetFingerprint(/** @type {Element} */ el) {
    const { cap, events } = makeCapture();
    cap.start();
    events.length = 0;
    /** @type {HTMLElement} */ (el).click();
    const click = events.find((e) => e.type === "$autocapture");
    return click?.data.fingerprint;
  }

  test("clicking an <input> redacts the fingerprint text", () => {
    const input = document.createElement("input");
    input.type = "text";
    input.value = "user@example.com"; // PII the SDK must never read
    input.placeholder = "email";
    document.body.appendChild(input);

    const fp = clickAndGetFingerprint(input);
    expect(fp).toBeDefined();
    expect(fp?.tag).toBe("input");
    expect(fp?.text).toBeUndefined();
  });

  test("clicking a <textarea> redacts the fingerprint text", () => {
    const ta = document.createElement("textarea");
    ta.value = "private note contents";
    ta.appendChild(document.createTextNode("default content")); // textContent
    document.body.appendChild(ta);

    const fp = clickAndGetFingerprint(ta);
    expect(fp?.tag).toBe("textarea");
    expect(fp?.text).toBeUndefined();
  });

  test("clicking a <select> redacts the fingerprint text", () => {
    const sel = document.createElement("select");
    const opt = document.createElement("option");
    opt.value = "1";
    opt.textContent = "Sensitive option";
    sel.appendChild(opt);
    document.body.appendChild(sel);

    const fp = clickAndGetFingerprint(sel);
    expect(fp?.tag).toBe("select");
    expect(fp?.text).toBeUndefined();
  });

  test("clicking a [contenteditable] redacts the fingerprint text", () => {
    const div = document.createElement("div");
    div.setAttribute("contenteditable", "true");
    div.textContent = "Draft of a private message";
    document.body.appendChild(div);

    const fp = clickAndGetFingerprint(div);
    expect(fp?.tag).toBe("div");
    expect(fp?.text).toBeUndefined();
  });

  test("clicking a non-sensitive container strips child input values from fingerprint text", () => {
    // The container's visible label ("Sign in") should survive; the nested
    // input's value ("super-secret") must NOT appear in fingerprint.text.
    const container = document.createElement("button");
    container.id = "signin";
    container.appendChild(document.createTextNode("Sign in "));
    const input = document.createElement("input");
    input.type = "text";
    input.value = "super-secret";
    container.appendChild(input);
    document.body.appendChild(container);

    const fp = clickAndGetFingerprint(container);
    expect(fp?.tag).toBe("button");
    expect(fp?.text).toBeDefined();
    expect(fp?.text).toContain("Sign in");
    expect(fp?.text).not.toContain("super-secret");
  });

  test("clicking an element with [data-revu-mask] redacts the fingerprint text", () => {
    const div = document.createElement("div");
    div.setAttribute("data-revu-mask", "");
    div.textContent = "Balance: $12,345.67";
    document.body.appendChild(div);

    const fp = clickAndGetFingerprint(div);
    expect(fp?.text).toBeUndefined();
  });

  test("clicking inside a [data-revu-mask] ancestor also redacts (descendant inherits)", () => {
    const wrapper = document.createElement("div");
    wrapper.setAttribute("data-revu-mask", "");
    const inner = document.createElement("button");
    inner.textContent = "Hidden CTA";
    wrapper.appendChild(inner);
    document.body.appendChild(wrapper);

    const fp = clickAndGetFingerprint(inner);
    expect(fp?.text).toBeUndefined();
  });

  test('contenteditable="false" is NOT treated as sensitive (explicit opt-out)', () => {
    const div = document.createElement("div");
    div.setAttribute("contenteditable", "false");
    div.textContent = "Just a label";
    document.body.appendChild(div);

    const fp = clickAndGetFingerprint(div);
    expect(fp?.text).toBe("Just a label");
  });
});
