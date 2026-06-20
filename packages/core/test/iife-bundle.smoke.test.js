/**
 * @file Build-then-eval smoke test for the minified IIFE bundle.
 *
 * The unit tests in `iife.test.js` exercise `src/iife.js` as source,
 * which proves the *semantics* of the entry are correct but not that the
 * minifier preserved them. The aggressive SWC config we use
 * (`unsafe_arrows`, `unsafe_methods`, `pure_getters`, `inline: 3`,
 * `passes: 3`) is safe for our source today, but every byte that goes
 * to a customer's `<script>` tag is the minified bundle, not the source.
 * This test loads `dist/iife/index.js` exactly as a customer's browser
 * would, evaluates it, and asserts the public surface still works
 * end-to-end.
 *
 * Coverage:
 *   1. The minified bundle executes without throwing.
 *   2. It installs `globalThis.revu` with the full public method surface.
 *   3. `revu.init(...)` brings the SDK online and emits `$pageview`.
 *   4. `revu.capture(...)` flows a custom event through to the `onEvent`
 *      hook with the right envelope shape (event_id, anonymous_id,
 *      session_id, properties).
 *   5. The fire-before-load stub queue is drained correctly against the
 *      real client when the bundle loads on top of a pre-existing
 *      `globalThis.revu` with a populated `q` array.
 *
 * The test skips itself cleanly if `dist/iife/index.js` is missing,
 * with a message telling the dev to run `bun run build` first. CI runs
 * `bun run build` before `bun test`, so the test always exercises a
 * fresh bundle there.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const IIFE_PATH = fileURLToPath(
  new URL("../dist/iife/index.js", import.meta.url)
);
const bundleAvailable = existsSync(IIFE_PATH);

// Without dist, mark the test as skipped so the suite stays green during
// source-only development; CI builds first, so this never fires there.
describe.skipIf(!bundleAvailable)(
  "IIFE bundle smoke test (dist/iife/index.js)",
  () => {
    const bundleCode = bundleAvailable ? readFileSync(IIFE_PATH, "utf8") : "";

    /**
     * Each test starts from a clean global to avoid cross-test pollution.
     * The bundle's own boot side effect overwrites `globalThis.revu`, but
     * pre-seeding for the queue-drain test requires the slot to start empty.
     */
    beforeEach(() => {
      /** @type {Record<string, unknown>} */ (globalThis).revu = undefined;
    });

    /**
     * Evaluate the bundle in the current global scope. The IIFE wrapper
     * runs synchronously and installs `globalThis.revu` as its only side
     * effect. `new Function(...)` is the standard way to evaluate a
     * non-module script string without contaminating the module's import
     * graph.
     * @param {string} code
     */
    function evalBundle(code) {
      new Function(code)();
    }

    test("executes without throwing", () => {
      expect(() => evalBundle(bundleCode)).not.toThrow();
    });

    test("installs globalThis.revu with the full public method surface", () => {
      evalBundle(bundleCode);
      const r = /** @type {Record<string, unknown>} */ (globalThis.revu);
      expect(r).toBeDefined();
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

    test("revu.init() brings the SDK online and emits $pageview through onEvent", () => {
      evalBundle(bundleCode);
      /** @type {any[]} */
      const captured = [];
      const r = /** @type {any} */ (globalThis.revu);
      expect(() =>
        r.init({
          apiKey: "test_smoke",
          host: "https://example.invalid",
          // Autocapture must stay on so the initial $pageview fires;
          // attention + web vitals stay off to keep the captured list
          // focused on what the test asserts about.
          autocapture: true,
          captureWebVitals: false,
          captureAttention: false,
          onEvent: (/** @type {any} */ e) => captured.push(e),
        })
      ).not.toThrow();
      // At minimum, the initial $pageview should have fired.
      const pv = captured.find((e) => e.event_type === "$pageview");
      expect(pv).toBeDefined();
      expect(typeof pv.event_id).toBe("string");
      expect(typeof pv.anonymous_id).toBe("string");
      expect(typeof pv.session_id).toBe("string");
      expect(pv.platform).toBe("web");
    });

    test("revu.capture() produces a well-shaped event after init", () => {
      evalBundle(bundleCode);
      /** @type {any[]} */
      const captured = [];
      const r = /** @type {any} */ (globalThis.revu);
      r.init({
        apiKey: "test_smoke",
        host: "https://example.invalid",
        autocapture: false,
        captureWebVitals: false,
        captureAttention: false,
        onEvent: (/** @type {any} */ e) => captured.push(e),
      });
      captured.length = 0; // discard the initial $pageview
      r.capture("smoke_event", { ok: true, n: 42 });
      expect(captured).toHaveLength(1);
      const e = captured[0];
      expect(e.event_type).toBe("smoke_event");
      expect(e.properties.ok).toBe(true);
      expect(e.properties.n).toBe(42);
    });

    test("fire-before-load stub queue is drained against the real client", () => {
      /** @type {any[]} */
      const captured = [];
      // Pre-seed `globalThis.revu` with a stub queue exactly as the
      // production install snippet would, then evaluate the bundle.
      /** @type {Record<string, unknown>} */ (globalThis).revu = {
        q: [
          [
            "init",
            {
              apiKey: "test_smoke",
              host: "https://example.invalid",
              // Autocapture on so the queued init's $pageview fires.
              autocapture: true,
              captureWebVitals: false,
              captureAttention: false,
              onEvent: (/** @type {any} */ e) => captured.push(e),
            },
          ],
          ["capture", "early_event", { from: "stub_queue" }],
          ["identify", "user_42"],
        ],
      };

      evalBundle(bundleCode);

      // The queued init should have brought the SDK online (so $pageview
      // fires) and the queued capture should have flowed through. The
      // queued identify should have emitted an $identify event.
      const pv = captured.find((e) => e.event_type === "$pageview");
      const early = captured.find((e) => e.event_type === "early_event");
      const identify = captured.find((e) => e.event_type === "$identify");
      expect(pv).toBeDefined();
      expect(early).toBeDefined();
      expect(early?.properties.from).toBe("stub_queue");
      expect(identify).toBeDefined();
      // After draining, globalThis.revu is the real client, not the stub.
      const r = /** @type {Record<string, unknown>} */ (globalThis.revu);
      expect(typeof r.init).toBe("function");
      expect(r.q).toBeUndefined();
    });

    test("Proxy stub from install.md drains correctly end-to-end", () => {
      /** @type {any[]} */
      const captured = [];

      // Reproduce the exact Proxy-based stub recommended in
      // `packages/core/docs/install.md`. Any property access synthesizes a
      // queue-pushing method; the `m in t` check lets `.q` return the
      // queue array so the bundle's drain logic can detect it.
      /** @type {any} */
      const target = { q: [] };
      /** @type {Record<string, unknown>} */ (globalThis).revu = new Proxy(
        target,
        {
          get: (t, m) =>
            m in t
              ? /** @type {any} */ (t)[m]
              : (/** @type {unknown[]} */ ...a) =>
                  t.q.push([m, ...a]),
        }
      );

      // Customer calls the stub exactly as the snippet documents: methods
      // on `revu`, just like the npm API. The Proxy synthesizes each
      // method and pushes to `revu.q` in arrival order.
      const stub = /** @type {any} */ (globalThis.revu);
      stub.init({
        apiKey: "test_smoke",
        host: "https://example.invalid",
        autocapture: true,
        captureWebVitals: false,
        captureAttention: false,
        onEvent: (/** @type {any} */ e) => captured.push(e),
      });
      stub.identify("user_proxy");
      stub.capture("proxy_event", { from: "proxy_stub" });

      // The queue should now hold three entries, each with a method name
      // and its args, exactly as the bundle expects to drain.
      expect(target.q).toHaveLength(3);
      expect(target.q[0][0]).toBe("init");
      expect(target.q[1][0]).toBe("identify");
      expect(target.q[2][0]).toBe("capture");

      evalBundle(bundleCode);

      // Each queued call should have replayed against the real client in
      // arrival order. Init brings the SDK online (so $pageview fires),
      // identify emits $identify, capture emits the custom event.
      const pv = captured.find((e) => e.event_type === "$pageview");
      const identify = captured.find((e) => e.event_type === "$identify");
      const customEvent = captured.find((e) => e.event_type === "proxy_event");
      expect(pv).toBeDefined();
      expect(identify).toBeDefined();
      expect(customEvent).toBeDefined();
      expect(customEvent?.properties.from).toBe("proxy_stub");
      // After draining, globalThis.revu is the real client, not the Proxy.
      const r = /** @type {Record<string, unknown>} */ (globalThis.revu);
      expect(typeof r.init).toBe("function");
      expect(r.q).toBeUndefined();
    });
  }
);

// When dist is missing, log one helpful skip message so devs running
// `bun test` without `bun run build` see why the smoke tests didn't run.
if (!bundleAvailable) {
  describe("IIFE bundle smoke test", () => {
    test.skip("dist/iife/index.js missing - run `bun run build` first", () => {});
  });
}
