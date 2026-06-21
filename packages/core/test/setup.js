/**
 * @file Test preload. Registers happy-dom's globals (window, document,
 * navigator, localStorage, history, addEventListener, etc.) on the global
 * object so DOM-touching SDK modules behave the same under `bun test` as in
 * a real browser. Loaded once per test run via the root `bunfig.toml`
 * `[test] preload` entry.
 */

import { GlobalRegistrator } from "@happy-dom/global-registrator";

// `register()` is not idempotent; guard so re-preloads (worker reuse, etc.)
// do not throw or stack windows on top of each other.
if (typeof globalThis.window === "undefined") {
  GlobalRegistrator.register({ url: "http://localhost/" });
}

// Hermetic network. happy-dom's `fetch` performs real outbound I/O, and a
// live SDK client can fire a background send to its configured host outside
// the test that created it: the IIFE smoke-test clients (test/iife-bundle.
// smoke.test.js) register pagehide / visibilitychange flush listeners on the
// shared window that outlive the test (the SDK exposes no teardown), so a
// later file that dispatches those events (e.g. test/attention.test.js)
// triggers a real flush to `https://example.invalid/v1/behavior/events`. The
// resulting async rejection surfaces as an "unhandled error between tests" and
// fails the unrelated file (seen in CI, where scheduling differs from local).
// Stub `fetch` with a successful no-op so no test makes a real request. Tests
// that assert transport behavior overwrite `globalThis.fetch` with their own
// mock and restore it to this baseline, so this does not weaken them.
globalThis.fetch = () => Promise.resolve(new Response("", { status: 200 }));
