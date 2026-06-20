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
  const cap = new Capture(emit, attention);
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

/**
 * Force the scroll throttle gate open and run one `onScroll` pass, so a test
 * can step through scroll positions deterministically without waiting on the
 * real `SCROLL_THROTTLE_MS` timer.
 * @param {import("../src/capture.js").Capture} cap
 */
function tick(cap) {
  cap._scrollThrottled = false;
  cap.onScroll();
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

  test("$pageview url redacts sensitive query values but keeps attribution params", () => {
    history.replaceState(null, "", "/welcome?token=secret123&utm_source=newsletter&page=2");
    const { cap, events } = makeCapture();
    cap.start();

    const pv = pageviews(events)[0];
    expect(pv).toBeDefined();
    const url = /** @type {string} */ (pv.data.properties.url);
    expect(url).not.toContain("secret123"); // token value never leaves the browser
    expect(url).toContain("redacted");
    expect(url).toContain("utm_source=newsletter"); // server-side attribution intact
    expect(url).toContain("page=2");
    // The route identity (path/screen) is the pathname, query-free as before.
    expect(pv.data.properties.path).toBe("/welcome");
  });

  test("a throwing handler is swallowed but reported via onError (debug visibility)", () => {
    /** @type {unknown[]} */
    const errors = [];
    const attention = new Attention(() => {}, { captureAttention: false, idleTimeoutMs: 60_000 });
    attention.start();
    const cap = new Capture(() => {}, attention, (err) => errors.push(err));
    cap.start();
    // Force the click handler to throw at dispatch time.
    cap.onClick = () => {
      throw new Error("handler boom");
    };
    const btn = document.createElement("button");
    document.body.appendChild(btn);

    // The throw must not escape into the host's event dispatch...
    expect(() => btn.click()).not.toThrow();
    // ...but it must be reported so a debug session can see the SDK bug.
    expect(errors.length).toBeGreaterThan(0);
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
      setScrollY(0); tick(cap); // depth = 800/4000 = 20% -> nothing
      setScrollY(200); tick(cap); // (200+800)/4000 = 25% -> milestone 25
      setScrollY(200); tick(cap); // same 25% -> NO repeat
      setScrollY(1200); tick(cap); // (1200+800)/4000 = 50% -> milestone 50

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

  test("visibilitychange to hidden emits $page_leave (iOS Safari terminal signal)", () => {
    const { cap, events } = makeCapture();
    cap.start();
    events.length = 0;
    // iOS Safari often skips `pagehide` on tab close / app background; the
    // only reliable terminal signal there is `visibilitychange` to hidden.
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));

    const leave = events.find((e) => e.type === "$page_leave");
    expect(leave).toBeDefined();
    expect(leave?.data.properties.path).toBe("/");
  });

  test("a desktop close (hidden then pagehide) emits a checkpoint then a terminal upgrade", () => {
    const { cap, events } = makeCapture();
    cap.start();
    events.length = 0;
    // Desktop close fires `visibilitychange -> hidden` (a checkpoint, since
    // mobile may have no pagehide) and THEN `pagehide` (the definitive
    // terminal). The pagehide must upgrade rather than be deduped away, so a
    // real exit is recorded as terminal and not misread as a resumable blur.
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("pagehide"));

    const leaves = events.filter((e) => e.type === "$page_leave");
    expect(leaves.map((e) => e.data.properties.trigger)).toEqual(["hidden", "pagehide"]);
    // Engagement is banked on the checkpoint; the terminal upgrade adds ~0.
    expect(leaves[1].data.properties.engagement_time_ms).toBe(0);
  });

  test("a repeated terminal signal is still deduped (no third leave)", () => {
    const { cap, events } = makeCapture();
    cap.start();
    events.length = 0;
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("pagehide"));
    window.dispatchEvent(new Event("pagehide")); // duplicate terminal

    const leaves = events.filter((e) => e.type === "$page_leave");
    expect(leaves).toHaveLength(2); // hidden + one pagehide, not three
  });

  test("a tab-blur with no following pagehide stays a single hidden checkpoint", () => {
    const { cap, events } = makeCapture();
    cap.start();
    events.length = 0;
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));

    const leaves = events.filter((e) => e.type === "$page_leave");
    expect(leaves).toHaveLength(1);
    expect(leaves[0].data.properties.trigger).toBe("hidden");
  });

  test("$page_leave carries a trigger distinguishing how the page closed", () => {
    // navigation: SPA route change.
    {
      const { cap, events } = makeCapture();
      cap.start();
      events.length = 0;
      history.pushState(null, "", "/next");
      const leave = events.find((e) => e.type === "$page_leave");
      expect(leave?.data.properties.trigger).toBe("navigation");
    }
    // pagehide: terminal close / navigation / bfcache.
    {
      const { cap, events } = makeCapture();
      cap.start();
      events.length = 0;
      window.dispatchEvent(new Event("pagehide"));
      const leave = events.find((e) => e.type === "$page_leave");
      expect(leave?.data.properties.trigger).toBe("pagehide");
    }
    // hidden: tab backgrounded (the visitor may return).
    {
      const { cap, events } = makeCapture();
      cap.start();
      events.length = 0;
      Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
      const leave = events.find((e) => e.type === "$page_leave");
      expect(leave?.data.properties.trigger).toBe("hidden");
    }
  });

  test("returning to foreground re-arms $page_leave for the next terminal event", () => {
    const { cap, events } = makeCapture();
    cap.start();
    events.length = 0;
    // First terminal signal: page hidden, $page_leave emits.
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    // User returns to the tab; the dedup flag must reset so the NEXT
    // hide-or-close still emits a $page_leave.
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));

    const leaves = events.filter((e) => e.type === "$page_leave");
    expect(leaves).toHaveLength(2);
  });
});

