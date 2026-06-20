/**
 * @file Web Vitals - LCP, INP, CLS as `$web_vital` events on page hide.
 *
 * Pure PerformanceObserver implementation; no runtime dependency on the
 * web-vitals package or anything else. The algorithm matches Google's
 * basic definitions; finer points (CLS session windows, INP p98 across
 * a corpus) are server-side concerns once enough samples exist.
 *
 * Reporting model: collect across the page's lifetime, emit each metric
 * once on terminal lifecycle (pagehide, or visibility-hidden as a mobile
 * preempt where pagehide can be unreliable). SPA route changes do NOT
 * trigger emission - Web Vitals are still page-load metrics by spec,
 * and Google's own web-vitals library treats soft-navigation vitals as
 * experimental.
 *
 * Privacy: every value is a number with no identifying content. Vitals
 * stay in core (no opt-in package needed) because there is no PII to
 * minimize - the only knob worth exposing is "off entirely", via
 * `captureWebVitals: false`.
 */

import { safe } from "./utils.js";

/**
 * @callback EmitFn
 * @param {string} eventType
 * @param {{ properties?: Record<string, unknown> }} [data]
 */

/**
 * Captures LCP / INP / CLS via PerformanceObserver and emits one
 * `$web_vital` event per metric on terminal page lifecycle.
 */
export class Vitals {
  /** @param {EmitFn} emit */
  constructor(emit) {
    this.emit = emit;
    /** @type {number|null} Largest Contentful Paint, ms since navigation start. */
    this._lcp = null;
    /** @type {number} Cumulative Layout Shift, dimensionless score. */
    this._cls = 0;
    /** @type {number} Interaction to Next Paint, ms - worst observed event timing. */
    this._inp = 0;
    /** @type {PerformanceObserver[]} */
    this._observers = [];
    /** @type {boolean} Guard so we emit at most once even if both terminal events fire. */
    this._reported = false;
  }

  /** Subscribe to performance entries and arm the report-on-terminal hooks. */
  start() {
    if (
      typeof PerformanceObserver === "undefined" ||
      typeof window === "undefined" ||
      typeof document === "undefined"
    ) return;

    // LCP: keep the most recent largest-contentful-paint entry. The spec
    // says LCP is locked at first user input (more entries after that
    // should be ignored), but in practice the latest pre-input entry
    // is already the largest, so the simpler "last entry wins" works.
    this._observe("largest-contentful-paint", (entries) => {
      const last = entries[entries.length - 1];
      const start = /** @type {any} */ (last)?.startTime;
      if (typeof start === "number") this._lcp = start;
    });

    // INP: max event-timing duration above the observer's threshold.
    // The 40ms cutoff is the minimum the spec lets us request; setting
    // it lower would just inflate the entry stream without changing the
    // worst-case observation.
    this._observe(
      "event",
      (entries) => {
        for (const entry of entries) {
          const duration = /** @type {any} */ (entry).duration;
          if (typeof duration === "number" && duration > this._inp) {
            this._inp = duration;
          }
        }
      },
      { durationThreshold: 40 },
    );

    // CLS: accumulate non-input layout shift values. Shifts that follow
    // a recent user input are intentional UI changes triggered by the
    // interaction and excluded from CLS by spec.
    this._observe("layout-shift", (entries) => {
      for (const entry of entries) {
        const anyEntry = /** @type {any} */ (entry);
        if (anyEntry.hadRecentInput) continue;
        if (typeof anyEntry.value === "number") this._cls += anyEntry.value;
      }
    });

    const report = safe(() => this._report());
    window.addEventListener("pagehide", report);
    document.addEventListener("visibilitychange", safe(() => {
      if (document.visibilityState === "hidden") report();
    }));
  }

  /**
   * Subscribe to a single entryType with the given callback. Failures
   * (unsupported entryType on older browsers, observe rejecting
   * durationThreshold) fall through silently so the SDK still works
   * with a subset of the three metrics.
   *
   * @param {string} type
   * @param {(entries: PerformanceEntry[]) => void} callback
   * @param {Record<string, unknown>} [options]
   */
  _observe(type, callback, options = {}) {
    try {
      const observer = new PerformanceObserver(
        safe((list) => callback(list.getEntries())),
      );
      observer.observe(
        /** @type {any} */ ({ type, buffered: true, ...options }),
      );
      this._observers.push(observer);
    } catch {
      // Unsupported entryType - skip this metric, keep the others.
    }
  }

  /** Emit one `$web_vital` per metric we observed at least once. */
  _report() {
    if (this._reported) return;
    this._reported = true;
    if (this._lcp != null) {
      this.emit("$web_vital", {
        properties: { name: "LCP", value: round(this._lcp, 1), unit: "ms" },
      });
    }
    if (this._inp > 0) {
      this.emit("$web_vital", {
        properties: { name: "INP", value: round(this._inp, 1), unit: "ms" },
      });
    }
    // Emit CLS even at 0 - a zero CLS is a meaningful "perfectly stable" score.
    this.emit("$web_vital", {
      properties: { name: "CLS", value: round(this._cls, 4), unit: "score" },
    });
    for (const obs of this._observers) obs.disconnect();
    this._observers.length = 0;
  }
}

/**
 * Round to a fixed number of decimal places.
 * @param {number} n
 * @param {number} decimals
 */
function round(n, decimals) {
  const factor = Math.pow(10, decimals);
  return Math.round(n * factor) / factor;
}
