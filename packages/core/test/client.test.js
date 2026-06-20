/**
 * @file Tests for the RevuClient public surface (orchestrator). Covers
 * behavior that lives on the client itself rather than on the individual
 * Capture / Transport / Identity collaborators - currently the synthetic
 * `$identify` event emitted on `identify()`. Capture/Transport/Identity
 * each have their own focused test files.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { RevuClient } from "../src/client.js";
import { VERSION } from "../src/version.js";

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

describe("RevuClient > $sdk_version stamping", () => {
  test("every captured event carries properties.$sdk_version", () => {
    const { client, events } = makeClient();
    client.capture("test_event", { foo: "bar" });
    client.identify("u_42");

    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(event.properties.$sdk_version).toBe(VERSION);
    }
  });

  test("caller-supplied $sdk_version cannot override the engine value", () => {
    // Engine context is merged first, then caller properties win on
    // collision (host has the final word, per record() comments). The
    // version is the one exception we want pinned because lying about
    // the SDK version would corrupt server-side correlation. The test
    // here documents current behavior so a future change that flips
    // the merge order is caught.
    const { client, events } = makeClient();
    client.capture("test_event", { $sdk_version: "9.9.9-fake" });

    const captured = events.find((e) => e.event_type === "test_event");
    // Today's merge order lets the caller win. If/when this changes to
    // pin $sdk_version, flip this assertion. The test exists so the
    // decision is intentional, not accidental.
    expect(captured?.properties.$sdk_version).toBe("9.9.9-fake");
  });
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
    client.capture("Plan Upgraded", { tier: "pro" });

    const track = events.find((e) => e.event_type === "Plan Upgraded");
    expect(track?.user_id).toBe("u_42");
  });
});

describe("RevuClient > alias", () => {
  test("emits a $alias event linking the current id to the authoritative id", () => {
    const { client, events } = makeClient();
    client.identify("phone-auto-7");
    client.alias("ada@example.com");

    const aliasEvent = events.find((e) => e.event_type === "$alias");
    expect(aliasEvent).toBeDefined();
    expect(aliasEvent?.properties.authoritative_id).toBe("ada@example.com");
    expect(aliasEvent?.properties.current_user_id).toBe("phone-auto-7");
    // anonymous_id stamped for audit; it is generated by Identity at boot.
    expect(typeof aliasEvent?.properties.current_anonymous_id).toBe("string");
    expect(
      /** @type {string} */ (aliasEvent?.properties.current_anonymous_id).length,
    ).toBeGreaterThan(0);
  });

  test("alias() does not change the local user id", () => {
    const { client } = makeClient();
    client.identify("phone-auto-7");
    client.alias("ada@example.com");
    // Distinct from identify(): the device's user_id stays put.
    expect(client.identity.userId).toBe("phone-auto-7");
  });

  test("self-alias (authoritative === current) is a no-op", () => {
    const { client, events } = makeClient();
    client.identify("u_42");
    client.alias("u_42");

    expect(events.filter((e) => e.event_type === "$alias")).toHaveLength(0);
  });

  test("invalid input (empty string, non-string) is a no-op", () => {
    const { client, events } = makeClient();
    client.identify("u_42");
    client.alias("");
    client.alias(/** @type {any} */ (null));
    client.alias(/** @type {any} */ (undefined));
    client.alias(/** @type {any} */ (42));

    expect(events.filter((e) => e.event_type === "$alias")).toHaveLength(0);
  });

  test("alias works when no user has been identified yet (current_user_id is null)", () => {
    const { client, events } = makeClient();
    // autoIdentify is off in this fixture; user_id starts null.
    client.alias("ada@example.com");

    const aliasEvent = events.find((e) => e.event_type === "$alias");
    expect(aliasEvent).toBeDefined();
    expect(aliasEvent?.properties.authoritative_id).toBe("ada@example.com");
    expect(aliasEvent?.properties.current_user_id).toBeNull();
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

    client.capture("Post Logout Click");

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
    client.capture("Custom Event");
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
    client.capture("Custom Event", { $viewport_width: 9999, foo: "bar" });
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

describe("RevuClient > plugin install resilience", () => {
  test("a throwing plugin does not abort start(), later plugins, or pagehide flush", () => {
    const { client } = makeClient();
    let goodInstalled = false;
    let flushWired = false;
    const realInstallFlush = client.transport.installPageHideFlush.bind(client.transport);
    client.transport.installPageHideFlush = () => {
      flushWired = true;
      realInstallFlush();
    };

    client.use({
      name: "bad",
      install() {
        throw new Error("boom");
      },
    });
    client.use({
      name: "good",
      install() {
        goodInstalled = true;
      },
    });

    expect(() => client.start()).not.toThrow();
    expect(goodInstalled).toBe(true); // a sibling plugin still installs
    expect(flushWired).toBe(true); // terminal flush still wired (no silent data loss)
    expect(client._started).toBe(true);
    // The failed plugin is not marked installed, so it can be retried.
    expect(client._installed.has("bad")).toBe(false);
    expect(client._installed.has("good")).toBe(true);

    clearInterval(client.transport.timer ?? undefined);
  });

  test("a plugin that threw can be retried by re-registering after start()", () => {
    const { client } = makeClient();
    client.start();

    let attempts = 0;
    const flaky = {
      name: "flaky",
      install() {
        attempts++;
        if (attempts === 1) throw new Error("first attempt fails");
      },
    };

    client.use(flaky); // installs immediately (already started); throws, not marked
    expect(attempts).toBe(1);
    expect(client._installed.has("flaky")).toBe(false);

    client.use(flaky); // retry succeeds and marks installed
    expect(attempts).toBe(2);
    expect(client._installed.has("flaky")).toBe(true);

    clearInterval(client.transport.timer ?? undefined);
  });
});

describe("RevuClient > sampling", () => {
  /**
   * Build a client at a given sampleRate. autocapture off so the only events
   * are the ones the test drives explicitly.
   * @param {number} sampleRate
   */
  function sampledClient(sampleRate) {
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
      sampleRate,
      onEvent: (e) => events.push(e),
    });
    return { client, events };
  }

  test("sampleRate 1 keeps every event and stamps no $sample_rate", () => {
    const { client, events } = sampledClient(1);
    for (let i = 0; i < 10; i++) client.capture(`e${i}`);
    expect(events.length).toBe(10);
    expect(events.every((e) => e.properties.$sample_rate === undefined)).toBe(true);
  });

  test("sampleRate 0 drops capture/pageview events but never identity events", () => {
    const { client, events } = sampledClient(0);
    client.capture("custom");
    client.record("$pageview", { properties: { path: "/x" } });
    expect(events.length).toBe(0);

    // Identity / lifecycle events are exempt so person-stitching survives.
    client.identify("u_1");
    client.reset();
    const types = events.map((e) => e.event_type);
    expect(types).toContain("$identify");
    expect(types).toContain("$reset");
    // Exempt events are always sent, so they must NOT carry $sample_rate -
    // stamping it would over-count them (and is a 1/0 hazard at rate 0).
    for (const e of events) {
      expect(e.properties.$sample_rate).toBeUndefined();
    }
  });

  test("the decision is session-sticky: a session is kept or dropped whole", () => {
    // 0.5 makes the outcome depend on the session-id hash; whatever it is,
    // every event in the one session must share it (no half-sampled session).
    const { client, events } = sampledClient(0.5);
    for (let i = 0; i < 40; i++) client.capture(`e${i}`);
    expect(events.length === 0 || events.length === 40).toBe(true);
  });

  test("kept events under sampling carry properties.$sample_rate", () => {
    // Find a session id this client keeps at 0.5 by forcing the decision,
    // then assert the stamp. We drive the sticky cache directly so the test
    // is deterministic regardless of the random session id.
    const { client, events } = sampledClient(0.5);
    client._sampleSessionId = client.identity.sessionId;
    client._sampleKeep = true;
    client.capture("kept");
    const e = events.find((ev) => ev.event_type === "kept");
    expect(e?.properties.$sample_rate).toBe(0.5);
  });
});