describe("Capture - scroll scalars on $page_leave", () => {
  /**
   * Scrollback (max > final) is the signal you cannot derive from the
   * 25/50/75/100 milestone events: those fire once per crossed milestone
   * and never re-emit when the user goes back up. The two scalars on
   * $page_leave (max_scroll_percent, final_scroll_percent) are the
   * scrollback-and-drop-off primitive for the dashboard.
   */
  test("$page_leave carries max_scroll_percent and final_scroll_percent after a down-then-up trip", () => {
    const restore = stubScrollGeometry({ innerHeight: 800, scrollHeight: 4000 });
    const { cap, events } = makeCapture();
    cap.start();
    events.length = 0;
    try {
      setScrollY(200); tick(cap);  // 25%
      setScrollY(1200); tick(cap); // 50%
      setScrollY(2200); tick(cap); // 75%
      setScrollY(400); tick(cap);  // back up to 30% (final), max stays 75
      window.dispatchEvent(new Event("pagehide"));

      const leave = events.find((e) => e.type === "$page_leave");
      expect(leave).toBeDefined();
      expect(leave?.data.properties.max_scroll_percent).toBe(75);
      expect(leave?.data.properties.final_scroll_percent).toBe(30);
    } finally {
      restore();
    }
  });

  test("a document shorter than the viewport seeds max + final at 100 even without scroll", () => {
    const restore = stubScrollGeometry({ innerHeight: 1000, scrollHeight: 500 });
    const { cap, events } = makeCapture();
    cap.start();
    events.length = 0;
    try {
      // No onScroll() call; user never scrolls. Page already 100% visible.
      window.dispatchEvent(new Event("pagehide"));

      const leave = events.find((e) => e.type === "$page_leave");
      expect(leave?.data.properties.max_scroll_percent).toBe(100);
      expect(leave?.data.properties.final_scroll_percent).toBe(100);
    } finally {
      restore();
    }
  });

  test("user landing mid-page (deep link / bfcache restore) is seeded at the landing depth", () => {
    // Deep link to `/article#section-3`: the browser scrolls the user to
    // the anchor before our pageview seed runs. We must record the landing
    // position as the starting max + final, not 0.
    const restore = stubScrollGeometry({ innerHeight: 800, scrollHeight: 4000 });
    setScrollY(1200); // (1200 + 800) / 4000 = 50%
    const { cap, events } = makeCapture();
    cap.start();
    events.length = 0;
    try {
      // No further scrolling; user leaves immediately. The leave must
      // reflect that the user was mid-page from the start.
      window.dispatchEvent(new Event("pagehide"));

      const leave = events.find((e) => e.type === "$page_leave");
      expect(leave?.data.properties.max_scroll_percent).toBe(50);
      expect(leave?.data.properties.final_scroll_percent).toBe(50);
    } finally {
      restore();
      setScrollY(0);
    }
  });

  test("landing mid-page then scrolling further down banks the deeper max", () => {
    const restore = stubScrollGeometry({ innerHeight: 800, scrollHeight: 4000 });
    setScrollY(1200); // land at 50%
    const { cap, events } = makeCapture();
    cap.start();
    events.length = 0;
    try {
      setScrollY(2400); tick(cap); // scroll down to 80%
      setScrollY(1600); tick(cap); // scroll back up to 60%
      window.dispatchEvent(new Event("pagehide"));

      const leave = events.find((e) => e.type === "$page_leave");
      // Max captures the deepest reach (80%), final captures the leave
      // position (60%). Scrollback delta is 20% even though the user
      // started in the middle.
      expect(leave?.data.properties.max_scroll_percent).toBe(80);
      expect(leave?.data.properties.final_scroll_percent).toBe(60);
    } finally {
      restore();
      setScrollY(0);
    }
  });

  test("SPA route change resets max + final for the new page", () => {
    const restore = stubScrollGeometry({ innerHeight: 800, scrollHeight: 4000 });
    const { cap, events } = makeCapture();
    cap.start();
    events.length = 0;
    try {
      setScrollY(2200); tick(cap); // 75% on page A
      // SPA navigation closes out page A and starts page B at the top.
      setScrollY(0);
      history.pushState(null, "", "/next");
      // The $page_leave for page A must reflect page A's furthest depth.
      const leaveA = events.find((e) => e.type === "$page_leave");
      expect(leaveA?.data.properties.path).toBe("/");
      expect(leaveA?.data.properties.max_scroll_percent).toBe(75);

      // Now terminate page B. Its max must NOT carry over from page A.
      window.dispatchEvent(new Event("pagehide"));
      const leaveB = events.filter((e) => e.type === "$page_leave").pop();
      expect(leaveB?.data.properties.path).toBe("/next");
      // Page B was seeded at 20% (scrollY=0, viewport 800 of 4000) and the
      // user never scrolled, so max + final both equal the seed.
      expect(leaveB?.data.properties.max_scroll_percent).toBe(20);
      expect(leaveB?.data.properties.final_scroll_percent).toBe(20);
    } finally {
      restore();
    }
  });
});

