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
  // The Identity layer persists the anonymous id in localStorage so reads
  // across constructor invocations are stable. Wipe it so each test
  // starts from a fresh visitor.
  if (typeof localStorage !== "undefined") localStorage.clear();
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
