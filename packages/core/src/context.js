/**
 * @file Context - environment metadata attached to every event.
 *
 * The SDK ships only raw, lightweight signals; the server is responsible
 * for parsing the user agent into os / browser / device, IP-based geo
 * enrichment, and URL-query attribution (UTM / click ids) from the
 * captured `$pageview.properties.url`. Keeping the parsing server-side
 * is a hard requirement - the alternative (parsers shipped to the
 * client) would blow the size budget and lock the SDK to dictionaries
 * that drift over time.
 *
 * Two layers:
 *
 *   - Session-scoped: built once on construction, the same values on every
 *     event until the page is reloaded. UA, languages, timezone, screen,
 *     and the initial referrer are session-stable.
 *   - Per-event volatile: re-read on every record() call. Viewport size
 *     changes on resize, connection type can flip between cellular and
 *     wifi, online state toggles - so we sample at emission time rather
 *     than trying to observe every change.
 *
 * These fields are emitted UNPREFIXED into the event's top-level `context`
 * bucket (a sibling of `properties`), so they never collide with caller
 * `capture()` properties and downstream SQL / warehouse consumers get the
 * de-facto context-vs-properties shape. The `$`-prefix convention is gone:
 * environment lives in `context`, the event's own payload lives in `properties`.
 */

import { readGpc, scrubUrl } from "./utils.js";

/**
 * Build session-scoped context once, sample per-event context on every
 * record() call, and merge the two via {@link build}.
 */
export class Context {
  /**
   * @param {{ environment?: "production"|"staging"|"development" }} [opts]
   */
  constructor(opts = {}) {
    /** @type {Record<string, unknown>} */
    this.session = this._buildSessionContext();
    if (opts.environment) {
      this.session.environment = opts.environment;
    }
  }

  /**
   * Snapshot the values that do not change inside a single page load:
   * user agent (string plus the low-entropy client hints), languages,
   * timezone, screen geometry, the automation and navigation-type signals,
   * and the URL-scoped attribution fields (initial referrer + UTM / click
   * ids). The same
   * values stamp every event until the page is reloaded - which is the
   * right semantic for campaign attribution (UTM should land on the
   * pageview AND on the click the visitor made after it, not just the
   * first event).
   * @returns {Record<string, unknown>}
   */
  _buildSessionContext() {
    /** @type {Record<string, unknown>} */
    const ctx = {};

    // Every navigator read here and below sits inside a try/catch. These look
    // like plain property reads, but a UA-spoofing extension or privacy tool
    // can replace any of them with a getter of its own, and a badly written
    // one throws. Unguarded, that exception leaves the constructor and
    // `init()` can only contain it by failing the whole SDK: the host page
    // survives (invariant 1) but the visitor produces no analytics at all.
    // Catching here downgrades the worst case to one missing field.
    try {
      if (typeof navigator !== "undefined") {
        if (typeof navigator.userAgent === "string") ctx.user_agent = navigator.userAgent;
        if (typeof navigator.language === "string") ctx.language = navigator.language;
      }
    } catch {
      // Hostile or broken navigator getter. Skip the field, keep the SDK.
    }

    if (typeof screen !== "undefined") {
      if (typeof screen.width === "number") ctx.screen_width = screen.width;
      if (typeof screen.height === "number") ctx.screen_height = screen.height;
    }
    if (typeof window !== "undefined" && typeof window.devicePixelRatio === "number") {
      ctx.screen_pixel_ratio = window.devicePixelRatio;
    }

    try {
      ctx.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      // Very old browsers without Intl. Best-effort.
    }

    if (typeof document !== "undefined" && document.referrer) {
      // Scrub credential / PII query values from the referrer while keeping
      // its path and host (the referrer of an auth redirect can carry a
      // token or email in its query).
      ctx.initial_referrer = scrubUrl(document.referrer);
      try {
        ctx.initial_referrer_host = new URL(document.referrer).hostname;
      } catch {
        // Malformed referrer; skip the parsed host but keep the raw string.
      }
    }

    // Global Privacy Control: stamped whenever the browser advertises it, so
    // the server sees the signal regardless of whether the host opts to honor
    // it for capture (see consent.js honorGpc). Session-stable: GPC does not
    // change inside a single page load.
    const gpc = readGpc();
    if (typeof gpc === "boolean") ctx.gpc = gpc;

    // The engine-reported signals, behind the same guard. `userAgentData` is
    // read LAST because it is the property UA-spoofing extensions most often
    // replace, so a throw there costs only itself and not the fields that
    // would otherwise follow it.
    try {
      if (typeof navigator !== "undefined") {
        // navigator.webdriver: the standardized automation flag. It is true
        // under Selenium / Playwright / Puppeteer / headless Chrome and most
        // synthetic monitors, and false or absent for a real browser. Stamped
        // ONLY when true, so a genuine visit adds zero bytes (size budget) and
        // the field's presence alone is the signal. It lets the server
        // classify automated traffic that carries a human-looking user agent
        // (a headless Chrome on a normal UA string, which server-side UA
        // parsing cannot catch on its own). Session-stable, so it rides every
        // event including the first $pageview, which is what lets the server
        // pin the visitor's type correctly on first sight.
        if (navigator.webdriver === true) ctx.webdriver = true;

        // navigator.languages (the plural). An EMPTY array is the signal, a
        // long-standing headless marker, so the field is stamped even when
        // empty, unlike `webdriver`, where absence is the normal case. Low
        // entropy: the same information is already in the `Accept-Language`
        // request header. Copied out because it is a FrozenArray owned by the
        // engine; `build()` then copies again per event.
        if (Array.isArray(navigator.languages)) ctx.languages = navigator.languages.slice();

        // User-Agent Client Hints, low-entropy set. The browser ENGINE
        // generates these, so a client that sets a UA header or redefines
        // `navigator.userAgent` does not get matching hints for free. That
        // gives the server a second, independent source for the claimed
        // browser, instead of only checking a user agent string against
        // itself. Chromium 90+ and secure contexts only, so absent on Safari,
        // Firefox, and any plain-http page: read defensively and omit when
        // not there. Low entropy by definition (Chromium already sends the
        // same three values as `Sec-CH-UA` request headers), so this adds no
        // fingerprinting surface over the request itself. The high-entropy
        // set (`getHighEntropyValues`) is deliberately NOT read: it is
        // asynchronous, so it would miss the first $pageview that the server
        // pins the visitor's type from, and it is genuinely
        // fingerprinting-relevant.
        const ua = /** @type {any} */ (navigator).userAgentData;
        if (ua) {
          // Read once per page load and held as plain data. `brands` is a
          // FrozenArray the engine hands back, so it is copied out rather
          // than referenced. Contents pass through as reported, GREASE entry
          // and all: the server compares them verbatim against the UA string.
          if (Array.isArray(ua.brands)) {
            ctx.ua_brands = ua.brands.map((/** @type {any} */ b) => ({
              brand: b.brand,
              version: b.version,
            }));
          }
          if (typeof ua.mobile === "boolean") ctx.ua_mobile = ua.mobile;
          if (typeof ua.platform === "string") ctx.ua_platform = ua.platform;
        }
      }
    } catch {
      // Hostile or broken navigator getter. Keep every field already
      // collected and carry on.
    }

    // Navigation type: "navigate" | "reload" | "back_forward" | "prerender".
    // Both attribution models key off the visitor's first `$pageview` and
    // cannot otherwise tell a genuine landing from a reload or a
    // back-forward, which inflates entry pages and session starts. Read once
    // at construction: the navigation entry describes this page load and does
    // not change inside it.
    try {
      const nav = performance.getEntriesByType("navigation")[0];
      if (nav && typeof /** @type {any} */ (nav).type === "string") {
        ctx.navigation_type = /** @type {any} */ (nav).type;
      }
    } catch {
      // No Navigation Timing Level 2 entry (or no `performance` at all).
      // Best-effort.
    }

    return ctx;
  }

