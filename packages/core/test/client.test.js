/**
 * @file Tests for the RevuClient public surface (orchestrator). Covers
 * behavior that lives on the client itself rather than on the individual
 * Capture / Transport / Identity collaborators - currently the synthetic
 * `$identify` event emitted on `identify()`. Capture/Transport/Identity
 * each have their own focused test files.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { RevuClient } from "../src/client.js";

/**
 * Build a client with autocapture off and a high flush threshold so the
 * tests can observe every event via `onEvent` without the transport
 * trying to hit the network or auto-batching anything.
 */
function makeClient() {
  /** @type {import("../src/types.js").RevuEvent[]} */
  const events = [];
  const client = new RevuClient({
    apiKey: "revu_pk_test_1234567890",
    host: "https://api.test",
    autocapture: false,
    // These tests focus on the explicit identify() and reset() transitions.
    // autoIdentify is exercised separately in identity.test.js; disabling it
    // here keeps the assertions on `previous_user_id` and "no identified
    // user" semantics simple and isolated from the auto-id behavior.
    autoIdentify: false,
    maskAllInputs: true,
    flushAt: 10_000,
    flushIntervalMs: 60_000,
    maxBatch: 50,
    maxQueue: 1000,
    debug: false,
    onEvent: (e) => events.push(e),
  });
  return { client, events };
}

beforeEach(() => {
  // Identity mirrors ids to both localStorage and a first-party cookie by
  // default. Wipe both so each test starts from a fresh visitor; otherwise
  // an earlier test's identify() would leak into a later test's
  // "no identified user" expectations via the cookie that beforeEach used
  // to ignore.
  if (typeof localStorage !== "undefined") localStorage.clear();
  if (typeof document === "undefined") return;
  for (const part of document.cookie.split("; ")) {
    const name = part.split("=")[0];
    if (name) document.cookie = `${name}=; Path=/; Max-Age=0; SameSite=Lax`;
  }
});

describe("RevuClient > identify", () => {
  test("emits a $identify event when called with a new userId", () => {
    const { client, events } = makeClient();
    client.identify("u_42");

    const identify = events.find((e) => e.event_type === "$identify");
    expect(identify).toBeDefined();
    expect(identify?.user_id).toBe("u_42");
    expect(identify?.properties).toEqual({});
  });

  test("repeat identify with the same userId is a no-op (no duplicate event)", () => {
    const { client, events } = makeClient();
    client.identify("u_42");
    client.identify("u_42");
    client.identify("u_42");

    const identifies = events.filter((e) => e.event_type === "$identify");
    expect(identifies).toHaveLength(1);
  });

  test("transition between userIds emits a $identify with previous_user_id", () => {
    const { client, events } = makeClient();
    client.identify("u_42");
    client.identify("u_99");

    const identifies = events.filter((e) => e.event_type === "$identify");
    expect(identifies).toHaveLength(2);
    expect(identifies[0].user_id).toBe("u_42");
    expect(identifies[0].properties).toEqual({});
    expect(identifies[1].user_id).toBe("u_99");
    expect(identifies[1].properties).toEqual({ previous_user_id: "u_42" });
  });

  test("invalid input (empty string, non-string) is a no-op", () => {
    const { client, events } = makeClient();
    client.identify("");
    client.identify(/** @type {any} */ (null));
    client.identify(/** @type {any} */ (undefined));
    client.identify(/** @type {any} */ (42));

    expect(events.filter((e) => e.event_type === "$identify")).toHaveLength(0);
    expect(client.identity.userId).toBeNull();
  });

  test("subsequent track() events carry the identified user_id", () => {
    const { client, events } = makeClient();
    client.identify("u_42");
    client.track("Plan Upgraded", { tier: "pro" });

    const track = events.find((e) => e.event_type === "Plan Upgraded");
    expect(track?.user_id).toBe("u_42");
  });
});

describe("RevuClient > reset", () => {
  test("reset() before any identify is a no-op", () => {
    const { client, events } = makeClient();
    client.reset();
    expect(events.filter((e) => e.event_type === "$reset")).toHaveLength(0);
    expect(client.identity.userId).toBeNull();
  });

  test("reset() after identify emits $reset with previous_user_id and clears identity", () => {
    const { client, events } = makeClient();
    client.identify("u_42");
    const sessionBeforeReset = client.identity.sessionId;
    const anonymousBefore = client.identity.anonymousId;

    client.reset();

    const resetEvent = events.find((e) => e.event_type === "$reset");
    expect(resetEvent).toBeDefined();
    expect(resetEvent?.properties).toEqual({ previous_user_id: "u_42" });
    // Order matters: the $reset event must carry the OLD session_id and
    // user_id so it sorts as the last event of the logged-in session,
    // not as the first event of an empty post-reset session.
    expect(resetEvent?.session_id).toBe(sessionBeforeReset);
    expect(resetEvent?.user_id).toBe("u_42");

    expect(client.identity.userId).toBeNull();
    expect(client.identity.sessionId).not.toBe(sessionBeforeReset);
    expect(client.identity.anonymousId).toBe(anonymousBefore);
  });

  test("calling reset() twice does not emit a second $reset", () => {
    const { client, events } = makeClient();
    client.identify("u_42");
    client.reset();
    client.reset();
    expect(events.filter((e) => e.event_type === "$reset")).toHaveLength(1);
  });

  test("post-reset events use the new session_id and have user_id: null", () => {
    const { client, events } = makeClient();
    client.identify("u_42");
    client.reset();
    const newSession = client.identity.sessionId;

    client.track("Post Logout Click");

    const after = events.find((e) => e.event_type === "Post Logout Click");
    expect(after?.session_id).toBe(newSession);
    expect(after?.user_id).toBeNull();
  });

  test("identify -> reset -> identify creates a fresh identified session", () => {
    const { client, events } = makeClient();
    client.identify("u_42");
    const session1 = client.identity.sessionId;
    client.reset();
    client.identify("u_42"); // same user, but it's a new login
    const session2 = client.identity.sessionId;

    // Same anonymous visitor signs in, signs out, signs back in: we
    // should see identify, $reset, identify - three identity-edge
    // events all on the same anonymousId across two sessions.
    expect(client.identity.anonymousId).toBeDefined();
    expect(session2).not.toBe(session1);

    const identifyEvents = events.filter((e) => e.event_type === "$identify");
    expect(identifyEvents).toHaveLength(2);
    expect(identifyEvents[0].session_id).toBe(session1);
    expect(identifyEvents[1].session_id).toBe(session2);
  });
});