describe("Capture - $change on form controls", () => {
  /**
   * The semantic gap between `$autocapture` (a click on a control) and
   * `$form_submit` (the whole form submitted) is the user's mid-form
   * preferences: which plan they picked, which checkbox they toggled,
   * which option they chose. `$change` closes that gap. The contract is
   * strict: capture the interaction, never the entered value.
   */

  function fireChange(/** @type {Element} */ el) {
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  test("select change emits $change with control_type=select and no value", () => {
    const sel = document.createElement("select");
    sel.id = "plan";
    const a = document.createElement("option");
    a.value = "sentinel-starter-xyz"; a.textContent = "Starter Tier Label";
    const b = document.createElement("option");
    b.value = "sentinel-pro-xyz"; b.textContent = "Pro Tier Label";
    sel.appendChild(a); sel.appendChild(b);
    document.body.appendChild(sel);

    const { cap, events } = makeCapture();
    cap.start();
    events.length = 0;
    sel.value = "sentinel-pro-xyz";
    fireChange(sel);

    const change = events.find((e) => e.type === "$change");
    expect(change).toBeDefined();
    expect(change?.data.properties.control_type).toBe("select");
    expect(change?.data.properties.path).toBe("/");
    expect(change?.data.fingerprint).toBeDefined();
    // Redact-at-source: the picked value and option label must not appear
    // anywhere in the event. Unique sentinels avoid collisions with
    // structural strings like "properties" or "control_type".
    const json = JSON.stringify(change?.data);
    expect(json).not.toContain("sentinel-pro-xyz");
    expect(json).not.toContain("Pro Tier Label");
  });

  test("checkbox toggle emits $change with checked=true and control_type=checkbox", () => {
    const cb = /** @type {HTMLInputElement} */ (document.createElement("input"));
    cb.type = "checkbox";
    cb.id = "agree";
    document.body.appendChild(cb);

    const { cap, events } = makeCapture();
    cap.start();
    events.length = 0;
    cb.checked = true;
    fireChange(cb);

    const change = events.find((e) => e.type === "$change");
    expect(change?.data.properties.control_type).toBe("checkbox");
    expect(change?.data.properties.checked).toBe(true);
  });

  test("radio selection emits $change with checked=true and control_type=radio", () => {
    const r = /** @type {HTMLInputElement} */ (document.createElement("input"));
    r.type = "radio";
    r.name = "tier";
    r.value = "sentinel-radio-value-zzz";
    document.body.appendChild(r);

    const { cap, events } = makeCapture();
    cap.start();
    events.length = 0;
    r.checked = true;
    fireChange(r);

    const change = events.find((e) => e.type === "$change");
    expect(change?.data.properties.control_type).toBe("radio");
    expect(change?.data.properties.checked).toBe(true);
    // The radio's `value` must not leak in any field.
    expect(JSON.stringify(change?.data)).not.toContain("sentinel-radio-value-zzz");
  });

  test("text input change emits $change with control_type=text and never the value", () => {
    const inp = /** @type {HTMLInputElement} */ (document.createElement("input"));
    inp.type = "text";
    inp.id = "email-like";
    document.body.appendChild(inp);

    const { cap, events } = makeCapture();
    cap.start();
    events.length = 0;
    inp.value = "secret-value-12345";
    fireChange(inp);

    const change = events.find((e) => e.type === "$change");
    expect(change?.data.properties.control_type).toBe("text");
    expect(JSON.stringify(change?.data)).not.toContain("secret-value-12345");
  });

  test("password input change is NEVER captured (defense in depth)", () => {
    const inp = /** @type {HTMLInputElement} */ (document.createElement("input"));
    inp.type = "password";
    document.body.appendChild(inp);

    const { cap, events } = makeCapture();
    cap.start();
    events.length = 0;
    inp.value = "hunter2";
    fireChange(inp);

    expect(events.find((e) => e.type === "$change")).toBeUndefined();
  });

  test("file input change is NEVER captured (file name would leak)", () => {
    const inp = /** @type {HTMLInputElement} */ (document.createElement("input"));
    inp.type = "file";
    document.body.appendChild(inp);

    const { cap, events } = makeCapture();
    cap.start();
    events.length = 0;
    fireChange(inp);

    expect(events.find((e) => e.type === "$change")).toBeUndefined();
  });

  test("hidden input change is NEVER captured", () => {
    const inp = /** @type {HTMLInputElement} */ (document.createElement("input"));
    inp.type = "hidden";
    inp.value = "csrf-token";
    document.body.appendChild(inp);

    const { cap, events } = makeCapture();
    cap.start();
    events.length = 0;
    fireChange(inp);

    expect(events.find((e) => e.type === "$change")).toBeUndefined();
  });

  test("checkbox inside a data-revu-mask region emits $change but withholds checked", () => {
    // The mask opts a sensitive form out of having the user's actual answer
    // reported. The interaction still counts (a control changed) but the
    // `checked` boolean (the literal yes/no) must not ride along, mirroring
    // how $form_submit drops field detail for masked forms.
    const wrap = document.createElement("div");
    wrap.setAttribute("data-revu-mask", "");
    const cb = /** @type {HTMLInputElement} */ (document.createElement("input"));
    cb.type = "checkbox";
    cb.id = "sensitive-consent";
    wrap.appendChild(cb);
    document.body.appendChild(wrap);

    const { cap, events } = makeCapture();
    cap.start();
    events.length = 0;
    cb.checked = true;
    fireChange(cb);

    const change = events.find((e) => e.type === "$change");
    expect(change).toBeDefined();
    // Structural metadata still flows (it is already in the fingerprint).
    expect(change?.data.properties.control_type).toBe("checkbox");
    // The user's actual answer must not be reported for a masked control.
    expect(change?.data.properties.checked).toBeUndefined();
  });

  test("data-revu-mask on a shadow host withholds checked for a control inside its shadow tree", () => {
    // The mask check must cross the Shadow DOM boundary, exactly like the
    // click-fingerprint redaction does, so a `data-revu-mask` on a custom-
    // element host protects controls rendered inside its shadow root.
    const host = document.createElement("div");
    host.setAttribute("data-revu-mask", "");
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: "open" });
    const cb = /** @type {HTMLInputElement} */ (document.createElement("input"));
    cb.type = "checkbox";
    shadow.appendChild(cb);

    const { cap, events } = makeCapture();
    cap.start();
    events.length = 0;
    cb.checked = true;
    cb.dispatchEvent(new Event("change", { bubbles: true, composed: true }));

    const change = events.find((e) => e.type === "$change");
    expect(change).toBeDefined();
    expect(change?.data.properties.control_type).toBe("checkbox");
    // Would leak if the mask walk stopped at the shadow boundary.
    expect(change?.data.properties.checked).toBeUndefined();
  });

  test("change on a non-form element does not emit", () => {
    const div = document.createElement("div");
    document.body.appendChild(div);

    const { cap, events } = makeCapture();
    cap.start();
    events.length = 0;
    fireChange(div);

    expect(events.find((e) => e.type === "$change")).toBeUndefined();
  });
});

