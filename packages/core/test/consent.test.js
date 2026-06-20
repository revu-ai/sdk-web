/**
 * @file Tests for the master consent opt-out switch: the standalone
 * {@link Consent} state machine (defaults and persistence) and its end-to-end
 * effect through {@link RevuClient} (an opted-out client emits nothing;
 * opting back in resumes the same visitor without clearing identity).
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { Consent } from "../src/consent.js";
import { RevuClient } from "../src/client.js";

/** A minimal in-memory Storage facade for isolating Consent from the DOM. */
function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    read: (k) => (map.has(k) ? map.get(k) : null),
    write: (k, v) => map.set(k, v),
    remove: (k) => map.delete(k),
    _map: map,
  };
}

beforeEach(() => {
  if (typeof localStorage !== "undefined") localStorage.clear();
  if (typeof document === "undefined") return;
  for (const part of document.cookie.split("; ")) {
    const name = part.split("=")[0];
    if (name) document.cookie = `${name}=; Path=/; Max-Age=0; SameSite=Lax`;
  }
});

describe("Consent > state machine", () => {
  test("defaults to opted-in with no stored preference", () => {
    const c = new Consent({ storage: memoryStorage() });
    expect(c.optedOut()).toBe(false);
  });

  test("optOut() / optIn() flip and persist the choice", () => {
    const store = memoryStorage();
    const c = new Consent({ storage: store });

    c.optOut();
    expect(c.optedOut()).toBe(true);
    expect(store.read("revu_opt_out")).toBe("1");

    c.optIn();
    expect(c.optedOut()).toBe(false);
    expect(store.read("revu_opt_out")).toBe("0");
  });

  test("a persisted opt-out is honored on the next construction", () => {
    const store = memoryStorage({ revu_opt_out: "1" });
    expect(new Consent({ storage: store }).optedOut()).toBe(true);
  });

  test("works without a storage facade (in-memory only, never throws)", () => {
    const c = new Consent();
    expect(c.optedOut()).toBe(false);
    c.optOut();
    expect(c.optedOut()).toBe(true);
  });
});

describe("RevuClient > consent gating", () => {
  /** Build a client with autocapture off so we can drive record() explicitly. */
  function makeClient() {
    /** @type {import("../src/types.js").RevuEvent[]} */
    const events = [];
    const client = new RevuClient({
      apiKey: "revu_pk_test_1234567890",
      host: "https://api.test",
      autocapture: false,
      autoIdentify: false,
      flushAt: 10_000,
      flushIntervalMs: 60_000,
      maxBatch: 50,
      maxQueue: 1000,
      debug: false,
      onEvent: (e) => events.push(e),
    });
    return { client, events };
  }

  test("opting out suppresses every event, opting back in resumes", () => {
    const { client, events } = makeClient();

    client.optOut();
    expect(client.hasOptedOut()).toBe(true);
    client.capture("while_opted_out");
    client.identify("u_1");
    client.record("$pageview", { properties: { path: "/x" } });
    expect(events.length).toBe(0);

    client.optIn();
    expect(client.hasOptedOut()).toBe(false);
    client.capture("after_opt_in");
    expect(events.map((e) => e.event_type)).toContain("after_opt_in");
  });

  test("opt-out does not clear identity: the same visitor resumes", () => {
    const { client } = makeClient();
    client.identify("u_persist");
    const anon = client.identity.anonymousId;

    client.optOut();
    client.optIn();

    expect(client.identity.userId).toBe("u_persist");
    expect(client.identity.anonymousId).toBe(anon);
  });
});
