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
 *     event until the page is reloaded. UA, language, timezone, screen,
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
   * user agent, language, timezone, screen geometry, and the URL-scoped
   * attribution fields (initial referrer + UTM / click ids). The same
   * values stamp every event until the page is reloaded - which is the
   * right semantic for campaign attribution (UTM should land on the
   * pageview AND on the click the visitor made after it, not just the
   * first event).
   * @returns {Record<string, unknown>}
   */
  _buildSessionContext() {
    /** @type {Record<string, unknown>} */
    const ctx = {};

    if (typeof navigator !== "undefined") {
      if (typeof navigator.userAgent === "string") {
        ctx.user_agent = navigator.userAgent;
      }
      if (typeof navigator.language === "string") {
        ctx.language = navigator.language;
      }
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
   * @returns {Record<string, unknown>}
   */
  build() {
    return { ...this.session, ...this._forEvent() };
  }
}
