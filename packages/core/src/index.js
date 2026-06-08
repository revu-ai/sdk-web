/**
 * @file Public API for `@revu-ai/core`.
 *
 * One-line usage:
 * ```js
 * import revu from "@revu-ai/core";
 * revu.init({ apiKey: "phc_xxx" });
 * ```
 *
 * Every public method is wrapped so the SDK can **never throw into the host
 * page** (cardinal invariant - corpus SDK-Engineering-Lessons §2.3).
 */

import { RevuClient } from "./client.js";
import { resolveConfig } from "./config.js";
import { safe } from "./utils.js";

export { RevuClient };
export * from "./types.js";

/** @type {RevuClient|null} */
let client = null;

/** @param {unknown} err */
function onError(err) {
  if (client?.config.debug) console.error("[REVU]", err);
}

/**
 * The default singleton - the one-line entry point for the SDK.
 */
const revu = {
  /**
   * Initialize the SDK. Safe to call once; subsequent calls are ignored.
   * @param {import("./types.js").RevuConfig} config
   * @returns {void}
   */
  init: safe((config) => {
    if (client) return;
    client = new RevuClient(resolveConfig(config));
    client.start();
  }, onError),

  /**
   * Capture a custom event.
   * @param {string} eventType
   * @param {Record<string, unknown>} [properties]
   */
  track: safe((eventType, properties) => client?.track(eventType, properties), onError),

  /**
   * Link the anonymous visitor to a known user id (on login/register).
   * @param {string} userId
   */
  identify: safe((userId) => client?.identify(userId), onError),

  /** Flush buffered events immediately. @returns {Promise<boolean>|undefined} */
  flush: safe(() => client?.flush(), onError),
};

export default revu;
