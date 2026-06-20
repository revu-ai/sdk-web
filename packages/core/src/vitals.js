/**
 * @file Web Vitals - LCP, INP, CLS as `$web_vital` events on page hide.
 *
 * Pure PerformanceObserver implementation; no runtime dependency on the
 * web-vitals package or anything else. CLS uses the spec's session-window
 * model (the largest burst of layout shifts, not the lifetime sum) so the
 * reported value is canonical CLS rather than an inflated total that grows
 * unboundedly on long-lived / SPA pages. INP is reported as the worst
 * interaction latency observed, which is the spec's definition below ~50
 * interactions (the common case for a single page load); aggregating to a
 * high percentile across many page loads stays a server-side concern.
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
    /** @type {number} Cumulative Layout Shift: the largest session window seen. */
    this._cls = 0;
    /** @type {number} Running sum of the current CLS session window. */
    this._clsWindow = 0;
    /** @type {number} startTime (ms) of the first shift in the current window. */
    this._clsFirstTs = 0;
    /** @type {number} startTime (ms) of the most recent shift in the current window. */
    this._clsPrevTs = 0;
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

    // CLS: fold non-input layout shifts into session windows and keep the
    // largest. Shifts that follow a recent user input are intentional UI
    // changes triggered by the interaction and excluded from CLS by spec.
    this._observe("layout-shift", (entries) => {
      for (const entry of entries) {
        const anyEntry = /** @type {any} */ (entry);
        if (anyEntry.hadRecentInput) continue;
        if (typeof anyEntry.value !== "number") continue;
        this._addLayoutShift(
          anyEntry.value,
          typeof anyEntry.startTime === "number" ? anyEntry.startTime : 0,
        );
      }
    });

    const report = safe(() => this._report());
    window.addEventListener("pagehide", report);
    document.addEventListener("visibilitychange", safe(() => {
      if (document.visibilityState === "hidden") report();
    }));
  }

  /**
   * Fold one (already input-filtered) layout shift into the CLS
   * session-window model and keep the largest window seen.
   *
   * Per the Layout Instability spec's session-window definition, a new
   * window starts when the gap since the previous shift exceeds 1s OR the
   * current window has spanned more than 5s. CLS is the maximum window sum,
   * not the lifetime total - the lifetime sum overcounts badly on
   * long-lived and single-page-app pages where shifts accrue across many
   * unrelated interactions.
   *
   * @param {number} value  The shift's layout-shift score (positive).
   * @param {number} ts     The shift's `startTime` in ms.
   */
  _addLayoutShift(value, ts) {
    if (
      this._clsWindow !== 0 &&
      (ts - this._clsPrevTs > 1000 || ts - this._clsFirstTs > 5000)
    ) {
      // Gap or span exceeded: close the current window and open a new one.
      this._clsWindow = 0;
    }
    if (this._clsWindow === 0) this._clsFirstTs = ts;
    this._clsWindow += value;
    this._clsPrevTs = ts;
    if (this._clsWindow > this._cls) this._cls = this._clsWindow;
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
