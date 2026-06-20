/**
 * @file Tests for the IIFE entry (`src/iife.js`) and its drain helper
 * (`src/iife-boot.js`).
 *
 * The two source files split as follows:
 *   1. `src/iife.js` is the actual IIFE bundle entry. Its module-level
 *      side effect installs the real SDK singleton as `globalThis.revu`.
 *      Importing it for its side effect (no named import) is enough to
 *      exercise that contract.
 *   2. `src/iife-boot.js` exports `bootIife(target, stubBefore)`, which
 *      drains a fire-before-load stub queue against the target client.
 *      It is imported by `iife.js` and by these tests directly so the
 *      drain logic can be exercised in isolation with mock targets.
 *
 * Test order matters: the first test asserts the post-import state of
 * `globalThis.revu` BEFORE later tests overwrite it with mocks. Bun runs
 * tests in source order within a file, so the layout below is the
 * authoritative one.
 */

import { describe, expect, test } from "bun:test";

// Side-effect import: evaluates `src/iife.js`, which installs the real
// singleton as `globalThis.revu`. The named import below is for the
// drain-logic unit tests that follow.
import "../src/iife.js";
import { bootIife } from "../src/iife-boot.js";

describe("IIFE entry - module side effect on import", () => {
  test("installs the real revu singleton on globalThis.revu", () => {
    expect(globalThis.revu).toBeDefined();
    const r = /** @type {Record<string, unknown>} */ (globalThis.revu);
    expect(typeof r.init).toBe("function");
    expect(typeof r.capture).toBe("function");
    expect(typeof r.identify).toBe("function");
    expect(typeof r.alias).toBe("function");
    expect(typeof r.reset).toBe("function");
    expect(typeof r.flush).toBe("function");
    expect(typeof r.use).toBe("function");
    expect(typeof r.version).toBe("string");
    expect(/** @type {string} */ (r.version).length).toBeGreaterThan(0);
  });
});

describe("bootIife - fire-before-load queue drain", () => {
  /**
   * Build a minimal mock target that records every call it receives so a
   * test can assert the drain order without depending on the real client.
   */
  function makeRecordingTarget() {
    /** @type {Array<[string, unknown[]]>} */
    const calls = [];
    const mk = (/** @type {string} */ name) => (/** @type {unknown[]} */ ...args) => {
      calls.push([name, args]);
    };
    const target = {
      init: mk("init"),
      capture: mk("capture"),
      identify: mk("identify"),
      alias: mk("alias"),
      reset: mk("reset"),
      flush: mk("flush"),
      use: mk("use"),
      version: "test-0.0.0",
    };
    return { target, calls };
  }

  test("replays queued calls in arrival order against the target", () => {
    const { target, calls } = makeRecordingTarget();
    const stub = {
      q: [
        ["init", { apiKey: "test_key" }],
        ["identify", "user_42"],
        ["capture", "btn_click", { id: "cta" }],
        ["flush"],
      ],
    };
    bootIife(target, stub);
    expect(calls).toEqual([
      ["init", [{ apiKey: "test_key" }]],
      ["identify", ["user_42"]],
      ["capture", ["btn_click", { id: "cta" }]],
      ["flush", []],
    ]);
  });

  test("installs the target as globalThis.revu after draining", () => {
    const { target } = makeRecordingTarget();
    bootIife(target, { q: [] });
    expect(globalThis.revu).toBe(target);
  });

  test("is a no-op when there is no stub at all", () => {
    const { target, calls } = makeRecordingTarget();
    bootIife(target, undefined);
    expect(calls).toHaveLength(0);
    expect(globalThis.revu).toBe(target);
  });

  test("is a no-op when the stub has no .q queue", () => {
    const { target, calls } = makeRecordingTarget();
    bootIife(target, { somethingElse: true });
    expect(calls).toHaveLength(0);
    expect(globalThis.revu).toBe(target);
  });

  test("skips queue entries that are not arrays or are empty", () => {
    const { target, calls } = makeRecordingTarget();
    const stub = {
      q: [
        null,
        undefined,
        [],
        "not-an-array",
        ["capture", "real_event"],
      ],
    };
    bootIife(target, stub);
    expect(calls).toEqual([["capture", ["real_event"]]]);
  });

  test("silently drops calls to methods the target does not implement", () => {
    const { target, calls } = makeRecordingTarget();
    const stub = {
      q: [
        ["init", { apiKey: "k" }],
        ["wrongMethod", "should be ignored"],
        ["capture", "real_event"],
      ],
    };
    bootIife(target, stub);
    // The unknown method drops, the real ones go through in order.
    expect(calls).toEqual([
      ["init", [{ apiKey: "k" }]],
      ["capture", ["real_event"]],
    ]);
  });

  test("never throws if a target method throws (host-page safety)", () => {
    /** @type {Array<[string, unknown[]]>} */
    const calls = [];
    const target = {
      init: () => { throw new Error("synthetic init failure"); },
      capture: (/** @type {unknown[]} */ ...args) => { calls.push(["capture", args]); },
    };
    const stub = {
      q: [
        ["init", { apiKey: "k" }],
        ["capture", "after_failure"],
      ],
    };
    // Must not throw out of bootIife even if a target method throws.
    expect(() => bootIife(target, stub)).not.toThrow();
    // The post-throw call still runs.
    expect(calls).toEqual([["capture", ["after_failure"]]]);
  });
});
