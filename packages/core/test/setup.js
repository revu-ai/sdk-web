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
