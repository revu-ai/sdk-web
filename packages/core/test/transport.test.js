/**
 * @file DOM-based tests for the Transport: durable buffering, batch sends,
 * backoff on failure, unload-time `sendBeacon`, queue cap, and online-recovery
 * wiring. Driven by happy-dom (root `bunfig.toml` preload) so `localStorage`,
 * `navigator`, `window`, and `addEventListener` behave like a real browser.
 *
 * Time control: we never advance fake timers. Instead we assert on the
 * Transport's observable state (`failures`, `backoffUntil`, queue size) and
 * its interaction with mocked `fetch` / `navigator.sendBeacon` / dispatched
 * `online` events. This keeps the tests fast and avoids coupling to internals.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Transport } from "../src/transport.js";
import { noopFetch } from "./setup.js";

/**
 * @param {number} n
 * @returns {import("../src/types.js").RevuEvent}
 */
function makeEvent(n) {
  return /** @type {any} */ ({
    event_id: `e${n}`,
    sequence_no: n,
    event_type: "test",
    properties: {},
  });
}

/**
 * Construct a Transport with safe defaults that do NOT auto-flush on enqueue
 * unless a test explicitly raises the rate by lowering `flushAt`.
 * @param {Partial<import("../src/transport.js").TransportOptions>} [overrides]
 */
function makeTransport(overrides = {}) {
  const onEvent = mock(() => {});
  const t = new Transport({
    host: "https://api.test",
    apiKey: "k",
    flushAt: 100,
    flushIntervalMs: 60_000,
    maxBatch: 50,
    maxQueue: 1000,
    debug: false,
    onEvent,
    ...overrides,
  });
  return { t, onEvent };
}

/** Yield one macrotask so synchronously-fired `enqueue`/`flush` settle. */
function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Poll until `predicate()` is truthy, yielding a macrotask between checks, up
 * to `tries` times; returns the final result. Use it instead of a single
 * `tick()` whenever an assertion depends on an async flush having COMPLETED (a
 * beacon sent, a fetch started), so a slow CI tick does not race the check. It
 * never makes a passing case fail (the predicate holds on the first tick
 * locally). Note: this does NOT address cross-test listener leakage; that is
 * what `isolateTerminalListeners()` below is for.
 */
async function waitUntil(predicate, tries = 50) {
  for (let i = 0; i < tries; i++) {
    if (predicate()) return true;
    await tick();
  }
  return predicate();
}

/** Mock `globalThis.fetch` with the given handler, returning the mock. */
function mockFetch(/** @type {() => Promise<Response>} */ handler) {
  const fn = mock(handler);
  globalThis.fetch = /** @type {any} */ (fn);
  return fn;
}

/**
 * Isolate a terminal-flush test from listeners leaked by OTHER tests.
 *
 * `installPageHideFlush()` registers `pagehide` (on the global) and
 * `visibilitychange` (on `document`) with NO teardown - the SDK exposes no
 * unlisten API by design - so every test in this file and in others
 * (`capture.test.js`, the IIFE smoke clients, ...) that wires it leaves its
 * listener on the SHARED happy-dom window/document for the rest of the run.
 * Dispatching a terminal event then flushes every one of those stale
 * transports too, so a mocked `sendBeacon` / `fetch` is invoked once PER leaked
 * transport. That count is purely a function of how many files ran first: 1
 * locally, 9 under CI's file order - the exact `Received 9` / `Received 8`
 * failure this guards against.
 *
 * Point `addEventListener` / `dispatchEvent` (global, `window`, and `document`)
 * at fresh `EventTarget`s so only THIS test's transport is wired and only it
 * fires on dispatch. `document.visibilityState` is left untouched so the
 * visibilitychange guard still reads the value the test sets. Call the returned
 * function (the shared `afterEach` does, even on throw) to restore the globals.
 * @returns {() => void} restore
 */
