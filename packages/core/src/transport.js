/**
 * @file Transport - buffers events and flushes batches to the ingest endpoint.
 * Batches to spare the network; flushes on size, interval, and page-hide
 * (via `sendBeacon`, so in-flight events survive navigation/close).
 */

/**
 * @typedef {object} TransportOptions
 * @property {string} host
 * @property {string} apiKey
 * @property {number} flushAt
 * @property {number} flushIntervalMs
 * @property {boolean} debug
 * @property {(event: import("./types.js").RevuEvent) => void} onEvent
 */

export class Transport {
  /** @param {TransportOptions} options */
  constructor(options) {
    this.options = options;
    /** @type {import("./types.js").RevuEvent[]} */
    this.buffer = [];
    /** @type {ReturnType<typeof setInterval>|null} */
    this.timer = null;
    this.endpoint = `${options.host.replace(/\/$/, "")}/v1/ingest`;
  }

  /** Start the periodic flush + page-hide handler. No-op outside a browser (SSR-safe). */
  start() {
    if (typeof window === "undefined") return;
    this.timer = setInterval(() => this.flush(), this.options.flushIntervalMs);
    if (typeof addEventListener === "function") {
      // `pagehide` is the reliable "page going away" signal across browsers.
      addEventListener("pagehide", () => this.flush(true), { capture: true });
    }
  }

  /**
   * Enqueue an event; flush immediately once the batch is full.
   * @param {import("./types.js").RevuEvent} event
   */
  enqueue(event) {
    this.buffer.push(event);
    if (this.options.debug) console.debug("[REVU] event", event);
    this.options.onEvent(event);
    if (this.buffer.length >= this.options.flushAt) this.flush();
  }

  /**
   * Send the buffered batch. On page-hide uses `sendBeacon` (fire-and-forget).
   * @param {boolean} [isUnload=false]
   * @returns {Promise<boolean>}
   */
  async flush(isUnload = false) {
    if (this.buffer.length === 0) return true;
    const batch = this.buffer;
    this.buffer = [];
    const body = JSON.stringify({ api_key: this.options.apiKey, batch });

    try {
      if (isUnload && typeof navigator !== "undefined" && navigator.sendBeacon) {
        return navigator.sendBeacon(this.endpoint, body);
      }
      const res = await fetch(this.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        keepalive: true,
      });
      return res.ok;
    } catch {
      // Network failure: re-buffer so the next flush retries (never throw).
      this.buffer.unshift(...batch);
      return false;
    }
  }
}
