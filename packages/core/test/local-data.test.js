/**
 * @file Tests for the `@revu-ai/core/local-data` plugin against a real
 * client and happy-dom's real localStorage and cookie jar.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { RevuClient } from "../src/client.js";
import localData from "../src/plugins/local-data.js";

/** Remove every key and cookie, so each test starts from an empty browser. */
function clearBrowser() {
  localStorage.clear();
  for (const pair of document.cookie.split(";")) {
    const name = pair.split("=")[0].trim();
    if (name) document.cookie = `${name}=; Max-Age=0; Path=/`;
  }
}

/** @param {import("../src/types.js").RevuPlugin[]} plugins */
function makeClient(plugins) {
  const client = new RevuClient(
    /** @type {any} */ ({
      apiKey: "revu_pk_test_1234567890",
      host: "https://api.test",
      autocapture: true,
      persistentStorage: "both",
      flushAt: 10_000,
      flushIntervalMs: 60_000,
      maxBatch: 50,
      maxQueue: 1000,
      plugins,
    }),
  );
  for (const plugin of plugins) client.use(plugin);
  client.start();
  return client;
}

/**
 * Every localStorage key and cookie name the SDK owns. A cookie counts only
 * while it has a value: a browser deletes one written with `Max-Age=0`, but
 * happy-dom keeps it as `name=`.
 * @returns {string[]}
 */
function revuKeys() {
  const stored = Object.keys(localStorage);
  const cookies = document.cookie
    .split(";")
    .map((p) => p.trim().split("="))
    .filter(([, value]) => value)
    .map(([name]) => name);
  return [...stored, ...cookies].filter((k) => k.startsWith("revu_"));
}

describe("local-data plugin", () => {
  beforeEach(clearBrowser);

  test("clear() removes the queue, ids and attribution, and keeps consent", () => {
    const data = localData();
    const client = makeClient([data]);
    // Enough events for several 64-event chunks, plus a chunk orphaned by
    // an earlier cleanup that removed only the index.
    for (let i = 0; i < 150; i += 1) client.capture("e", { i });
    localStorage.setItem("revu_event_queue.9", "[]");
    client.optOut();
    const before = { anon: client.identity.anonymousId, session: client.identity.sessionId };
    expect(revuKeys().filter((k) => k.startsWith("revu_event_queue.")).length).toBeGreaterThan(2);

    data.clear();

    expect(client.transport.queue.size()).toBe(0);
    expect(new Set(revuKeys())).toEqual(new Set(["revu_consent"]));
    expect(client.identity.anonymousId).not.toBe(before.anon);
    expect(client.identity.sessionId).not.toBe(before.session);
    expect(client.attribution.properties()).toEqual({});
  });

  test("the next page load finds nothing to send and stays opted out", () => {
    const data = localData();
    const client = makeClient([data]);
    for (let i = 0; i < 70; i += 1) client.capture("e", { i });
    client.optOut();
    data.clear();

    const next = makeClient([]);
    expect(next.transport.queue.size()).toBe(0);
    expect(next.consent.optedOut()).toBe(true);
  });

  test("clear() before the SDK starts is a no-op and does not throw", () => {
    expect(() => localData().clear()).not.toThrow();
  });
});
