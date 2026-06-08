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
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => void map.set(k, String(v)),
    removeItem: (k) => void map.delete(k),
    get _size() {
      return map.size;
    },
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