  /**
   * Sample the values that can change between events: viewport size
   * (resize), online state, and the effective connection type as
   * reported by Network Information API where available.
   * @returns {Record<string, unknown>}
   */
  _forEvent() {
    /** @type {Record<string, unknown>} */
    const ctx = {};

    if (typeof window !== "undefined") {
      if (typeof window.innerWidth === "number") ctx.viewport_width = window.innerWidth;
      if (typeof window.innerHeight === "number") ctx.viewport_height = window.innerHeight;
    }

    if (typeof navigator !== "undefined") {
      if (typeof navigator.onLine === "boolean") ctx.online = navigator.onLine;
      // Network Information API: present on Chromium and Edge today; absent
      // on Safari and Firefox. Read defensively.
      const conn = /** @type {any} */ (navigator).connection
        || /** @type {any} */ (navigator).mozConnection
        || /** @type {any} */ (navigator).webkitConnection;
      if (conn) {
        if (typeof conn.effectiveType === "string") ctx.connection_type = conn.effectiveType;
        if (typeof conn.downlink === "number") ctx.connection_downlink_mbps = conn.downlink;
        if (typeof conn.rtt === "number") ctx.connection_rtt_ms = conn.rtt;
        if (typeof conn.saveData === "boolean") ctx.save_data = conn.saveData;
      }
    }

    return ctx;
  }

  /**
   * Build the merged context for an event. Session values are stable
   * across the page load; volatile values are sampled fresh on each call.
   * The result is placed in the event's top-level `context` bucket by
   * `client.record()`, separate from caller `properties`.
   *
   * The spread is shallow, which is enough for every session field except
   * the two array-valued ones, `ua_brands` and `languages`. `beforeSend` is
   * documented to hand the caller an event they may mutate, and unlike
   * `properties` the context bucket is not re-sanitized afterwards, so a
   * hook that adjusted a shared array would leak that edit into every later
   * event on the page. Each event therefore gets its own copies. The cost is
   * a short slice and a two-element map, which is the scale invariant 2 is
   * content with; the alternative, arrays shared by every event on a surface
   * callers are invited to mutate, is a silent cross-event bug.
   * @returns {Record<string, unknown>}
   */
  build() {
    const ctx = { ...this.session, ...this._forEvent() };
    const brands = /** @type {{ brand: string, version: string }[]|undefined} */ (ctx.ua_brands);
    if (brands) ctx.ua_brands = brands.map((b) => ({ brand: b.brand, version: b.version }));
    const languages = /** @type {string[]|undefined} */ (ctx.languages);
    if (languages) ctx.languages = languages.slice();
    return ctx;
  }
}
