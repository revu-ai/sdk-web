/**
 * @file Tests for the master consent opt-out switch: the standalone
 * {@link Consent} state machine (defaults and persistence) and its end-to-end
 * effect through {@link RevuClient} (an opted-out client emits nothing;
 * opting back in resumes the same visitor without clearing identity).
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { Consent, defaultConsent } from "../src/consent.js";
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
    expect(store.read("revu_consent")).toBe(
      "analytics:denied|marketing:granted|functional:granted",
    );

    c.optIn();
    expect(c.optedOut()).toBe(false);
    expect(store.read("revu_consent")).toBe(
      "analytics:granted|marketing:granted|functional:granted",
    );
  });

  test("a persisted opt-out is honored on the next construction", () => {
    const store = memoryStorage({
      revu_consent: "analytics:denied|marketing:granted|functional:granted",
    });
    expect(new Consent({ storage: store }).optedOut()).toBe(true);
  });

  test("works without a storage facade (in-memory only, never throws)", () => {
    const c = new Consent();
    expect(c.optedOut()).toBe(false);
    c.optOut();
    expect(c.optedOut()).toBe(true);
  });
});

describe("Consent > category model", () => {
  test("defaults to all categories granted", () => {
    const c = new Consent({ storage: memoryStorage() });
    expect(c.get()).toEqual({
      analytics: "granted",
      marketing: "granted",
      functional: "granted",
    });
  });

  test("set() merges a partial map and persists the full state", () => {
    const store = memoryStorage();
    const c = new Consent({ storage: store });

    c.set({ marketing: "denied" });
    expect(c.get()).toEqual({
      analytics: "granted",
      marketing: "denied",
      functional: "granted",
    });
    // analytics still granted, so capture is not suppressed.
    expect(c.optedOut()).toBe(false);
    expect(store.read("revu_consent")).toBe(
      "analytics:granted|marketing:denied|functional:granted",
    );
  });

  test("denying analytics suppresses capture; optOut/optIn are aliases", () => {
    const c = new Consent({ storage: memoryStorage() });
    c.set({ analytics: "denied" });
    expect(c.optedOut()).toBe(true);
    c.optIn();
    expect(c.optedOut()).toBe(false);
    expect(c.get().analytics).toBe("granted");
    c.optOut();
    expect(c.get().analytics).toBe("denied");
  });

  test("unknown categories and invalid values are ignored (never throws)", () => {
    const c = new Consent({ storage: memoryStorage() });
    c.set(/** @type {any} */ ({ advertising: "denied", analytics: "maybe", marketing: "denied" }));
    expect(c.get()).toEqual({
      analytics: "granted", // "maybe" ignored
      marketing: "denied", // valid
      functional: "granted",
    });
    expect("advertising" in c.get()).toBe(false);
    expect(() => c.set(/** @type {any} */ (null))).not.toThrow();
  });

  test("get() returns a copy, not the internal state", () => {
    const c = new Consent({ storage: memoryStorage() });
    const snapshot = c.get();
    snapshot.analytics = "denied";
    expect(c.get().analytics).toBe("granted");
  });

  test("a persisted category state is restored on the next construction", () => {
    const store = memoryStorage({
      revu_consent: "analytics:granted|marketing:denied|functional:denied",
    });
    expect(new Consent({ storage: store }).get()).toEqual({
      analytics: "granted",
      marketing: "denied",
      functional: "denied",
    });
  });

  test("a malformed persisted entry is skipped, defaults fill the rest", () => {
    const store = memoryStorage({ revu_consent: "marketing:denied|garbage|analytics:bogus" });
    expect(new Consent({ storage: store }).get()).toEqual({
      analytics: "granted", // bogus value -> default
      marketing: "denied",
      functional: "granted",
    });
  });

  test("defaultConsent() is the all-granted shape", () => {
    expect(defaultConsent()).toEqual({
      analytics: "granted",
      marketing: "granted",
      functional: "granted",
    });
  });
});

describe("Consent > legacy opt-out migration", () => {
  test("a legacy revu_opt_out=1 is honored as analytics denied", () => {
    const store = memoryStorage({ revu_opt_out: "1" });
    const c = new Consent({ storage: store });
    expect(c.optedOut()).toBe(true);
    expect(c.get().analytics).toBe("denied");
  });

  test("the new revu_consent key takes precedence over the legacy key", () => {
    const store = memoryStorage({
      revu_opt_out: "1",
      revu_consent: "analytics:granted|marketing:granted|functional:granted",
    });
    expect(new Consent({ storage: store }).optedOut()).toBe(false);
  });
});

describe("Consent > GPC", () => {
  test("honorGpc + gpc defaults analytics to denied with no prior choice", () => {
    const c = new Consent({ storage: memoryStorage(), honorGpc: true, gpc: true });
    expect(c.optedOut()).toBe(true);
  });

  test("gpc is ignored when honorGpc is false (the default)", () => {
    const c = new Consent({ storage: memoryStorage(), gpc: true });
    expect(c.optedOut()).toBe(false);
  });

  test("an explicit persisted grant overrides GPC", () => {
    const store = memoryStorage({
      revu_consent: "analytics:granted|marketing:granted|functional:granted",
    });
    const c = new Consent({ storage: store, honorGpc: true, gpc: true });
    expect(c.optedOut()).toBe(false);
  });

  test("a legacy explicit opt-in (revu_opt_out=0) also overrides GPC", () => {
    const store = memoryStorage({ revu_opt_out: "0" });
    const c = new Consent({ storage: store, honorGpc: true, gpc: true });
    expect(c.optedOut()).toBe(false);
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

describe("RevuClient > consent stamping + category API", () => {
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

  test("every captured event carries the current $consent state", () => {
    const { client, events } = makeClient();
    client.capture("evt_1");
    expect(events[0].properties.$consent).toEqual({
      analytics: "granted",
      marketing: "granted",
      functional: "granted",
    });
  });

  test("setConsent() updates the state stamped on subsequent events", () => {
    const { client, events } = makeClient();
    client.setConsent({ marketing: "denied" });
    expect(client.getConsent().marketing).toBe("denied");

    client.capture("after_set");
    const e = events.find((ev) => ev.event_type === "after_set");
    expect(e?.properties.$consent).toEqual({
      analytics: "granted",
      marketing: "denied",
      functional: "granted",
    });
  });

  test("denying analytics via setConsent suppresses capture", () => {
    const { client, events } = makeClient();
    client.setConsent({ analytics: "denied" });
    expect(client.hasOptedOut()).toBe(true);
    client.capture("should_not_emit");
    expect(events.length).toBe(0);
  });
});
