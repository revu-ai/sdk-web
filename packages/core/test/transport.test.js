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

/** Mock `globalThis.fetch` with the given handler, returning the mock. */
function mockFetch(/** @type {() => Promise<Response>} */ handler) {
  const fn = mock(handler);
  globalThis.fetch = /** @type {any} */ (fn);
  return fn;
}

/** Original fetch and sendBeacon, restored after each test. */
const ORIGINAL_FETCH = globalThis.fetch;

beforeEach(() => {
  // Clear durable queue so each test starts empty.
  localStorage.clear();
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
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

  test("uses sendBeacon on unload and commits on success", async () => {
    const sendBeacon = mock(() => true);
    /** @type {any} */ (navigator).sendBeacon = sendBeacon;

    const { t } = makeTransport();
    t.enqueue(makeEvent(1));

    const ok = await t.flush(true);

    expect(ok).toBe(true);
    expect(sendBeacon).toHaveBeenCalledTimes(1);
    expect(t.queue.size()).toBe(0);
    const [url, body] = sendBeacon.mock.calls[0];
    expect(url).toBe("https://api.test/v1/behavior/events");
    const parsed = JSON.parse(/** @type {string} */ (body));
    expect(parsed.batch).toHaveLength(1);
  });

  test("keeps the batch when sendBeacon refuses (returns false)", async () => {
    /** @type {any} */ (navigator).sendBeacon = () => false;
    const { t } = makeTransport();
    t.enqueue(makeEvent(1));

    const ok = await t.flush(true);

    expect(ok).toBe(false);
    expect(t.queue.size()).toBe(1);
  });

  test("never throws if sendBeacon itself throws", async () => {
    /** @type {any} */ (navigator).sendBeacon = () => {
      throw new Error("CSP block");
    };
    const { t } = makeTransport();
    t.enqueue(makeEvent(1));

    await expect(t.flush(true)).resolves.toBe(false);
    expect(t.queue.size()).toBe(1);
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
});
