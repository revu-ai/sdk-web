/**
 * @file Tests for the Attention layer - the engagement clock plus the four
 * lifecycle events ($tab_hidden, $tab_visible, $idle, $active) and the
 * pageview-to-pageview flushAndReset contract.
 *
 * Time-sensitive tests use short idleTimeoutMs (10-50ms) and real timers
 * via `await new Promise(setTimeout, ...)`; that is plenty fast for the
 * test runner and avoids the complexity of installing a fake clock.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Attention } from "../src/attention.js";

/**
 * @typedef {{ type: string, properties: any }} CapturedEvent
 */

/** @type {Array<() => void>} */
const visibilityRestorers = [];

beforeEach(() => {
  // happy-dom defaults document.visibilityState to "visible"; tests below
  // sometimes stub it to "hidden" for one assertion. Make sure each test
  // starts from "visible" so state leakage between tests cannot mask bugs.
  forceVisibility("visible");
});

afterEach(() => {
  while (visibilityRestorers.length) visibilityRestorers.pop()?.();
});

function forceVisibility(/** @type {"visible"|"hidden"} */ state) {
  const original = Object.getOwnPropertyDescriptor(Document.prototype, "visibilityState");
  Object.defineProperty(document, "visibilityState", { configurable: true, value: state });
  visibilityRestorers.push(() => {
    if (original) Object.defineProperty(document, "visibilityState", original);
    else delete (/** @type {any} */ (document).visibilityState);
  });
}

/**
 * Build an Attention instance whose emitted events go to a local array.
 * @param {object} [options]
 * @returns {{ attn: Attention, events: CapturedEvent[] }}
 */
function makeAttention(options = {}) {
  /** @type {CapturedEvent[]} */
  const events = [];
  const attn = new Attention(
    (type, data) => events.push({ type, properties: data?.properties }),
    { idleTimeoutMs: 60_000, captureAttention: true, ...options },
  );
  return { attn, events };
}

