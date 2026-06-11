/**
 * @file Public API for `@revu-ai/core`.
 *
 * One-line usage:
 * ```js
 * import revu from "@revu-ai/core";
 * revu.init({ apiKey: "phc_xxx" });
 * ```
 *
 * Every public method is wrapped with `safe()` so the SDK can **never throw
 * into the host page** - the cardinal invariant of a defensive analytics SDK.
 */

import { RevuClient } from "./client.js";
import { resolveConfig } from "./config.js";
import { safe } from "./utils.js";

export { RevuClient };
export * from "./types.js";

/** @type {RevuClient|null} */
let client = null;

/**
 * Plugins registered via `revu.use()` before `revu.init()` are queued here
 * and installed during init. Without this, a host that imports a plugin
 * module at the top of their bundle would silently lose it if init runs
 * later in the boot sequence.
 * @type {import("./types.js").RevuPlugin[]}
 */
const pendingPlugins = [];

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
   * Plugins can be passed via the config or registered separately via
   * `revu.use()`.
   * @param {import("./types.js").RevuConfig} config
   * @returns {void}
   */
  init: safe((config) => {
    if (client) return;
    client = new RevuClient(resolveConfig(config));
    if (Array.isArray(config?.plugins)) {
      for (const p of config.plugins) client.use(p);
    }
    while (pendingPlugins.length) {
      client.use(/** @type {import("./types.js").RevuPlugin} */ (pendingPlugins.shift()));
    }
    client.start();
  }, onError),

  /**
   * Register a plugin. Equivalent to passing it in `init({ plugins: [...] })`,
   * but available as a separate call so plugins can be wired conditionally
   * (e.g. behind a feature flag) after `init()`. Pre-init `use()` calls are
   * queued and drained when init runs.
   * @param {import("./types.js").RevuPlugin} plugin
   * @returns {void}
   */
  use: safe((plugin) => {
    if (client) client.use(plugin);
    else pendingPlugins.push(plugin);
  }, onError),

  /**
   * Capture a custom event by name. Use for signals autocapture cannot
   * see (server-side completions, async events, wizard steps that do not
   * change the URL). For anything autocapture already names (a click on
   * a button, a form submit, a pageview), prefer letting the auto-derived
   * feature catalog group it - calling capture() on top duplicates the
   * signal.
   *
   * @param {string} eventType
   * @param {Record<string, unknown>} [properties]
   */
  capture: safe((eventType, properties) => client?.capture(eventType, properties), onError),

  /**
   * Link the anonymous visitor to a known user id (on login/register).
   * @param {string} userId
   */
  identify: safe((userId) => client?.identify(userId), onError),

  /**
   * Join the current device's identity to a separate, authoritative
   * identity for the same person without changing the local user id.
   * Distinct from {@link revu.identify}: identify replaces the local
   * id; alias joins it to a canonical one. The motivating flow is
   * cross-device (sign up on desktop, click email link on phone). The
   * server upserts on `(organization, alias_user_id)`, so repeated
   * calls produce one mapping, not duplicates.
   * @param {string} authoritativeId
   */
  alias: safe((authoritativeId) => client?.alias(authoritativeId), onError),

  /**
   * Sign-out counterpart to {@link revu.identify}: clear the identified
   * user, regenerate the session id, and emit a `$reset` event marking
   * the end of the logged-in session. The anonymous id is preserved.
   * No-op when no user is currently identified.
   */
  reset: safe(() => client?.reset(), onError),

  /** Flush buffered events immediately. @returns {Promise<boolean>|undefined} */
  flush: safe(() => client?.flush(), onError),
};

export default revu;