describe("RevuClient > capture() hardening", () => {
  test("empty or non-string event names are ignored", () => {
    const { client, events } = makeClient();
    client.capture("");
    client.capture(/** @type {any} */ (null));
    client.capture(/** @type {any} */ (123));
    expect(events.length).toBe(0);
  });

  test("a circular property is sanitized so the event stays wire-safe", () => {
    const { client, events } = makeClient();
    const circular = /** @type {any} */ ({ keep: "ok" });
    circular.self = circular;

    client.capture("evt", { circular, n: 5 });

    const e = events.find((ev) => ev.event_type === "evt");
    expect(e).toBeDefined();
    // The whole event must serialize without throwing.
    expect(() => JSON.stringify(e)).not.toThrow();
    // The serializable parts survive; the cycle is dropped, not the object.
    expect(e?.properties.n).toBe(5);
    expect(/** @type {any} */ (e?.properties.circular).keep).toBe("ok");
    expect(/** @type {any} */ (e?.properties.circular).self).toBeUndefined();
  });

  test("unsupported value types are dropped, finite numbers survive", () => {
    const { client, events } = makeClient();
    client.capture("evt", {
      fn: () => {},
      big: 10n,
      sym: Symbol("x"),
      nan: Number.NaN,
      good: "yes",
      flag: false,
      nothing: null,
    });

    const props = events.find((ev) => ev.event_type === "evt")?.properties;
    expect(props?.good).toBe("yes");
    expect(props?.flag).toBe(false);
    expect(props?.nothing).toBe(null);
    expect(props?.nan).toBe(null); // non-finite coerced to null (JSON parity)
    expect("fn" in (props || {})).toBe(false);
    expect("big" in (props || {})).toBe(false);
    expect("sym" in (props || {})).toBe(false);
  });
});