describe("Capture - $page_restore on bfcache restore", () => {
  test("pageshow with persisted=true emits $page_restore with current path", () => {
    const { cap, events } = makeCapture();
    cap.start();
    events.length = 0;

    const e = new Event("pageshow");
    Object.defineProperty(e, "persisted", { value: true });
    window.dispatchEvent(e);

    const restore = events.find((ev) => ev.type === "$page_restore");
    expect(restore).toBeDefined();
    expect(restore?.data.properties.path).toBe("/");
  });

  test("pageshow with persisted=false does NOT emit $page_restore (avoids double-counting fresh loads)", () => {
    const { cap, events } = makeCapture();
    cap.start();
    events.length = 0;

    const e = new Event("pageshow");
    Object.defineProperty(e, "persisted", { value: false });
    window.dispatchEvent(e);

    expect(events.find((ev) => ev.type === "$page_restore")).toBeUndefined();
  });
});

describe("Capture - autocapture element semantics", () => {
  /**
   * The fingerprint shipped with every $autocapture click is the only thing
   * the server has to name an action and build the auto-derived feature
   * catalog. These tests pin every field that downstream classification
   * relies on so a future refactor of fingerprint.js cannot quietly drop
   * one and break Feature Adoption.
   */

  test("clicking a button captures tag, text, id, classes, and a selector", () => {
    const btn = document.createElement("button");
    btn.id = "sign-up";
    btn.classList.add("btn", "btn-primary");
    btn.textContent = "Sign up";
    document.body.appendChild(btn);

    const { cap, events } = makeCapture();
    cap.start();
    btn.click();

    const fp = events.find((e) => e.type === "$autocapture")?.data.fingerprint;
    expect(fp).toBeDefined();
    expect(fp.tag).toBe("button");
    expect(fp.text).toBe("Sign up");
    expect(fp.id).toBe("sign-up");
    expect(fp.classes).toEqual(["btn", "btn-primary"]);
    expect(fp.selector).toBe("#sign-up");
  });

  test("clicking an anchor captures the link text and tag", () => {
    const a = document.createElement("a");
    a.href = "/docs";
    a.textContent = "Read the docs";
    document.body.appendChild(a);

    const { cap, events } = makeCapture();
    cap.start();
    a.click();

    const fp = events.find((e) => e.type === "$autocapture")?.data.fingerprint;
    expect(fp).toBeDefined();
    expect(fp.tag).toBe("a");
    expect(fp.text).toBe("Read the docs");
  });

  test("captures aria-label so an icon-only button is still nameable", () => {
    const btn = document.createElement("button");
    btn.setAttribute("aria-label", "Close dialog");
    // Inner SVG icon, no visible text.
    btn.innerHTML = "<svg></svg>";
    document.body.appendChild(btn);

    const { cap, events } = makeCapture();
    cap.start();
    btn.click();

    const fp = events.find((e) => e.type === "$autocapture")?.data.fingerprint;
    expect(fp).toBeDefined();
    expect(fp.aria_label).toBe("Close dialog");
    // No visible text means the server falls back to aria-label.
    expect(fp.text).toBeUndefined();
  });

  test("captures the title attribute (used as a final-resort label)", () => {
    const a = document.createElement("a");
    a.href = "/profile";
    a.title = "View profile";
    a.innerHTML = "<svg></svg>";
    document.body.appendChild(a);

    const { cap, events } = makeCapture();
    cap.start();
    a.click();

    const fp = events.find((e) => e.type === "$autocapture")?.data.fingerprint;
    expect(fp.title).toBe("View profile");
    expect(fp.text).toBeUndefined();
  });

  test("captures the role attribute on a div-as-button", () => {
    const div = document.createElement("div");
    div.setAttribute("role", "button");
    div.textContent = "Custom button";
    document.body.appendChild(div);

    const { cap, events } = makeCapture();
    cap.start();
    div.click();

    const fp = events.find((e) => e.type === "$autocapture")?.data.fingerprint;
    expect(fp.tag).toBe("div");
    expect(fp.role).toBe("button");
    expect(fp.text).toBe("Custom button");
  });

  test("aria-label is truncated to 120 characters", () => {
    const btn = document.createElement("button");
    btn.setAttribute("aria-label", "A".repeat(200));
    document.body.appendChild(btn);

    const { cap, events } = makeCapture();
    cap.start();
    btn.click();

    const fp = events.find((e) => e.type === "$autocapture")?.data.fingerprint;
    expect(typeof fp.aria_label).toBe("string");
    expect(fp.aria_label.length).toBeLessThanOrEqual(123); // 120 + ellipsis budget
  });

  test("clicking inside a sensitive input does not capture aria-label or title", () => {
    // Defense in depth: even when a host annotates an <input> with a
    // descriptive aria-label that is itself sensitive ("Credit card number"),
    // the fingerprint must stay redacted to match the masking-at-source
    // invariant. The visible-text test in the input-masking block already
    // covers `text`; this pins the same for the two new label fields.
    const input = document.createElement("input");
    input.type = "text";
    input.setAttribute("aria-label", "Credit card number");
    input.setAttribute("title", "Enter your full card number");
    input.value = "4242 4242 4242 4242";
    document.body.appendChild(input);

    const { cap, events } = makeCapture();
    cap.start();
    input.click();

    const fp = events.find((e) => e.type === "$autocapture")?.data.fingerprint;
    expect(fp.text).toBeUndefined();
    expect(fp.aria_label).toBeUndefined();
    expect(fp.title).toBeUndefined();
  });

  test("captures the sibling ordinal so identical buttons are distinguishable", () => {
    const list = document.createElement("div");
    for (let i = 0; i < 3; i++) {
      const btn = document.createElement("button");
      btn.textContent = "Buy";
      list.appendChild(btn);
    }
    document.body.appendChild(list);

    const { cap, events } = makeCapture();
    cap.start();
    /** @type {HTMLButtonElement} */ (list.children[1]).click();

    const fp = events.find((e) => e.type === "$autocapture")?.data.fingerprint;
    expect(fp.ordinal).toBe(1);
  });

  test("clicking the inner icon of a button still fingerprints the icon, not the parent", () => {
    // The fingerprint module captures the click target verbatim; promoting
    // to the containing button is a downstream concern (link classification
    // walks anchors, but generic-element walks do not). This test pins the
    // current contract so a refactor cannot silently change it.
    const btn = document.createElement("button");
    btn.id = "save";
    const icon = document.createElement("span");
    icon.className = "icon-save";
    icon.textContent = "Save";
    btn.appendChild(icon);
    document.body.appendChild(btn);

    const { cap, events } = makeCapture();
    cap.start();
    icon.click();

    const fp = events.find((e) => e.type === "$autocapture")?.data.fingerprint;
    expect(fp.tag).toBe("span");
    expect(fp.classes).toEqual(["icon-save"]);
    // Selector walks ancestors up to the nearest id, so we still see "#save".
    expect(fp.selector).toContain("#save");
  });
});

