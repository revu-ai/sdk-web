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
//
// Stub `fetch` with a successful no-op so no test makes a real request. Tests
// that assert transport behavior overwrite `globalThis.fetch` with their own
// mock; they restore THIS no-op (importing it) rather than capturing whatever
// `globalThis.fetch` was, so the real happy-dom fetch is never re-armed for a
// later file's leaked listener.

/**
 * Hermetic no-op replacement for `fetch`: resolves a successful empty 200
 * response without any network I/O. The default `globalThis.fetch` for the
 * whole test run, and the restore target after a test installs its own mock.
 * @returns {Promise<Response>}
 */
export function noopFetch() {
  return Promise.resolve(new Response("", { status: 200 }));
}

globalThis.fetch = /** @type {typeof fetch} */ (/** @type {unknown} */ (noopFetch));
