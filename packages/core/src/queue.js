/**
 * @file PersistentQueue - a small, durable FIFO buffer of pending events,
 * backed by localStorage so captured events survive reloads, navigation, and
 * offline periods. When storage is unavailable (SSR, private mode, quota
 * exceeded) it transparently falls back to an in-memory array, so the SDK
 * still works, it just loses durability across reloads.
 *
 * Invariants:
 * - Never throws into the host page. Every storage call is guarded so a
 *   broken or full localStorage cannot bubble an exception into app code.
 * - Bounded. A hard cap with oldest-first pruning keeps the queue from
 *   filling a user's localStorage or growing without limit.
 */

/**
 * Resolve a usable Storage, or null if none is available. We probe with a
 * write+remove because some environments expose `localStorage` but throw on
 * use (Safari private mode, disabled storage, exceeded quota).
 * @returns {Storage|null}
 */
function resolveStorage() {
  try {
    if (typeof localStorage === "undefined") return null;
    const probe = "__revu_probe__";
    localStorage.setItem(probe, "1");
    localStorage.removeItem(probe);
    return localStorage;
  } catch {
    return null;
  }
}

/**
 * A durable, bounded FIFO queue of {@link import("./types.js").RevuEvent}s.
 *
 * The in-memory `items` array is always the source of truth for the current
 * session; `persist()` mirrors it to storage after every mutation so a reload
 * (or a crash) can resume from the last persisted state.
 */
export class PersistentQueue {
  /**
   * @param {object} [options]
   * @param {string} [options.key="revu_event_queue"] localStorage key.
   * @param {number} [options.max=1000] Hard cap on retained events (oldest pruned first).
   * @param {Storage|null} [options.storage] Storage to use. Omit to auto-resolve
   *   localStorage; pass `null` to force in-memory; pass a fake for tests.
   */
  constructor({ key = "revu_event_queue", max = 1000, storage } = {}) {
    this.key = key;
    this.max = max;
    /** @type {Storage|null} */
    this.storage = storage === undefined ? resolveStorage() : storage;
    /** @type {import("./types.js").RevuEvent[]} */
    this.items = [];
    this.load();
  }

  /** Hydrate `items` from storage. Corrupt or non-array data is ignored. */
  load() {
    if (!this.storage) return;
    try {
      const raw = this.storage.getItem(this.key);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) this.items = parsed;
    } catch {
      // Corrupt payload: leave items empty; the next persist() overwrites it.
    }
  }

  /**
   * Write `items` to storage. On quota errors, retry once persisting just the
   * recent half; if that still fails, give up silently. The in-memory copy is
   * never mutated by persistence: it stays the source of truth for this session
   * and remains flushable even when storage is full. Never throws.
   */
  persist() {
    if (!this.storage) return;
    try {
      this.storage.setItem(this.key, JSON.stringify(this.items));
      return;
    } catch {
      // Fall through to the half-size retry below.
    }
    try {
      const tail = this.items.slice(Math.ceil(this.items.length / 2));
      this.storage.setItem(this.key, JSON.stringify(tail));
    } catch {
      // Give up. Durability is best-effort; never crash the host over storage.
    }
  }

  /**
   * Append an event, pruning oldest events past the cap, then persist.
   * @param {import("./types.js").RevuEvent} event
   */
  add(event) {
    this.items.push(event);
    if (this.items.length > this.max) {
      // Drop oldest first: recent behavior is more valuable than stale backlog.
      this.items.splice(0, this.items.length - this.max);
    }
    this.persist();
  }

  /**
   * Return up to `n` of the oldest events WITHOUT removing them. The caller
   * sends this batch and only calls {@link commit} once the send succeeds, so a
   * failed send leaves the events safely queued for retry.
   * @param {number} n
   * @returns {import("./types.js").RevuEvent[]}
   */
  peek(n) {
    return this.items.slice(0, n);
  }

  /**
   * Remove the oldest `n` events (a successfully-sent batch) and persist.
   * @param {number} n
   */
  commit(n) {
    if (n <= 0) return;
    this.items.splice(0, n);
    this.persist();
  }

  /** @returns {number} Number of events currently queued. */
  size() {
    return this.items.length;
  }
}
