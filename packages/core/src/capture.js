/**
 * @file Autocapture - page views (incl. SPA route changes) and clicks, with
 * zero instrumentation. We capture *interactions*, never input *values*
 * (redact-at-source). The capture layer only detects; the client builds the
 * full event and attaches identity.
 */

import { fingerprint } from "./fingerprint.js";

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
    this.lastPath = location.pathname;
    this.emit("$pageview", {
      properties: {
        url: location.href,
        path: location.pathname,
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
      properties: { path: location.pathname },
    });
  }

  /**
   * Detect SPA route changes by wrapping the History API + `popstate`,
   * emitting a page view whenever the path changes.
   */
  installSpaNavigation() {
    if (typeof history === "undefined" || typeof addEventListener !== "function") return;
    const fire = () => {
      if (location.pathname !== this.lastPath) this.capturePageview();
    };
    for (const method of /** @type {const} */ (["pushState", "replaceState"])) {
      const original = history[method];
      history[method] = function patched(/** @type {any[]} */ ...args) {
        const result = original.apply(this, args);
        fire();
        return result;
      };
    }
    addEventListener("popstate", fire);
  }
}
