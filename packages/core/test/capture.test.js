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

import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Attention } from "../src/attention.js";
import { Capture } from "../src/capture.js";

/**
 * happy-dom synthesizes navigation when a click bubbles up to an `<a>`,
 * which mutates `window.location` (host included). That leaks across
 * tests: a later test that constructs `https://external.example.com/`
 * would compare against location.hostname === "external.example.com"
 * and silently misclassify the link as same-host. The capture layer is
 * supposed to read the user's current location at click time, so we
 * pin it to the registrator's localhost origin for the whole file by
 * preventing every test-dispatched anchor click from actually navigating.
 */
beforeAll(() => {
  document.addEventListener("click", (e) => {
    const t = /** @type {Element|null} */ (e.target);
    if (t && t.closest && t.closest("a[href]")) e.preventDefault();
  });
});

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
  // Capture now delegates the engagement clock to the Attention layer.
  // Wire a real Attention with the lifecycle events muted (captureAttention:
  // false) so these tests only see the capture-emitted events. idleTimeoutMs
  // is generous so the idle timer does not fire mid-test.
  const emit = (/** @type {string} */ type, /** @type {any} */ data) =>
    events.push({ type, data: data || {} });
  const attention = new Attention(emit, { captureAttention: false, idleTimeoutMs: 60_000 });
  attention.start();
  const cap = new Capture(emit, { maskAllInputs: true }, attention);
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

/**
 * happy-dom does not lay out the DOM, so scroll position and document
 * height are not derived from real layout. These helpers stub the three
 * inputs to `computeScrollDepthPercent` (window.innerHeight,
 * document.documentElement.scrollHeight, document.body.scrollHeight) so
 * a test can dial in any depth deterministically.
 *
 * @param {{ innerHeight: number, scrollHeight: number }} sizes
 * @returns {() => void} A restore function the test calls in `finally`.
 */
function stubScrollGeometry({ innerHeight, scrollHeight }) {
  const originalInner = Object.getOwnPropertyDescriptor(window, "innerHeight");
  const originalDoc = Object.getOwnPropertyDescriptor(document.documentElement, "scrollHeight");
  const originalBody = Object.getOwnPropertyDescriptor(document.body, "scrollHeight");
  Object.defineProperty(window, "innerHeight", { configurable: true, value: innerHeight });
  Object.defineProperty(document.documentElement, "scrollHeight", { configurable: true, value: scrollHeight });
  Object.defineProperty(document.body, "scrollHeight", { configurable: true, value: scrollHeight });
  return () => {
    if (originalInner) Object.defineProperty(window, "innerHeight", originalInner);
    if (originalDoc) Object.defineProperty(document.documentElement, "scrollHeight", originalDoc);
    if (originalBody) Object.defineProperty(document.body, "scrollHeight", originalBody);
  };
}

/** @param {number} y */
function setScrollY(y) {
  Object.defineProperty(window, "scrollY", { configurable: true, value: y });
}

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

  test("hash change emits a $pageview with the hash included in path", () => {
    // Hash-router SPAs (e.g. `/#/pricing` -> `/#/about`) and plain anchor
    // navigation (`#section-1` -> `#section-2`) are both observed: the route
    // signature is pathname + hash, so any change to either segment is a
    // distinct screen.
    const { cap, events } = makeCapture();
    cap.start();
    events.length = 0;

    history.pushState(null, "", "/#section-2");

    const pv = pageviews(events);
    expect(pv).toHaveLength(1);
    expect(pv[0].data.properties.path).toBe("/#section-2");
  });

  test("hash-router transitions emit one $pageview per route", () => {
    const { cap, events } = makeCapture();
    cap.start();
    events.length = 0;

    history.pushState(null, "", "/#/pricing");
    history.pushState(null, "", "/#/about");
    history.pushState(null, "", "/#/about"); // duplicate, no extra emit

    const pv = pageviews(events);
    expect(pv).toHaveLength(2);
    expect(pv.map((e) => e.data.properties.path)).toEqual(["/#/pricing", "/#/about"]);
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

// ===========================================================================
// Slice 2: engagement interaction events
// ===========================================================================

describe("Capture - right click", () => {
  test("contextmenu emits $rightclick with a fingerprint", () => {
    const btn = document.createElement("button");
    btn.id = "ctx";
    btn.textContent = "Right me";
    document.body.appendChild(btn);

    const { cap, events } = makeCapture();
    cap.start();
    events.length = 0;
    btn.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));

    const rc = events.find((e) => e.type === "$rightclick");
    expect(rc).toBeDefined();
    expect(rc?.data.fingerprint?.tag).toBe("button");
    expect(rc?.data.properties.path).toBe("/");
  });
});

