/**
 * @file Transport - durably buffers events and flushes batches to the ingest
 * endpoint. Events go through a {@link PersistentQueue} (localStorage-backed),
 * so they survive reloads, navigation, and offline periods. Batches flush on
 * size, on an interval, when connectivity returns (`online`), and on page-hide
 * (`sendBeacon`, so in-flight events survive navigation/close). Failed sends
 * stay queued and retry with exponential backoff, so 429/503/offline degrade
 * gracefully with no data loss (corpus Ingest-Security 4, SDK-Engineering 2.5).
 */

import { PersistentQueue } from "./queue.js";

/**
 * @typedef {object} TransportOptions
 * @property {string} host
 * @property {string} apiKey
 * @property {number} flushAt              Queue size that triggers an immediate flush.
 * @property {number} flushIntervalMs      Periodic flush cadence.
 * @property {number} maxBatch             Max events sent per request (bounds body size).
 * @property {number} maxQueue             Hard cap on durably-queued events (oldest pruned).
 * @property {boolean} debug
 * @property {(event: import("./types.js").RevuEvent) => void} onEvent
 */

const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 60000;

export class Transport {
  /** @param {TransportOptions} options */
  constructor(options) {
    this.options = options;
    this.queue = new PersistentQueue({ key: "revu_event_queue", max: options.maxQueue });
    /** @type {ReturnType<typeof setInterval>|null} */
    this.timer = null;
    /** Guards against overlapping flushes (interval vs. size-triggered). */
    this.sending = false;
    /** Consecutive failures, for exponential backoff. */
    this.failures = 0;
    /** Epoch ms before which we should not attempt a network flush. */
    this.backoffUntil = 0;
    // Provisional ingest path. Namespaced under a future `modules/behavior/`
    // (REVU mounts modules under the `/v1` group), kept distinct from the
    // existing scraping `ingestion` routes. Finalize this when the server route
    // is built; the production edge may also front it with an `/api` prefix.
    this.endpoint = `${options.host.replace(/\/$/, "")}/v1/behavior/events`;
  }

  /**
   * Start the periodic flush, connectivity, and page-hide handlers, and drain
   * any events left over from a previous session. No-op outside a browser
   * (SSR-safe).
   */
  start() {
    if (typeof window === "undefined") return;
    this.timer = setInterval(() => this.flush(), this.options.flushIntervalMs);
    if (typeof addEventListener === "function") {
      // `pagehide` is the reliable "page going away" signal across browsers.
      addEventListener("pagehide", () => this.flush(true), { capture: true });
      // Retry the moment connectivity returns.
      addEventListener("online", () => {
        this.failures = 0;
        this.backoffUntil = 0;
        this.flush();
      });
    }
    // Flush events persisted by a previous session.
    if (this.queue.size() > 0) this.flush();
  }

  /**
   * Durably enqueue an event; flush immediately once the batch threshold is hit.
   * @param {import("./types.js").RevuEvent} event
   */
  enqueue(event) {
    this.queue.add(event);
    if (this.options.debug) console.debug("[REVU] event", event);
    this.options.onEvent(event);
    if (this.queue.size() >= this.options.flushAt) this.flush();
  }

  /**
   * Send the oldest batch. The batch is only removed from the durable queue
   * once the send succeeds, so failures (network, 429, 503) leave events queued
   * for the next attempt. On page-hide uses `sendBeacon` (fire-and-forget).
   * @param {boolean} [isUnload=false]
   * @returns {Promise<boolean>}
   */
  async flush(isUnload = false) {
    if (this.queue.size() === 0) return true;
    // Respect backoff on normal flushes; an unload flush always tries (last chance).
    if (!isUnload && (this.sending || Date.now() < this.backoffUntil)) return false;

    const batch = this.queue.peek(this.options.maxBatch);
    if (batch.length === 0) return true;
    const body = JSON.stringify({ api_key: this.options.apiKey, batch });

    if (
      isUnload &&
      typeof navigator !== "undefined" &&
      typeof navigator.sendBeacon === "function"
    ) {
      // Fire-and-forget on unload; if the browser accepts it, drop the batch.
      const queued = safeBeacon(navigator, this.endpoint, body);
      if (queued) this.queue.commit(batch.length);
      return queued;
    }

    this.sending = true;
    try {
      const res = await fetch(this.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        keepalive: true,
      });
      if (res.ok) {
        this.queue.commit(batch.length);
        this.failures = 0;
        this.backoffUntil = 0;
        return true;
      }
      // Non-2xx (e.g. 429/503): keep the batch and back off.
      this.scheduleBackoff();
      return false;
    } catch {
      // Network failure: keep the batch queued and back off (never throw).
      this.scheduleBackoff();
      return false;
    } finally {
      this.sending = false;
    }
  }

  /** Grow the retry delay exponentially (capped), so retries do not hammer a struggling endpoint. */
  scheduleBackoff() {
    this.failures += 1;
    const delay = Math.min(BACKOFF_BASE_MS * 2 ** (this.failures - 1), BACKOFF_MAX_MS);
    this.backoffUntil = Date.now() + delay;
  }
}

/**
 * `sendBeacon` can throw in some browsers (e.g. blocked by a CSP connect-src);
 * wrap it so a failure never propagates into the unloading host page.
 * @param {Navigator} nav
 * @param {string} url
 * @param {string} body
 * @returns {boolean}
 */
function safeBeacon(nav, url, body) {
  try {
    return nav.sendBeacon(url, body);
  } catch {
    return false;
  }
}