function isolateTerminalListeners() {
  const win = new globalThis.EventTarget();
  const doc = new globalThis.EventTarget();
  const saved = {
    gAdd: globalThis.addEventListener,
    gDispatch: globalThis.dispatchEvent,
    wAdd: window.addEventListener,
    wDispatch: window.dispatchEvent,
    dAdd: document.addEventListener,
    dDispatch: document.dispatchEvent,
  };
  globalThis.addEventListener = win.addEventListener.bind(win);
  globalThis.dispatchEvent = win.dispatchEvent.bind(win);
  window.addEventListener = win.addEventListener.bind(win);
  window.dispatchEvent = win.dispatchEvent.bind(win);
  document.addEventListener = doc.addEventListener.bind(doc);
  document.dispatchEvent = doc.dispatchEvent.bind(doc);
  return () => {
    globalThis.addEventListener = saved.gAdd;
    globalThis.dispatchEvent = saved.gDispatch;
    window.addEventListener = saved.wAdd;
    window.dispatchEvent = saved.wDispatch;
    document.addEventListener = saved.dAdd;
    document.dispatchEvent = saved.dDispatch;
  };
}

/**
 * Set by a terminal-flush test to its `isolateTerminalListeners()` restorer;
 * the shared `afterEach` calls it so the globals are restored even if the test
 * throws mid-way.
 * @type {(() => void) | null}
 */
let restoreListeners = null;

beforeEach(() => {
  // Clear durable queue so each test starts empty.
  localStorage.clear();
});

afterEach(() => {
  // Restore any terminal-listener isolation FIRST (before touching globals), so
  // a throwing terminal-flush test cannot leak the swapped addEventListener /
  // dispatchEvent into the next test.
  if (restoreListeners) {
    restoreListeners();
    restoreListeners = null;
  }
  // Restore the hermetic no-op (NOT a captured original), so a leaked listener
  // in a later file can never reach the real happy-dom fetch. See test/setup.js.
  globalThis.fetch = /** @type {typeof fetch} */ (/** @type {unknown} */ (noopFetch));
  // sendBeacon is patched on a per-test basis below; reset to undefined so the
  // next test starts from a known state (happy-dom does not provide one).
  delete (/** @type {any} */ (navigator).sendBeacon);
});