describe("Capture - rage click", () => {
  test("3 fast clicks on the same target emit one $rageclick", () => {
    const btn = document.createElement("button");
    btn.id = "broken";
    btn.textContent = "Click me";
    document.body.appendChild(btn);

    const { cap, events } = makeCapture();
    cap.start();
    events.length = 0;
    btn.click();
    btn.click();
    btn.click();

    const rage = events.filter((e) => e.type === "$rageclick");
    expect(rage).toHaveLength(1);
    expect(rage[0].data.properties.click_count).toBe(3);
    expect(rage[0].data.fingerprint?.tag).toBe("button");
  });

  test("a 5-click rage does not emit multiple $rageclick events", () => {
    const btn = document.createElement("button");
    btn.id = "very-broken";
    document.body.appendChild(btn);

    const { cap, events } = makeCapture();
    cap.start();
    events.length = 0;
    for (let i = 0; i < 5; i++) btn.click();

    expect(events.filter((e) => e.type === "$rageclick")).toHaveLength(1);
  });

  test("clicks on different elements do not aggregate into a rage", () => {
    const a = document.createElement("button");
    a.id = "a";
    const b = document.createElement("button");
    b.id = "b";
    document.body.appendChild(a);
    document.body.appendChild(b);

    const { cap, events } = makeCapture();
    cap.start();
    events.length = 0;
    a.click();
    b.click();
    a.click();

    expect(events.filter((e) => e.type === "$rageclick")).toHaveLength(0);
  });
});

describe("Capture - file download + outbound link classification", () => {
  test("clicking a link with download attribute emits $file_download", () => {
    const a = document.createElement("a");
    a.href = "/report.pdf";
    a.setAttribute("download", "Annual Report.pdf");
    a.textContent = "Download";
    document.body.appendChild(a);

    const { cap, events } = makeCapture();
    cap.start();
    events.length = 0;
    a.click();

    const dl = events.find((e) => e.type === "$file_download");
    expect(dl).toBeDefined();
    expect(dl?.data.properties.filename).toBe("Annual Report.pdf");
    expect(dl?.data.properties.extension).toBe("pdf");
  });

  test("clicking a link with a known file extension emits $file_download", () => {
    const a = document.createElement("a");
    a.href = "/files/data.csv?token=abc";
    document.body.appendChild(a);

    const { cap, events } = makeCapture();
    cap.start();
    events.length = 0;
    a.click();

    const dl = events.find((e) => e.type === "$file_download");
    expect(dl).toBeDefined();
    expect(dl?.data.properties.extension).toBe("csv");
  });

  test("clicking an internal page link (.html / no extension) emits neither", () => {
    const a = document.createElement("a");
    a.href = "/about";
    document.body.appendChild(a);

    const { cap, events } = makeCapture();
    cap.start();
    events.length = 0;
    a.click();

    expect(events.find((e) => e.type === "$file_download")).toBeUndefined();
    expect(events.find((e) => e.type === "$outbound_link")).toBeUndefined();
  });

  test("clicking a cross-origin link emits $outbound_link", () => {
    const a = document.createElement("a");
    a.href = "https://external.example.com/path";
    document.body.appendChild(a);

    const { cap, events } = makeCapture();
    cap.start();
    events.length = 0;
    a.click();

    const out = events.find((e) => e.type === "$outbound_link");
    expect(out).toBeDefined();
    expect(out?.data.properties.target_host).toBe("external.example.com");
  });

  test("clicking an inner span inside an <a> still classifies the parent link", () => {
    const a = document.createElement("a");
    a.href = "https://external.example.com/";
    const span = document.createElement("span");
    span.textContent = "Click target";
    a.appendChild(span);
    document.body.appendChild(a);

    const { cap, events } = makeCapture();
    cap.start();
    events.length = 0;
    // dispatchEvent with bubbles:true is the reliable path for non-button
    // elements under happy-dom; `.click()` shorthand is implemented for
    // form-control elements but not for plain spans.
    span.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    expect(events.find((e) => e.type === "$outbound_link")).toBeDefined();
  });
});

describe("Capture - form submit", () => {
  test("emits $form_submit with field names and types but never values", () => {
    const form = document.createElement("form");
    form.id = "signup";
    form.setAttribute("action", "/api/signup");
    form.setAttribute("method", "post");

    const email = document.createElement("input");
    email.type = "email";
    email.name = "email";
    email.value = "user@example.com"; // must NOT leak
    const password = document.createElement("input");
    password.type = "password";
    password.name = "password";
    password.value = "secret"; // must NOT leak
    form.appendChild(email);
    form.appendChild(password);
    document.body.appendChild(form);

    const { cap, events } = makeCapture();
    cap.start();
    events.length = 0;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    const fs = events.find((e) => e.type === "$form_submit");
    expect(fs).toBeDefined();
    const p = /** @type {any} */ (fs?.data.properties);
    expect(p.form_id).toBe("signup");
    expect(p.action).toBe("/api/signup");
    expect(p.method).toBe("POST");
    expect(p.field_names).toEqual(["email", "password"]);
    expect(p.field_types).toEqual(["email", "password"]);
    // Hard assertion: values must NEVER appear in the serialized event.
    const json = JSON.stringify(fs);
    expect(json).not.toContain("user@example.com");
    expect(json).not.toContain("secret");
  });

  test("a form marked [data-revu-mask] emits $form_submit without field metadata", () => {
    const form = document.createElement("form");
    form.setAttribute("data-revu-mask", "");
    const input = document.createElement("input");
    input.type = "text";
    input.name = "ssn";
    form.appendChild(input);
    document.body.appendChild(form);

    const { cap, events } = makeCapture();
    cap.start();
    events.length = 0;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    const fs = events.find((e) => e.type === "$form_submit");
    expect(fs).toBeDefined();
    const p = /** @type {any} */ (fs?.data.properties);
    expect(p.field_names).toBeUndefined();
    expect(p.field_types).toBeUndefined();
  });
});

