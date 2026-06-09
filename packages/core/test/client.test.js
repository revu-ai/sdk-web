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
    // No previous_user_id on the first identify with autoIdentify off.
    // Environment context ($user_agent, $viewport_*, ...) is merged into
    // properties on every event - assert only the identify-specific keys
    // to keep this test focused on transition semantics.
    expect(identify?.properties.previous_user_id).toBeUndefined();
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
    expect(identifies[0].properties.previous_user_id).toBeUndefined();
    expect(identifies[1].user_id).toBe("u_99");
    expect(identifies[1].properties.previous_user_id).toBe("u_42");
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
    expect(resetEvent?.properties.previous_user_id).toBe("u_42");
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

describe("RevuClient > environment context", () => {
  test("every event carries the engine-emitted context properties", () => {
    const { client, events } = makeClient();
    client.track("Custom Event");
    const e = events.find((ev) => ev.event_type === "Custom Event");
    expect(e?.properties.$user_agent).toBeDefined();
    expect(typeof e?.properties.$viewport_width).toBe("number");
    expect(typeof e?.properties.$online).toBe("boolean");
  });

  test("caller-supplied properties win over engine context on collision", () => {
    // A host that explicitly passes a $viewport_width (e.g. tracking a
    // custom virtualized layout's "logical" width) should not be silently
    // overwritten by the SDK's auto-sampled value.
    const { client, events } = makeClient();
    client.track("Custom Event", { $viewport_width: 9999, foo: "bar" });
    const e = events.find((ev) => ev.event_type === "Custom Event");
    expect(e?.properties.$viewport_width).toBe(9999);
    expect(e?.properties.foo).toBe("bar");
    // Other engine fields still ride along untouched.
    expect(e?.properties.$user_agent).toBeDefined();
  });
});

describe("RevuClient > plugins", () => {
  /**
   * Build a plugin that records every install call and exposes a custom
   * emit hook so the test can fire events through the API surface the
   * plugin actually sees.
   */
  function makePlugin(name = "test") {
    /** @type {Array<import("../src/types.js").PluginApi>} */
    const installs = [];
    return {
      installs,
      plugin: {
        name,
        /** @param {import("../src/types.js").PluginApi} api */
        install(api) { installs.push(api); },
      },
    };
  }

  test("a plugin registered before start() is installed exactly once on start", () => {
    const { client } = makeClient();
    const { plugin, installs } = makePlugin("counts-installs");
    client.use(plugin);
    expect(installs).toHaveLength(0); // queued only
    client.start();
    expect(installs).toHaveLength(1);
  });

  test("a plugin registered after start() is installed immediately", () => {
    const { client } = makeClient();
    client.start();
    const { plugin, installs } = makePlugin("late-add");
    client.use(plugin);
    expect(installs).toHaveLength(1);
  });

  test("the same plugin name registered twice is a no-op (dedup)", () => {
    const { client } = makeClient();
    const { plugin, installs } = makePlugin("dupe");
    client.start();
    client.use(plugin);
    client.use(plugin);
    client.use({ ...plugin }); // different object, same name
    expect(installs).toHaveLength(1);
  });

  test("malformed plugins are ignored (missing name or install)", () => {
    const { client } = makeClient();
    client.start();
    // None of these should throw; all should be no-ops.
    client.use(/** @type {any} */ (null));
    client.use(/** @type {any} */ ({}));
    client.use(/** @type {any} */ ({ name: "no-install" }));
    client.use(/** @type {any} */ ({ install: () => {} }));
    client.use(/** @type {any} */ ({ name: "", install: () => {} }));
    // Reach in: the installed-set should be empty because none qualified.
    expect(client._installed.size).toBe(0);
  });

  test("plugins emit events through the standard pipeline (identity + context)", () => {
    const { client, events } = makeClient();
    client.start();
    client.use({
      name: "emit-test",
      install({ record }) {
        record("plugin_emitted", { properties: { foo: "bar" } });
      },
    });

    const e = events.find((ev) => ev.event_type === "plugin_emitted");
    expect(e).toBeDefined();
    // Identity envelope is intact.
    expect(typeof e?.anonymous_id).toBe("string");
    expect(typeof e?.session_id).toBe("string");
    expect(e?.platform).toBe("web");
    // Environment context is merged in.
    expect(e?.properties.$user_agent).toBeDefined();
    // Plugin-supplied property survives the merge.
    expect(e?.properties.foo).toBe("bar");
  });

  test("plugins see the same identity object the client uses", () => {
    const { client } = makeClient();
    /** @type {import("../src/types.js").PluginApi|null} */
    let api = null;
    client.use({
      name: "identity-test",
      install(theApi) { api = theApi; },
    });
    client.start();
    expect(api).not.toBeNull();
    expect(api?.identity).toBe(client.identity);
    expect(api?.context).toBe(client.context);
    expect(api?.config).toBe(client.config);
  });
});