describe("Transport", () => {
  test("enqueue queues the event and notifies onEvent", () => {
    const { t, onEvent } = makeTransport();
    t.enqueue(makeEvent(1));

    expect(t.queue.size()).toBe(1);
    expect(onEvent).toHaveBeenCalledTimes(1);
  });

  test("a throwing onEvent never propagates and the event still queues", () => {
    // onEvent is host-supplied and runs on the autocapture hot path, which is
    // not itself safe()-wrapped; a throw here must not escape the SDK.
    const { t } = makeTransport({
      onEvent: () => {
        throw new Error("host hook bug");
      },
    });
    expect(() => t.enqueue(makeEvent(1))).not.toThrow();
    expect(t.queue.size()).toBe(1);
  });

  test("flush sends a batch and commits on 2xx", async () => {
    const fetchMock = mockFetch(() => Promise.resolve(new Response("", { status: 200 })));
    const { t } = makeTransport();
    t.enqueue(makeEvent(1));
    t.enqueue(makeEvent(2));

    const ok = await t.flush();

    expect(ok).toBe(true);
    expect(t.queue.size()).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.test/v1/behavior/events");
    const body = JSON.parse(/** @type {string} */ (init.body));
    expect(body.api_key).toBe("k");
    expect(body.batch).toHaveLength(2);
    expect(body.batch[0].event_id).toBe("e1");
  });

  test("keeps batch and schedules backoff on 503", async () => {
    mockFetch(() => Promise.resolve(new Response("", { status: 503 })));
    const { t } = makeTransport();
    t.enqueue(makeEvent(1));

    const ok = await t.flush();

    expect(ok).toBe(false);
    expect(t.queue.size()).toBe(1);
    expect(t.failures).toBe(1);
    expect(t.backoffUntil).toBeGreaterThan(Date.now());
  });

  test("keeps batch and backs off on a network error (fetch rejection)", async () => {
    mockFetch(() => Promise.reject(new Error("offline")));
    const { t } = makeTransport();
    t.enqueue(makeEvent(1));

    const ok = await t.flush();

    expect(ok).toBe(false);
    expect(t.queue.size()).toBe(1);
    expect(t.failures).toBe(1);
    expect(t.backoffUntil).toBeGreaterThan(Date.now());
  });

  test("backoff blocks the next flush until it expires", async () => {
    mockFetch(() => Promise.resolve(new Response("", { status: 503 })));
    const { t } = makeTransport();
    t.enqueue(makeEvent(1));
    await t.flush();

    // Flip to success: backoff window should still block the call.
    const successFetch = mockFetch(() => Promise.resolve(new Response("", { status: 200 })));
    const ok = await t.flush();

    expect(ok).toBe(false);
    expect(successFetch).not.toHaveBeenCalled();
    expect(t.queue.size()).toBe(1);
  });

  test("hitting flushAt triggers an immediate flush", async () => {
    const fetchMock = mockFetch(() => Promise.resolve(new Response("", { status: 200 })));
    const { t } = makeTransport({ flushAt: 2 });

    t.enqueue(makeEvent(1));
    expect(fetchMock).not.toHaveBeenCalled();

    t.enqueue(makeEvent(2));
    await tick();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("uses fetch with keepalive on unload, so the send survives the page", async () => {
    const sendBeacon = mock(() => true);
    /** @type {any} */ (navigator).sendBeacon = sendBeacon;
    const fetchMock = mockFetch(() => Promise.resolve(new Response("", { status: 200 })));

    const { t } = makeTransport();
    t.enqueue(makeEvent(1));

    const ok = await t.flush(true);

    expect(ok).toBe(true);
    // sendBeacon with a non-safelisted Content-Type does not survive a
    // cross-origin unload, so it is not the delivery path any more.
    expect(sendBeacon).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.test/v1/behavior/events");
    expect(init.keepalive).toBe(true);
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body).batch).toHaveLength(1);
  });

  test("commits the unload batch only once the send is confirmed", async () => {
    // A page that survives the signal (tab switch, mobile backgrounding) does
    // see the response, and only then may the batch leave the durable queue.
    const fetchMock = mockFetch(() => Promise.resolve(new Response("", { status: 200 })));
    const { t } = makeTransport();
    t.enqueue(makeEvent(1));

    await t.flush(true);
    await waitUntil(() => t.queue.size() === 0);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(t.queue.size()).toBe(0);
  });

  test("keeps the unload batch when the send never resolves", async () => {
    // The page really went away. Nothing confirms, so nothing is dropped: the
    // batch ships on the next page load and the endpoint discards it if it
    // already landed, keyed on the client-generated event_id.
    mockFetch(() => new Promise(() => {}));
    const { t } = makeTransport();
    t.enqueue(makeEvent(1));

    await t.flush(true);

    expect(t.queue.size()).toBe(1);
  });

  test("keeps the unload batch when the endpoint rejects it", async () => {
    mockFetch(() => Promise.resolve(new Response("", { status: 503 })));
    const { t } = makeTransport();
    t.enqueue(makeEvent(1));

    await t.flush(true);
    await new Promise((r) => setTimeout(r, 5));

    expect(t.queue.size()).toBe(1);
  });

  test("never throws, and keeps the batch, if the unload send fails outright", async () => {
    mockFetch(() => Promise.reject(new Error("network gone")));
    const { t } = makeTransport();
    t.enqueue(makeEvent(1));

    await expect(t.flush(true)).resolves.toBe(true);
    await new Promise((r) => setTimeout(r, 5));
    expect(t.queue.size()).toBe(1);
  });

  test("a second terminal signal does not re-send the batch already in flight", async () => {
    // A desktop close fires both `pagehide` and `visibilitychange -> hidden`.
    // Confirmation is asynchronous, so without a guard the second signal peeks
    // and re-sends the batch the first one is still delivering.
    const fetchMock = mockFetch(() => new Promise(() => {}));
    const { t } = makeTransport();
    t.enqueue(makeEvent(1));
    t.enqueue(makeEvent(2));

    await t.flush(true);
    await t.flush(true);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(t.queue.size()).toBe(2);
  });

  test("a terminal send confirming after a normal flush drained the queue deletes nothing", async () => {
    // The real corruption case. A terminal send is unconfirmed while a normal
    // flush delivers and removes the SAME batch, so the head shifts. Removing
    // "the first N" when the terminal send finally confirms would then delete
    // whatever now sits at the head, which was never sent.
    /** @type {(v: Response) => void} */
    let confirmTerminal;
    let call = 0;
    mockFetch(() => {
      call += 1;
      if (call === 1) {
        return new Promise((resolve) => {
          confirmTerminal = () => resolve(new Response("", { status: 200 }));
        });
      }
      return Promise.resolve(new Response("", { status: 200 }));
    });
    const { t } = makeTransport();
    t.enqueue(makeEvent(1));
    t.enqueue(makeEvent(2));

    await t.flush(true); // terminal, unconfirmed
    await t.flush(); // normal flush delivers and removes the same two
    await waitUntil(() => t.queue.size() === 0);

    // The page survived and kept capturing.
    const later1 = makeEvent(3);
    const later2 = makeEvent(4);
    t.enqueue(later1);
    t.enqueue(later2);

    confirmTerminal();
    await new Promise((r) => setTimeout(r, 5));

    // The late confirmation must not touch the new events.
    expect(t.queue.peek(10)).toEqual([later1, later2]);
  });

  test("a normal flush confirming after a terminal send removed its batch deletes nothing", async () => {
    // Mirror of the case above, with the roles reversed: the terminal send
    // confirms first and removes the batch, then the normal request confirms.
    /** @type {(v: Response) => void} */
    let confirmNormal;
    /** @type {(v: Response) => void} */
    let confirmTerminal;
    let call = 0;
    mockFetch(() => {
      call += 1;
      if (call === 1) {
        return new Promise((resolve) => {
          confirmTerminal = () => resolve(new Response("", { status: 200 }));
        });
      }
      return new Promise((resolve) => {
        confirmNormal = () => resolve(new Response("", { status: 200 }));
      });
    });
    const { t } = makeTransport();
    t.enqueue(makeEvent(1));
    t.enqueue(makeEvent(2));

    await t.flush(true); // terminal, unconfirmed
    const normal = t.flush(); // normal, unconfirmed, same batch
    await waitUntil(() => t.sending);

    confirmTerminal();
    await waitUntil(() => t.queue.size() === 0);

    const later = makeEvent(3);
    t.enqueue(later);

    confirmNormal();
    await normal;

    expect(t.queue.peek(10)).toEqual([later]);
  });

  test("splits a batch that would exceed the keepalive quota, and keeps the rest", async () => {
    // maxBatch bounds a batch by event count, which says nothing about its
    // serialized size. A browser rejects a keepalive body over roughly 64 KiB
    // outright, so without a size bound the batch would be refused on every
    // attempt and wedge the queue behind it.
    const fetchMock = mockFetch(() => Promise.resolve(new Response("", { status: 200 })));
    const { t } = makeTransport({ maxBatch: 16 });
    // 16 events of ~8 KB each is ~128 KB, well over the quota.
    for (let i = 1; i <= 16; i++) {
      const e = makeEvent(i);
      e.properties = { blob: "x".repeat(8 * 1024) };
      t.enqueue(e);
    }

    await t.flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const sent = fetchMock.mock.calls[0][1];
    expect(sent.body.length).toBeLessThanOrEqual(48 * 1024);
    expect(sent.keepalive).toBe(true);
    // The events that did not fit are still queued, not dropped.
    expect(t.queue.size()).toBeGreaterThan(0);
    expect(JSON.parse(sent.body).batch.length).toBeLessThan(16);
  });

  test("drains an oversized queue across flushes instead of wedging on it", async () => {
    const fetchMock = mockFetch(() => Promise.resolve(new Response("", { status: 200 })));
    const { t } = makeTransport({ maxBatch: 16 });
    for (let i = 1; i <= 16; i++) {
      const e = makeEvent(i);
      e.properties = { blob: "x".repeat(8 * 1024) };
      t.enqueue(e);
    }

    for (let i = 0; i < 12 && t.queue.size() > 0; i++) await t.flush();

    expect(t.queue.size()).toBe(0);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
  });

  test("a single event over the quota goes out without keepalive rather than never", async () => {
    // It cannot be split. The page is alive on the normal path, so the request
    // does not need to outlive it and the quota does not apply.
    const fetchMock = mockFetch(() => Promise.resolve(new Response("", { status: 200 })));
    const { t } = makeTransport();
    const huge = makeEvent(1);
    huge.properties = { blob: "x".repeat(80 * 1024) };
    t.enqueue(huge);

    await t.flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].keepalive).toBe(false);
    expect(t.queue.size()).toBe(0);
  });

  test("the terminal path leaves an unsplittable oversized event queued", async () => {
    // A keepalive request is the only kind that outlives the page, so an event
    // that cannot use one waits for the next page load rather than firing a
    // request certain to be rejected.
    const fetchMock = mockFetch(() => Promise.resolve(new Response("", { status: 200 })));
    const { t } = makeTransport();
    const huge = makeEvent(1);
    huge.properties = { blob: "x".repeat(80 * 1024) };
    t.enqueue(huge);

    const ok = await t.flush(true);

    expect(ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(t.queue.size()).toBe(1);
  });

  test("a confirmed terminal send clears the backoff, so a backlog can drain", async () => {
    // During an outage every failed flush lengthens the backoff, up to a
    // minute. If the page then hides and the terminal send succeeds, that is
    // direct evidence the endpoint recovered; continuing to refuse normal
    // flushes would strand whatever is still queued behind the backoff.
    let healthy = false;
    mockFetch(() =>
      Promise.resolve(new Response("", { status: healthy ? 200 : 503 })),
    );
    const { t } = makeTransport({ maxBatch: 1 });
    for (let i = 1; i <= 4; i++) t.enqueue(makeEvent(i));

    // Fail a few times so a real backoff accumulates.
    await t.flush();
    await t.flush();
    expect(t.failures).toBeGreaterThan(0);
    expect(t.backoffUntil).toBeGreaterThan(Date.now());

    healthy = true;
    await t.flush(true);
    await waitUntil(() => t.failures === 0);

    expect(t.backoffUntil).toBe(0);
    // A normal flush is no longer refused, so the rest can drain.
    await t.flush();
    expect(t.queue.size()).toBeLessThan(3);
  });

  test("survives repeated hide and show cycles without stranding events", async () => {
    // Mobile backgrounding can fire the hide signal many times in a session.
    // The in-flight guard must clear each time, or every cycle after the first
    // would be a no-op and the queue would grow unbounded.
    const fetchMock = mockFetch(() => Promise.resolve(new Response("", { status: 200 })));
    const { t } = makeTransport();

    for (let cycle = 1; cycle <= 10; cycle++) {
      t.enqueue(makeEvent(cycle));
      await t.flush(true);
      await waitUntil(() => t.queue.size() === 0);
      // The guard clears a microtask after the batch is removed, so wait for
      // it rather than assuming the two land together.
      await waitUntil(() => t.terminalSending === false);
    }

    expect(fetchMock).toHaveBeenCalledTimes(10);
    expect(t.queue.size()).toBe(0);
  });

  test("a failed terminal send does not strand the guard for later cycles", async () => {
    let fail = true;
    const fetchMock = mockFetch(() =>
      fail ? Promise.reject(new Error("offline")) : Promise.resolve(new Response("", { status: 200 })),
    );
    const { t } = makeTransport();
    t.enqueue(makeEvent(1));

    await t.flush(true);
    await waitUntil(() => t.terminalSending === false);
    expect(t.queue.size()).toBe(1);

    // Connectivity returns and the page hides again.
    fail = false;
    t.enqueue(makeEvent(2));
    await t.flush(true);
    await waitUntil(() => t.queue.size() === 0);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("maxBatch caps the events sent per request and leaves the remainder queued", async () => {
    const fetchMock = mockFetch(() => Promise.resolve(new Response("", { status: 200 })));
    const { t } = makeTransport({ maxBatch: 2 });
    for (let i = 1; i <= 5; i++) t.enqueue(makeEvent(i));

    await t.flush();

    const body = JSON.parse(/** @type {string} */ (fetchMock.mock.calls[0][1].body));
    expect(body.batch).toHaveLength(2);
    expect(t.queue.size()).toBe(3);
  });

  test("start() drains a queue persisted by a previous session", async () => {
    // Pre-seed localStorage as if a prior session had left an event behind.
    localStorage.setItem("revu_event_queue", JSON.stringify([makeEvent(99)]));

    const fetchMock = mockFetch(() => Promise.resolve(new Response("", { status: 200 })));
    const { t } = makeTransport();
    expect(t.queue.size()).toBe(1); // hydrated from storage at construction

    t.start();
    await tick();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(t.queue.size()).toBe(0);
    clearInterval(t.timer ?? undefined);
  });

  test("start() wires an 'online' listener that clears backoff and flushes", async () => {
    // Set up a backoff state first by failing a flush.
    mockFetch(() => Promise.resolve(new Response("", { status: 503 })));
    const { t } = makeTransport();
    t.enqueue(makeEvent(1));
    await t.flush();
    expect(t.failures).toBe(1);
    expect(t.backoffUntil).toBeGreaterThan(Date.now());

    // Now wire the listener and flip to success.
    t.start();
    const successFetch = mockFetch(() => Promise.resolve(new Response("", { status: 200 })));
    window.dispatchEvent(new Event("online"));
    await tick();

    expect(t.failures).toBe(0);
    expect(t.backoffUntil).toBe(0);
    expect(successFetch).toHaveBeenCalled();
    expect(t.queue.size()).toBe(0);
    clearInterval(t.timer ?? undefined);
  });

  test("backoff grows exponentially with each consecutive failure", () => {
    // Test the math directly via scheduleBackoff(). The integrated flush()
    // path is covered above; here we lock in the growth curve so a future
    // regression that flattens or reverses backoff is caught.
    const { t } = makeTransport();
    /** @type {number[]} */
    const deltas = [];
    for (let i = 0; i < 6; i++) {
      const before = Date.now();
      t.scheduleBackoff();
      deltas.push(t.backoffUntil - before);
    }
    // BACKOFF_BASE_MS = 1000, doubling: 1000, 2000, 4000, 8000, 16000, 32000.
    // We allow up to +50ms of clock drift between the `before` capture and
    // the internal Date.now() inside scheduleBackoff().
    expect(deltas[0]).toBeGreaterThanOrEqual(1000);
    expect(deltas[0]).toBeLessThan(1100);
    expect(deltas[1]).toBeGreaterThanOrEqual(2000);
    expect(deltas[1]).toBeLessThan(2100);
    expect(deltas[2]).toBeGreaterThanOrEqual(4000);
    expect(deltas[3]).toBeGreaterThanOrEqual(8000);
    expect(deltas[4]).toBeGreaterThanOrEqual(16000);
    expect(deltas[5]).toBeGreaterThanOrEqual(32000);
    // Strictly monotonic up to the cap.
    for (let i = 1; i < deltas.length; i++) {
      expect(deltas[i]).toBeGreaterThan(deltas[i - 1]);
    }
  });

  test("backoff is capped at 60s (no runaway delays)", () => {
    const { t } = makeTransport();
    // Drive past the doubling curve into the cap.
    for (let i = 0; i < 12; i++) t.scheduleBackoff();
    const before = Date.now();
    t.scheduleBackoff();
    const delta = t.backoffUntil - before;
    expect(delta).toBeLessThanOrEqual(60_000);
    // Sanity: a misconfigured cap (e.g. accidental `BACKOFF_BASE_MS`) would
    // collapse this to ~1s. We want to be safely inside the 60s neighborhood.
    expect(delta).toBeGreaterThanOrEqual(59_990);
  });

  test("a successful flush after a failure resets failures and backoffUntil", async () => {
    mockFetch(() => Promise.resolve(new Response("", { status: 503 })));
    const { t } = makeTransport();
    t.enqueue(makeEvent(1));
    await t.flush();
    expect(t.failures).toBe(1);
    expect(t.backoffUntil).toBeGreaterThan(Date.now());

    // Simulate the backoff window expiring (real time would do this).
    t.backoffUntil = 0;

    mockFetch(() => Promise.resolve(new Response("", { status: 200 })));
    const ok = await t.flush();

    expect(ok).toBe(true);
    expect(t.failures).toBe(0);
    expect(t.backoffUntil).toBe(0);
    expect(t.queue.size()).toBe(0);
  });

  test("installPageHideFlush() wires a 'pagehide' listener that flushes on unload", async () => {
    // Only THIS transport's listener may fire, not the ones other tests leaked.
    restoreListeners = isolateTerminalListeners();
    const sendBeacon = mock(() => true);
    /** @type {any} */ (navigator).sendBeacon = sendBeacon;
    const fetchMock = mockFetch(() =>
      Promise.resolve(new Response("", { status: 200 })),
    );

    const { t } = makeTransport();
    // Wire listeners FIRST while the queue is empty: start() flushes on its
    // own when there is leftover data, which would otherwise take the fetch
    // path and confuse the "fetch must not be called" assertion below. The
    // pagehide listener is installed via installPageHideFlush() so the
    // client can wire it AFTER the emit-on-pagehide modules (autocapture,
    // vitals) - registration-order guarantees those modules' final events
    // are in the queue before this listener flushes.
    t.start();
    t.installPageHideFlush();
    t.enqueue(makeEvent(1));

    window.dispatchEvent(new Event("pagehide"));
    await waitUntil(() => fetchMock.mock.calls.length >= 1);

    // The pagehide path must take `fetch` with `keepalive`, NOT the beacon.
    // A beacon carrying a non-safelisted Content-Type does not survive a
    // cross-origin unload, and every customer is cross-origin; keepalive
    // fetch does survive it.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].keepalive).toBe(true);
    expect(sendBeacon).not.toHaveBeenCalled();
    await waitUntil(() => t.queue.size() === 0);
    clearInterval(t.timer ?? undefined);
  });

  test("installPageHideFlush() also flushes on 'visibilitychange -> hidden' (iOS Safari)", async () => {
    // Only THIS transport's listener may fire, not the ones other tests leaked.
    restoreListeners = isolateTerminalListeners();
    const sendBeacon = mock(() => true);
    /** @type {any} */ (navigator).sendBeacon = sendBeacon;
    const fetchMock = mockFetch(() =>
      Promise.resolve(new Response("", { status: 200 })),
    );

    const { t } = makeTransport();
    t.start();
    t.installPageHideFlush();
    t.enqueue(makeEvent(1));

    // iOS Safari often skips `pagehide` on tab close / app background;
    // `visibilitychange -> hidden` is the only reliable terminal signal there.
    // Without flushing on this event, the queued events stay stranded in
    // localStorage forever (until the user opens the page again).
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await waitUntil(() => fetchMock.mock.calls.length >= 1);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].keepalive).toBe(true);
    expect(sendBeacon).not.toHaveBeenCalled();
    await waitUntil(() => t.queue.size() === 0);
    clearInterval(t.timer ?? undefined);
  });

  test("terminal signal yields when a normal fetch is mid-flight (no queue corruption)", async () => {
    // Only THIS transport's listeners may fire: a leaked listener from a stale
    // (not-sending) transport would take the beacon path and make the
    // "sendBeacon not called" assertion below fail (Received 8 under CI).
    restoreListeners = isolateTerminalListeners();
    // Race we are guarding against: a normal `flush(false)` is mid-fetch
    // when the terminal signal fires. Without the `!this.sending` gate,
    // `flush(true)` would peek the SAME batch the fetch is sending,
    // sendBeacon-deliver it (committing N events), then the fetch returns
    // and commits another N, dropping events [N+1..2N] from the queue
    // without sending them. The gate makes the terminal flush yield to
    // the in-flight fetch; keepalive carries the fetch even after hide.
    const sendBeacon = mock(() => true);
    /** @type {any} */ (navigator).sendBeacon = sendBeacon;
    // Hold the fetch resolver so we can fire the terminal signal while
    // sending=true and observe the gating behaviour.
    /** @type {(v: Response) => void} */
    let resolveFetch;
    const fetchMock = mockFetch(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
    );

    const { t } = makeTransport();
    t.start();
    t.installPageHideFlush();
    t.enqueue(makeEvent(1));
    t.enqueue(makeEvent(2));

    // Trigger a normal flush; do not await so the fetch stays pending.
    const flushing = t.flush();
    await waitUntil(() => t.sending && fetchMock.mock.calls.length >= 1);
    expect(t.sending).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Terminal signal during the in-flight fetch: must NOT take the beacon
    // path, because that would double-commit the queue.
    window.dispatchEvent(new Event("pagehide"));
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await tick();
    expect(sendBeacon).not.toHaveBeenCalled();

    // Now let the fetch complete; it commits exactly the two events it sent.
    resolveFetch(new Response("", { status: 200 }));
    await flushing;
    expect(t.queue.size()).toBe(0);
    clearInterval(t.timer ?? undefined);
  });

  test("terminal flush is confined to the current transport despite leaked listeners (regression: CI 9x amplification)", async () => {
    const sendBeacon = mock(() => true);
    /** @type {any} */ (navigator).sendBeacon = sendBeacon;
    const fetchMock = mockFetch(() => Promise.resolve(new Response("", { status: 200 })));

    // Stand in for the pagehide listeners other tests/files leak onto the shared
    // window with no teardown (installPageHideFlush has no unlisten). Registered
    // on the REAL window BEFORE isolation, each would fire if it were reached
    // - the mechanism behind the "Received 9" CI failure. We keep references so
    // we can remove them, since the SDK cannot.
    const leaked = Array.from({ length: 8 }, () =>
      mock(() => /** @type {any} */ (navigator).sendBeacon("https://leak.invalid")),
    );
    for (const l of leaked) window.addEventListener("pagehide", l);

    restoreListeners = isolateTerminalListeners();
    const { t } = makeTransport();
    t.start();
    t.installPageHideFlush();
    t.enqueue(makeEvent(1));

    window.dispatchEvent(new Event("pagehide"));
    await waitUntil(() => fetchMock.mock.calls.length >= 1);

    // Exactly one send - this transport - not one per leaked listener. The
    // leaked listeners mark themselves via sendBeacon, which the transport no
    // longer uses, so any beacon call here means a leak was reached.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sendBeacon).not.toHaveBeenCalled();
    for (const l of leaked) expect(l).not.toHaveBeenCalled();

    clearInterval(t.timer ?? undefined);
    // Restore globals now, then remove the real-window listeners (removeEventListener
    // is not swapped by the isolation, so this reaches the real window) so nothing
    // leaks into later tests.
    restoreListeners();
    restoreListeners = null;
    for (const l of leaked) window.removeEventListener("pagehide", l);
  });

  describe("unserializable event quarantine", () => {
    test("a single poison event cannot block the queue forever", async () => {
      const fetchMock = mockFetch(() => Promise.resolve(new Response("", { status: 200 })));
      const { t } = makeTransport();

      // Two good events bracket one whose property is a circular reference,
      // which JSON.stringify cannot encode.
      const circular = /** @type {any} */ ({});
      circular.self = circular;
      t.enqueue(makeEvent(1));
      t.enqueue(/** @type {any} */ ({ ...makeEvent(2), properties: { bad: circular } }));
      t.enqueue(makeEvent(3));
      expect(t.queue.size()).toBe(3);

      // The flush must NOT throw. It drops only the poison event, then ships
      // the survivors in the same pass - so one bad event costs nothing more
      // than itself.
      let threw = false;
      let ok;
      try {
        ok = await t.flush();
      } catch {
        threw = true;
      }
      expect(threw).toBe(false);
      expect(ok).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(t.queue.size()).toBe(0);
      const body = JSON.parse(/** @type {string} */ (fetchMock.mock.calls[0][1].body));
      expect(body.batch.map((/** @type {any} */ e) => e.event_id)).toEqual(["e1", "e3"]);
    });

    test("a BigInt property is also quarantined, never thrown", async () => {
      mockFetch(() => Promise.resolve(new Response("", { status: 200 })));
      const { t } = makeTransport();
      t.enqueue(/** @type {any} */ ({ ...makeEvent(1), properties: { big: 10n } }));

      let threw = false;
      try {
        await t.flush();
      } catch {
        threw = true;
      }
      expect(threw).toBe(false);
      expect(t.queue.size()).toBe(0); // the lone poison event is dropped
    });
  });
});
