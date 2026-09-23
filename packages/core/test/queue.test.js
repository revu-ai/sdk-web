/**
 * @file Unit tests for the PersistentQueue. Storage is injected (a small fake)
 * so these run without a DOM or real localStorage (under `bun test`).
 */

import { describe, expect, test } from "bun:test";
import { PersistentQueue } from "../src/queue.js";

/** A minimal in-memory Storage stand-in for tests. */
function fakeStorage() {
  /** @type {Map<string, string>} */
  const map = new Map();
  const stats = { writes: 0, bytes: 0 };
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => {
      stats.writes += 1;
      stats.bytes += String(v).length;
      map.set(k, String(v));
    },
    removeItem: (k) => void map.delete(k),
    get _size() {
      return map.size;
    },
    /** Test-only: counts what persistence actually costs. */
    _stats: stats,
    _keys: () => [...map.keys()],
  };
}

/** @param {number} n */
function ev(n) {
  return /** @type {any} */ ({ event_id: `e${n}`, sequence_no: n });
}

describe("PersistentQueue", () => {
  test("falls back to in-memory when storage is null (SSR-safe)", () => {
    const q = new PersistentQueue({ storage: null });
    q.add(ev(1));
    expect(q.size()).toBe(1);
    expect(q.peek(10)).toHaveLength(1);
  });

  test("persists across instances sharing storage (survives reload)", () => {
    const storage = fakeStorage();
    const a = new PersistentQueue({ storage, key: "k" });
    a.add(ev(1));
    a.add(ev(2));

    const b = new PersistentQueue({ storage, key: "k" });
    expect(b.size()).toBe(2);
    expect(b.peek(2).map((e) => e.event_id)).toEqual(["e1", "e2"]);
  });

  test("peek does not remove; commit removes oldest-first", () => {
    const q = new PersistentQueue({ storage: fakeStorage() });
    q.add(ev(1));
    q.add(ev(2));
    q.add(ev(3));
    const batch = q.peek(2);
    expect(batch.map((e) => e.event_id)).toEqual(["e1", "e2"]);
    expect(q.size()).toBe(3); // peek left them in place
    q.commit(2);
    expect(q.size()).toBe(1);
    expect(q.peek(1)[0].event_id).toBe("e3");
  });

  test("bounds size by pruning oldest past max", () => {
    const q = new PersistentQueue({ storage: fakeStorage(), max: 3 });
    for (let i = 1; i <= 5; i++) q.add(ev(i));
    expect(q.size()).toBe(3);
    expect(q.peek(3).map((e) => e.event_id)).toEqual(["e3", "e4", "e5"]);
  });

  test("never throws when storage.setItem throws (quota)", () => {
    const throwing = {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: () => {},
    };
    const q = new PersistentQueue({ storage: /** @type {any} */ (throwing) });
    expect(() => q.add(ev(1))).not.toThrow();
    expect(q.size()).toBe(1); // in-memory copy still intact
  });

  test("ignores corrupt persisted data", () => {
    const storage = fakeStorage();
    storage.setItem("k", "{not json");
    const q = new PersistentQueue({ storage, key: "k" });
    expect(q.size()).toBe(0);
  });
});

describe("PersistentQueue > chunked persistence", () => {
  test("an append rewrites one chunk, not the whole queue", () => {
    const storage = fakeStorage();
    const q = new PersistentQueue({ storage, key: "k", max: 1000 });
    // Fill well past a chunk boundary so a whole-queue write would be obvious.
    for (let i = 0; i < 500; i++) q.add(ev(i));

    storage._stats.writes = 0;
    storage._stats.bytes = 0;
    q.add(ev(500));

    // One chunk plus the index, and the bytes written are a chunk's worth
    // rather than the whole 501-event queue.
    expect(storage._stats.writes).toBe(2);
    const wholeQueueBytes = JSON.stringify(q.items).length;
    expect(storage._stats.bytes).toBeLessThan(wholeQueueBytes / 5);
  });

  test("survives a reload with every event intact and in order", () => {
    const storage = fakeStorage();
    const a = new PersistentQueue({ storage, key: "k", max: 1000 });
    for (let i = 0; i < 300; i++) a.add(ev(i));

    const b = new PersistentQueue({ storage, key: "k", max: 1000 });
    expect(b.size()).toBe(300);
    expect(b.peek(300).map((e) => e.sequence_no)).toEqual(a.items.map((e) => e.sequence_no));
  });

  test("reads a queue written by the previous single-blob format", () => {
    // An upgrade must not lose events that were pending under the old layout.
    const storage = fakeStorage();
    storage.setItem("k", JSON.stringify([ev(1), ev(2), ev(3)]));

    const q = new PersistentQueue({ storage, key: "k", max: 1000 });
    expect(q.size()).toBe(3);
    expect(q.peek(3).map((e) => e.sequence_no)).toEqual([1, 2, 3]);

    // And the next append rewrites it in the new layout without loss.
    q.add(ev(4));
    const reloaded = new PersistentQueue({ storage, key: "k", max: 1000 });
    expect(reloaded.peek(4).map((e) => e.sequence_no)).toEqual([1, 2, 3, 4]);
  });

  test("drops a block at the cap, and never exceeds it", () => {
    const storage = fakeStorage();
    const max = 200;
    const q = new PersistentQueue({ storage, key: "k", max });
    for (let i = 0; i < 400; i++) {
      q.add(ev(i));
      expect(q.size()).toBeLessThanOrEqual(max);
    }
    // Oldest-first pruning: the newest event is always retained.
    expect(q.items[q.items.length - 1].sequence_no).toBe(399);
    // And the survivors are still contiguous and in order.
    const seqs = q.items.map((e) => e.sequence_no);
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBe(seqs[i - 1] + 1);
  });

  test("a pruned queue reloads exactly as it stood in memory", () => {
    const storage = fakeStorage();
    const q = new PersistentQueue({ storage, key: "k", max: 200 });
    for (let i = 0; i < 500; i++) q.add(ev(i));

    const reloaded = new PersistentQueue({ storage, key: "k", max: 200 });
    expect(reloaded.items.map((e) => e.sequence_no)).toEqual(q.items.map((e) => e.sequence_no));
  });

  test("removes stale chunk keys as the queue shrinks", () => {
    const storage = fakeStorage();
    const q = new PersistentQueue({ storage, key: "k", max: 1000 });
    for (let i = 0; i < 300; i++) q.add(ev(i));
    const keysWhenFull = storage._keys().length;

    q.commit(290);

    expect(storage._keys().length).toBeLessThan(keysWhenFull);
    const reloaded = new PersistentQueue({ storage, key: "k", max: 1000 });
    expect(reloaded.size()).toBe(10);
  });

  test("keeps the in-memory queue flushable when storage is full", () => {
    // The whole point of the fallback: durability degrades, capture does not.
    const storage = fakeStorage();
    const q = new PersistentQueue({ storage, key: "k", max: 1000 });
    for (let i = 0; i < 100; i++) q.add(ev(i));
    storage.setItem = () => {
      throw new Error("QuotaExceededError");
    };

    expect(() => q.add(ev(100))).not.toThrow();
    expect(q.size()).toBe(101);
    expect(q.peek(101)).toHaveLength(101);
  });
});