describe("Capture - scroll depth", () => {
  test("emits $scroll once per crossed milestone, never twice for the same one", () => {
    // happy-dom doesn't have a real layout engine; stub the geometry so
    // computeScrollDepthPercent's three inputs (scrollY, innerHeight,
    // scrollHeight) come from us.
    const restore = stubScrollGeometry({ innerHeight: 800, scrollHeight: 4000 });
    const { cap, events } = makeCapture();
    cap.start();
    events.length = 0;
    try {
      // Each call resets the throttle gate first so the test exercises
      // milestone semantics without waiting on the real 250ms timer.
      // The throttle has its own dedicated test below.
      const tick = () => { cap._scrollThrottled = false; cap.onScroll(); };
      setScrollY(0); tick(); // depth = 800/4000 = 20% -> nothing
      setScrollY(200); tick(); // (200+800)/4000 = 25% -> milestone 25
      setScrollY(200); tick(); // same 25% -> NO repeat
      setScrollY(1200); tick(); // (1200+800)/4000 = 50% -> milestone 50

      const scrolls = events.filter((e) => e.type === "$scroll");
      expect(scrolls.map((s) => s.data.properties.depth_percent)).toEqual([25, 50]);
    } finally {
      restore();
    }
  });

  test("rapid scrolls inside the throttle window collapse to a single milestone emit", () => {
    const restore = stubScrollGeometry({ innerHeight: 800, scrollHeight: 4000 });
    const { cap, events } = makeCapture();
    cap.start();
    events.length = 0;
    try {
      // Two rapid scroll handler invocations: the first runs, the second
      // is throttled out. Net effect: at most one milestone per throttle
      // window even when the user is scrolling continuously.
      setScrollY(200); cap.onScroll(); // 25% -> emits
      setScrollY(1200); cap.onScroll(); // throttled, never runs

      const scrolls = events.filter((e) => e.type === "$scroll");
      expect(scrolls.map((s) => s.data.properties.depth_percent)).toEqual([25]);
    } finally {
      restore();
    }
  });

  test("a document shorter than the viewport reports 100% on any scroll", () => {
    const restore = stubScrollGeometry({ innerHeight: 1000, scrollHeight: 500 });
    const { cap, events } = makeCapture();
    cap.start();
    events.length = 0;
    try {
      cap.onScroll();
      const scrolls = events.filter((e) => e.type === "$scroll");
      // Single short page that fits in the viewport: 25/50/75/100 all fire
      // off the first scroll because the user is already at 100%.
      expect(scrolls.map((s) => s.data.properties.depth_percent)).toEqual([25, 50, 75, 100]);
    } finally {
      restore();
    }
  });
});

describe("Capture - page leave + engagement time", () => {
  test("SPA route change emits $page_leave for the previous path", () => {
    const { cap, events } = makeCapture();
    cap.start();
    events.length = 0;
    history.pushState(null, "", "/next");

    const leave = events.find((e) => e.type === "$page_leave");
    expect(leave).toBeDefined();
    expect(leave?.data.properties.path).toBe("/");
    expect(typeof leave?.data.properties.engagement_time_ms).toBe("number");
    // Order matters: the $page_leave must precede the next $pageview so a
    // dashboard sees the close-of-page-A before the open-of-page-B.
    const leaveIdx = events.findIndex((e) => e.type === "$page_leave");
    const pvIdx = events.findIndex((e) => e.type === "$pageview");
    expect(leaveIdx).toBeLessThan(pvIdx);
  });

  test("pagehide emits a $page_leave with engagement_time_ms", () => {
    const { cap, events } = makeCapture();
    cap.start();
    events.length = 0;
    window.dispatchEvent(new Event("pagehide"));

    const leave = events.find((e) => e.type === "$page_leave");
    expect(leave).toBeDefined();
    expect(leave?.data.properties.path).toBe("/");
    expect(typeof leave?.data.properties.engagement_time_ms).toBe("number");
    expect(/** @type {number} */ (leave?.data.properties.engagement_time_ms)).toBeGreaterThanOrEqual(0);
  });

  test("$page_leave on pagehide carries the persisted flag from the event", () => {
    const { cap, events } = makeCapture();
    cap.start();
    events.length = 0;
    // PageTransitionEvent has a `persisted: boolean`. happy-dom does not
    // construct PageTransitionEvent natively, but a synthetic Event with
    // the property attached is enough to exercise the read path.
    const e = new Event("pagehide");
    Object.defineProperty(e, "persisted", { value: true });
    window.dispatchEvent(e);

    const leave = events.find((ev) => ev.type === "$page_leave");
    expect(leave?.data.properties.persisted).toBe(true);
  });
});

