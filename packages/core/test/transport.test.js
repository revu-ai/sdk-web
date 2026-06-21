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

/** Mock `globalThis.fetch` with the given handler, returning the mock. */
function mockFetch(/** @type {() => Promise<Response>} */ handler) {
  const fn = mock(handler);
  globalThis.fetch = /** @type {any} */ (fn);
  return fn;
}

beforeEach(() => {
  // Clear durable queue so each test starts empty.
  localStorage.clear();
});

afterEach(() => {
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
    // sendBeacon receives a Blob (not a string) so the request goes out
    // with `Content-Type: application/json`; with a raw string body the
    // browser defaults to `text/plain;charset=UTF-8`, which the ingest
    // endpoint rejects.
    expect(body).toBeInstanceOf(Blob);
    expect(/** @type {Blob} */ (body).type).toBe("application/json");
    const parsed = JSON.parse(await /** @type {Blob} */ (body).text());
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

  test("installPageHideFlush() wires a 'pagehide' listener that flushes via sendBeacon", async () => {
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
    await tick();

    // pagehide path must take the beacon, NOT fetch: keepalive fetch under
    // unload is unreliable across browsers, which is why we wired beacon.
    expect(sendBeacon).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(t.queue.size()).toBe(0);
    clearInterval(t.timer ?? undefined);
  });

  test("installPageHideFlush() also flushes on 'visibilitychange -> hidden' (iOS Safari)", async () => {
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
    await tick();

    expect(sendBeacon).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(t.queue.size()).toBe(0);
    clearInterval(t.timer ?? undefined);
  });

  test("terminal signal yields when a normal fetch is mid-flight (no queue corruption)", async () => {
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
    await tick();
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