describe("Capture - Shadow DOM", () => {
  /**
   * Component-library apps that build with Web Components (Stencil, Lit, plain
   * `customElements.define`) put their interactive elements inside Shadow DOM.
   * A document-level listener sees the click retargeted to the shadow host,
   * so without composedPath() resolution the SDK would capture the host
   * instead of the actual button. The ancestor walk in the fingerprint also
   * needs to cross the boundary so `data-revu-mask` on the host applies to
   * every internal element.
   */

  test("captures a click on a button inside an open shadow root", () => {
    const host = document.createElement("div");
    host.id = "card-host";
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: "open" });
    const btn = document.createElement("button");
    btn.id = "shadow-cta";
    btn.textContent = "Inside shadow";
    shadow.appendChild(btn);

    const { cap, events } = makeCapture();
    cap.start();
    btn.click();

    const auto = events.find((e) => e.type === "$autocapture");
    expect(auto).toBeDefined();
    const fp = auto.data.fingerprint;
    // The actual button, not the retargeted host:
    expect(fp.tag).toBe("button");
    expect(fp.text).toBe("Inside shadow");
    expect(fp.id).toBe("shadow-cta");
    expect(fp.selector).toBe("#shadow-cta");
  });

  test("data-revu-mask on the shadow host masks clicks inside its shadow tree", () => {
    const host = document.createElement("div");
    host.setAttribute("data-revu-mask", "");
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: "open" });
    const btn = document.createElement("button");
    btn.textContent = "Confidential";
    shadow.appendChild(btn);

    const { cap, events } = makeCapture();
    cap.start();
    btn.click();

    const fp = events.find((e) => e.type === "$autocapture")?.data.fingerprint;
    expect(fp).toBeDefined();
    expect(fp.tag).toBe("button");
    // Text and label fields are redacted because the host crossed the
    // mask boundary on the parent walk.
    expect(fp.text).toBeUndefined();
    expect(fp.aria_label).toBeUndefined();
    expect(fp.title).toBeUndefined();
  });

  test("selector path includes ancestors from across the shadow boundary", () => {
    // No ids anywhere so the selector builder is forced to walk multiple
    // ancestors and we can observe whether the host shows up in the path.
    const host = document.createElement("article");
    host.classList.add("card");
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: "open" });
    const wrap = document.createElement("section");
    wrap.classList.add("body");
    const btn = document.createElement("button");
    btn.classList.add("primary");
    btn.textContent = "Go";
    wrap.appendChild(btn);
    shadow.appendChild(wrap);

    const { cap, events } = makeCapture();
    cap.start();
    btn.click();

    const fp = events.find((e) => e.type === "$autocapture")?.data.fingerprint;
    expect(fp).toBeDefined();
    // The selector should at minimum include the immediate parent inside
    // the shadow tree AND the host on the light side, joined as one path.
    // Without the shadow-aware walk it would truncate at the shadow root.
    expect(fp.selector).toContain("section.body");
    expect(fp.selector).toContain("article.card");
  });
});

