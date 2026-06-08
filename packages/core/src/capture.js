/**
 * @file Autocapture - page views (incl. SPA route changes) and clicks, with
 * zero instrumentation. We capture *interactions*, never input *values*
 * (redact-at-source). The capture layer only detects; the client builds the
 * full event and attaches identity.
 */

import { fingerprint } from "./fingerprint.js";
import { routePath } from "./utils.js";

/**
 * @callback EmitFn
 * @param {string} eventType
 * @param {{ fingerprint?: import("./types.js").Fingerprint, properties?: Record<string, unknown> }} [data]
 */

export class Capture {
  /**
   * @param {EmitFn} emit
   * @param {{ maskAllInputs: boolean }} options
   */
  constructor(emit, options) {
    this.emit = emit;
    this.options = options;
    /** @type {string|undefined} */
    this.lastPath = undefined;
  }

  /** Wire up listeners and emit the initial page view. */
  start() {
    this.capturePageview();
    this.installSpaNavigation();
    if (typeof document !== "undefined") {
      document.addEventListener("click", (e) => this.onClick(e), { capture: true });
    }
  }

  /** Emit a `$pageview` for the current location. */
  capturePageview() {
    if (typeof location === "undefined") return;
    this.lastPath = routePath();
    this.emit("$pageview", {
      properties: {
        url: location.href,
        path: this.lastPath,
        referrer: typeof document !== "undefined" ? document.referrer || undefined : undefined,
        title: typeof document !== "undefined" ? document.title || undefined : undefined,
      },
    });
  }

  /**
   * Handle a click anywhere in the document (delegated).
   * @param {MouseEvent} e
   */
  onClick(e) {
    const el = /** @type {Element|null} */ (e.target);
    if (!el || el.nodeType !== 1) return;
    this.emit("$autocapture", {
      fingerprint: fingerprint(el),
      properties: { path: routePath() },
    });
  }

  /**
   * Detect SPA route changes by wrapping the History API and listening for
   * `popstate` and `hashchange`. Emits a page view whenever the route changes,
   * where the route is the pathname plus the hash so hash-router apps
   * (`/#/pricing` -> `/#/about`) and anchor navigation (`#section-1` ->
   * `#section-2`) are both observed.
   */
  installSpaNavigation() {
    if (typeof history === "undefined" || typeof addEventListener !== "function") return;
    const fire = () => {
      if (routePath() !== this.lastPath) this.capturePageview();
    };
    for (const method of /** @type {const} */ (["pushState", "replaceState"])) {
      const original = history[method];
      history[method] = function patched(/** @type {any[]} */ ...args) {
        // Forward the original arguments verbatim. The runtime tuple is
        // structurally what `pushState`/`replaceState` expect; we cast so TS
        // accepts the rest-spread into their fixed-length signature.
        const result = original.apply(this, /** @type {Parameters<typeof original>} */ (args));
        fire();
        return result;
      };
    }
    addEventListener("popstate", fire);
    addEventListener("hashchange", fire);
  }
}