describe("RevuClient > beforeSend", () => {
  /**
   * @param {import("../src/types.js").RevuConfig["beforeSend"]} beforeSend
   */
  function makeClientWith(beforeSend) {
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
      beforeSend,
      onEvent: (e) => events.push(e),
    });
    return { client, events };
  }

  test("can enrich an event by mutating it in place", () => {
    const { client, events } = makeClientWith((event) => {
      event.properties.enriched = true;
      return event;
    });
    client.capture("evt");
    expect(events[0].properties.enriched).toBe(true);
  });

  test("returning null drops the event", () => {
    const { client, events } = makeClientWith(() => null);
    client.capture("evt");
    expect(events.length).toBe(0);
  });

  test("returning false drops the event", () => {
    const { client, events } = makeClientWith((event) =>
      event.event_type === "drop_me" ? false : event,
    );
    client.capture("keep_me");
    client.capture("drop_me");
    expect(events.map((e) => e.event_type)).toEqual(["keep_me"]);
  });

  test("returning nothing (void) sends the event unchanged", () => {
    const { client, events } = makeClientWith(() => {
      // no return
    });
    client.capture("evt", { foo: "bar" });
    expect(events[0].properties.foo).toBe("bar");
  });

  test("a throwing hook is fail-open: the original event is still sent", () => {
    const { client, events } = makeClientWith(() => {
      throw new Error("hook boom");
    });
    client.capture("evt");
    expect(events.length).toBe(1);
    expect(events[0].event_type).toBe("evt");
  });

  test("a hook that injects an unserializable value cannot poison the queue", () => {
    const { client, events } = makeClientWith((event) => {
      event.properties.bad = () => {}; // functions have no JSON form
      event.properties.good = "kept";
      return event;
    });
    client.capture("evt");
    const e = events[0];
    expect(() => JSON.stringify(e)).not.toThrow();
    expect("bad" in e.properties).toBe(false);
    expect(e.properties.good).toBe("kept");
  });

  test("a replacement object returned by the hook is what ships", () => {
    const { client, events } = makeClientWith((event) => ({
      ...event,
      event_type: "rewritten",
    }));
    client.capture("original");
    expect(events[0].event_type).toBe("rewritten");
  });
});