describe("Capture - redaction invariant: a planted value never leaves the browser", () => {
  /**
   * The highest-stakes contract: the SDK captures interactions, never the
   * content a user supplies. This is a NEGATIVE assertion, the kind that is
   * easy to under-write, so it is exercised systematically here. Each case
   * plants a unique SENTINEL into something the user provides (an input
   * value, a selected option, contenteditable text), performs the real
   * interaction, and asserts the SENTINEL appears in ZERO emitted events.
   * The invariant holds with or without masking, because values are never
   * read at all. Cases that compose across Shadow DOM run in both a light
   * and a shadow tree so a future change to the boundary walk cannot quietly
   * start leaking.
   */
  const SENTINEL = "do-not-leak-7f3a9q";

  /**
   * @typedef {object} RedactionCase
   * @property {string} name
   * @property {boolean} shadow  Whether the case is also valid inside a shadow root.
   * @property {() => { target: Element, fire: (el: Element) => void }} make
   */

  /** @type {RedactionCase[]} */
  const cases = [
    {
      name: "text input change",
      shadow: true,
      make: () => {
        const i = /** @type {HTMLInputElement} */ (document.createElement("input"));
        i.type = "text";
        i.value = SENTINEL;
        return { target: i, fire: (el) => el.dispatchEvent(new Event("change", { bubbles: true, composed: true })) };
      },
    },
    {
      name: "textarea change",
      shadow: true,
      make: () => {
        const t = /** @type {HTMLTextAreaElement} */ (document.createElement("textarea"));
        t.value = SENTINEL;
        return { target: t, fire: (el) => el.dispatchEvent(new Event("change", { bubbles: true, composed: true })) };
      },
    },
    {
      name: "select change (sentinel as option value and label)",
      shadow: true,
      make: () => {
        const s = /** @type {HTMLSelectElement} */ (document.createElement("select"));
        const o = document.createElement("option");
        o.value = SENTINEL;
        o.textContent = SENTINEL;
        s.appendChild(o);
        s.value = SENTINEL;
        return { target: s, fire: (el) => el.dispatchEvent(new Event("change", { bubbles: true, composed: true })) };
      },
    },
    {
      name: "click on a filled text input",
      shadow: true,
      make: () => {
        const i = /** @type {HTMLInputElement} */ (document.createElement("input"));
        i.type = "text";
        i.value = SENTINEL;
        return { target: i, fire: (el) => /** @type {HTMLElement} */ (el).click() };
      },
    },
    {
      name: "click on a contenteditable region",
      shadow: true,
      make: () => {
        const d = document.createElement("div");
        d.setAttribute("contenteditable", "true");
        d.textContent = SENTINEL;
        return { target: d, fire: (el) => /** @type {HTMLElement} */ (el).click() };
      },
    },
    {
      // Submit events do not compose across a shadow boundary, so the SDK
      // would never receive a shadow submit: this case is light-DOM only.
      name: "form submit with a filled field",
      shadow: false,
      make: () => {
        const f = /** @type {HTMLFormElement} */ (document.createElement("form"));
        const i = /** @type {HTMLInputElement} */ (document.createElement("input"));
        i.name = "email";
        i.type = "text";
        i.value = SENTINEL;
        f.appendChild(i);
        return { target: f, fire: (el) => el.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })) };
      },
    },
  ];

  /**
   * Mount `el` either directly in the document or inside an open shadow root.
   * @param {Element} el
   * @param {boolean} inShadow
   */
  function mount(el, inShadow) {
    if (!inShadow) {
      document.body.appendChild(el);
      return;
    }
    const host = document.createElement("div");
    document.body.appendChild(host);
    host.attachShadow({ mode: "open" }).appendChild(el);
  }

  for (const placement of /** @type {const} */ (["light DOM", "shadow DOM"])) {
    const inShadow = placement === "shadow DOM";
    for (const c of cases) {
      if (inShadow && !c.shadow) continue;
      test(`${c.name} in ${placement} never leaks the value`, () => {
        const { target, fire } = c.make();
        mount(target, inShadow);

        const { cap, events } = makeCapture();
        cap.start();
        events.length = 0;
        fire(target);

        // The interaction must actually have been observed; a zero-event run
        // would make the no-leak assertion vacuously true.
        expect(events.length).toBeGreaterThan(0);
        expect(JSON.stringify(events)).not.toContain(SENTINEL);
      });
    }
  }
});

