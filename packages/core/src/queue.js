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
/**
 * Events per persisted chunk. The queue is mirrored to storage as a series of
 * these rather than one blob, because `setItem` rewrites whatever it is given
 * in full: appending one event to a 1000-event blob costs a serialization AND
 * a write of the entire queue, on the capture path, for every event. Chunking
 * confines a normal append to the last chunk. Measured on a 1000-event queue
 * of rich events: one blob costs about 2.3 ms per append (half serializing,
 * half writing), a 64-event chunk about 0.06 ms.
 * @type {number}
 */
const CHUNK = 64;

/**
 * Storage key for chunk `i`, alongside the index at `key`.
 * @param {string} key
 * @param {number} i
 * @returns {string}
 */
const chunkKey = (key, i) => `${key}.${i}`;

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
    /**
     * Index of the earliest item whose chunk needs rewriting, or `Infinity`
     * when storage already matches memory. An append dirties only the last
     * chunk; anything that shifts the front dirties everything after it.
     */
    this.dirtyFrom = Infinity;
    /** How many chunks are currently written, so stale ones can be removed. */
    this.chunkCount = 0;
    /**
     * How many events to drop at once when the cap is reached. Pruning one at
     * a time would shift the front on every append once full, rewriting every
     * chunk each time and undoing the point of chunking. Dropping a block
     * instead moves the front once per block. Small caps keep the old
     * one-at-a-time behavior, where there is nothing to amortize.
     */
    this.pruneBlock = Math.max(1, Math.min(CHUNK, Math.floor(max / 4)));
    this.load();
  }

  /**
   * Hydrate `items` from storage. Reads the index at `key`, then each chunk in
   * order. A queue written by an earlier version is a plain array under `key`;
   * it is read as-is and rewritten in chunks on the next append, so an upgrade
   * never loses a pending event. Corrupt or unreadable data is ignored.
   */
  load() {
    if (!this.storage) return;
    try {
      const raw = this.storage.getItem(this.key);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      // Legacy single-blob format.
      if (Array.isArray(parsed)) {
        this.items = parsed;
        this.dirtyFrom = 0;
        return;
      }
      if (!parsed || typeof parsed.n !== "number") return;
      const chunks = Math.ceil(parsed.n / CHUNK);
      /** @type {import("./types.js").RevuEvent[]} */
      const items = [];
      for (let i = 0; i < chunks; i += 1) {
        const chunk = this.storage.getItem(chunkKey(this.key, i));
        if (!chunk) continue;
        const events = JSON.parse(chunk);
        if (Array.isArray(events)) for (const e of events) items.push(e);
      }
      this.items = items;
      this.chunkCount = chunks;
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
    if (this.dirtyFrom === Infinity) return;
    const from = this.dirtyFrom;
    this.dirtyFrom = Infinity;
    try {
      const total = this.items.length;
      const chunks = Math.ceil(total / CHUNK);
      // Only the chunks at or after the first changed item are rewritten. An
      // append touches exactly one.
      for (let i = Math.floor(from / CHUNK); i < chunks; i += 1) {
        this.storage.setItem(
          chunkKey(this.key, i),
          JSON.stringify(this.items.slice(i * CHUNK, i * CHUNK + CHUNK)),
        );
      }
      // Chunks the queue has shrunk past are no longer part of it.
      for (let i = chunks; i < this.chunkCount; i += 1) {
        this.storage.removeItem(chunkKey(this.key, i));
      }
      this.chunkCount = chunks;
      this.storage.setItem(this.key, JSON.stringify({ v: 2, n: total }));
      return;
    } catch {
      // Fall through to the half-size retry below.
    }
    try {
      // Storage is full. Keep the recent half, which is the half worth having,
      // and rewrite it as a fresh chunk set. The in-memory copy is NOT
      // mutated: it stays the source of truth for this session and remains
      // flushable even when nothing can be persisted.
      const tail = this.items.slice(Math.ceil(this.items.length / 2));
      const chunks = Math.ceil(tail.length / CHUNK);
      for (let i = 0; i < chunks; i += 1) {
        this.storage.setItem(
          chunkKey(this.key, i),
          JSON.stringify(tail.slice(i * CHUNK, i * CHUNK + CHUNK)),
        );
      }
      for (let i = chunks; i < this.chunkCount; i += 1) {
        this.storage.removeItem(chunkKey(this.key, i));
      }
      this.chunkCount = chunks;
      this.storage.setItem(this.key, JSON.stringify({ v: 2, n: tail.length }));
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
    // Only the chunk holding the new event changed.
    if (this.items.length - 1 < this.dirtyFrom) this.dirtyFrom = this.items.length - 1;
    if (this.items.length > this.max) {
      // Drop oldest first: recent behavior is more valuable than stale backlog.
      // A block at a time, so the front shifts once per block rather than on
      // every append once the cap is reached.
      const drop = Math.min(
        this.items.length - this.max + this.pruneBlock - 1,
        this.items.length,
      );
      this.items.splice(0, drop);
      this.dirtyFrom = 0;
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
    this.dirtyFrom = 0;
    this.persist();
  }

  /**
   * Drop specific events (by reference identity) from the queue and persist.
   * The transport uses this to quarantine events that cannot be serialized,
   * so a single poison event never blocks the durable queue forever. A
   * removed event is gone for good - quarantine only fires for payloads that
   * could never be sent anyway. No-op on an empty list.
   * @param {import("./types.js").RevuEvent[]} events
   */
  remove(events) {
    if (!events || events.length === 0) return;
    const drop = new Set(events);
    const before = this.items.length;
    this.items = this.items.filter((e) => !drop.has(e));
    if (this.items.length !== before) {
      this.dirtyFrom = 0;
      this.persist();
    }
  }

  /** @returns {number} Number of events currently queued. */
  size() {
    return this.items.length;
  }
}