const sleep = (/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe("Attention > engagement clock", () => {
  test("ticks while the tab is visible", async () => {
    const { attn } = makeAttention();
    attn.start();
    await sleep(30);
    const ms = attn.engagementTimeMs();
    expect(ms).toBeGreaterThanOrEqual(25);
    expect(ms).toBeLessThan(200);
  });

  test("pauses while the tab is hidden", async () => {
    const { attn } = makeAttention();
    attn.start();
    await sleep(20);
    forceVisibility("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    const banked = attn.engagementTimeMs();
    await sleep(50);
    // The clock does not advance while hidden.
    expect(attn.engagementTimeMs()).toBe(banked);
  });

  test("resumes after the tab becomes visible again", async () => {
    const { attn } = makeAttention();
    attn.start();
    await sleep(20);
    forceVisibility("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    const banked = attn.engagementTimeMs();
    forceVisibility("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await sleep(20);
    expect(attn.engagementTimeMs()).toBeGreaterThan(banked);
  });

  test("keeps ticking while the user is idle (idle is a signal, not a clock pause)", async () => {
    // Industry convention (GA4 / PostHog / Mixpanel) treats engagement as
    // visible wall-clock time. Idle is emitted as a separate behavioral
    // signal and does NOT subtract from engagement, otherwise a user who
    // reads a long article silently would look unengaged.
    const { attn } = makeAttention({ idleTimeoutMs: 15 });
    attn.start();
    await sleep(30); // exceeds the idle threshold; $idle should have fired
    const banked = attn.engagementTimeMs();
    expect(banked).toBeGreaterThanOrEqual(25);
    await sleep(30); // still idle; clock keeps ticking
    expect(attn.engagementTimeMs()).toBeGreaterThan(banked);
  });
});

describe("Attention > tab lifecycle events", () => {
  test("emits $tab_hidden on visibilitychange to hidden with visible_ms", async () => {
    const { attn, events } = makeAttention();
    attn.start();
    await sleep(25);
    forceVisibility("hidden");
    document.dispatchEvent(new Event("visibilitychange"));

    const hidden = events.find((e) => e.type === "$tab_hidden");
    expect(hidden).toBeDefined();
    expect(typeof hidden?.properties.visible_ms).toBe("number");
    expect(hidden?.properties.visible_ms).toBeGreaterThanOrEqual(20);
  });

  test("emits $tab_visible on visibilitychange to visible with hidden_ms", async () => {
    const { attn, events } = makeAttention();
    attn.start();
    forceVisibility("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    await sleep(25);
    forceVisibility("visible");
    document.dispatchEvent(new Event("visibilitychange"));

    const visible = events.find((e) => e.type === "$tab_visible");
    expect(visible).toBeDefined();
    expect(typeof visible?.properties.hidden_ms).toBe("number");
    expect(visible?.properties.hidden_ms).toBeGreaterThanOrEqual(20);
  });

  test("captureAttention: false suppresses the lifecycle events but the clock still pauses", async () => {
    const { attn, events } = makeAttention({ captureAttention: false });
    attn.start();
    await sleep(20);
    forceVisibility("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    forceVisibility("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    // No emit, but the clock is still alive and gained no time while hidden.
    expect(events.filter((e) => /^\$tab_/.test(e.type))).toHaveLength(0);
  });
});

describe("Attention > idle detection", () => {
  test("emits $idle after idleTimeoutMs of no activity with active_ms", async () => {
    const { attn, events } = makeAttention({ idleTimeoutMs: 15 });
    attn.start();
    await sleep(35);

    const idle = events.find((e) => e.type === "$idle");
    expect(idle).toBeDefined();
    expect(typeof idle?.properties.active_ms).toBe("number");
  });

  test("emits $active on first activity after $idle, with idle_ms", async () => {
    const { attn, events } = makeAttention({ idleTimeoutMs: 15 });
    attn.start();
    await sleep(30);
    await sleep(15); // remain idle for a moment so idle_ms is non-trivial
    document.dispatchEvent(new Event("mousemove"));

    const active = events.find((e) => e.type === "$active");
    expect(active).toBeDefined();
    expect(typeof active?.properties.idle_ms).toBe("number");
    expect(active?.properties.idle_ms).toBeGreaterThanOrEqual(10);
  });

  test("activity inside the idle window does not fire $idle", async () => {
    const { attn, events } = makeAttention({ idleTimeoutMs: 30 });
    attn.start();
    await sleep(10);
    document.dispatchEvent(new Event("mousemove")); // resets the timer
    await sleep(15);
    // Total time elapsed > 30ms, but the activity reset the timer, so idle
    // should not have fired yet.
    expect(events.find((e) => e.type === "$idle")).toBeUndefined();
  });

  test("idleTimeoutMs: 0 disables idle detection entirely", async () => {
    const { attn, events } = makeAttention({ idleTimeoutMs: 0 });
    attn.start();
    await sleep(50);
    expect(events.find((e) => e.type === "$idle")).toBeUndefined();
    // And the engagement clock keeps ticking - it never gets paused by idle.
    expect(attn.engagementTimeMs()).toBeGreaterThanOrEqual(40);
  });

  test("idle does not fire while the tab is hidden", async () => {
    const { attn, events } = makeAttention({ idleTimeoutMs: 15 });
    attn.start();
    forceVisibility("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    await sleep(40);
    expect(events.find((e) => e.type === "$idle")).toBeUndefined();
  });
});

describe("Attention > flushAndReset for page transitions", () => {
  test("returns the engagement total and resets the accumulator", async () => {
    const { attn } = makeAttention();
    attn.start();
    await sleep(25);
    const flushed = attn.flushAndReset();
    expect(flushed).toBeGreaterThanOrEqual(20);
    // After reset, the new page starts at 0 (give or take the tiny instant
    // before the next read).
    expect(attn.engagementTimeMs()).toBeLessThan(15);
  });

  test("the new page's clock starts immediately if the tab is currently visible", async () => {
    const { attn } = makeAttention();
    attn.start();
    attn.flushAndReset();
    await sleep(20);
    expect(attn.engagementTimeMs()).toBeGreaterThanOrEqual(15);
  });
});
