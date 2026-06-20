/**
 * @file Public API for `@revu-ai/core`.
 *
 * One-line usage:
 * ```js
 * import revu from "@revu-ai/core";
 * revu.init({ apiKey: "revu_pk_..." });
 * ```
 *
 * Every public method is wrapped with `safe()` so the SDK can **never throw
 * into the host page** - the cardinal invariant of a defensive analytics SDK.
 */

import { RevuClient } from "./client.js";
import { resolveConfig } from "./config.js";
import { defaultConsent } from "./consent.js";
import { safe } from "./utils.js";
import { VERSION } from "./version.js";

export { RevuClient, VERSION };
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
 *
 * Cast to the explicit {@link import("./types.js").Revu} type so the
 * generated `.d.ts` exposes real parameter types and per-method docs to
 * consumers who `import revu from "@revu-ai/core"`. Without the cast, tsc
 * infers the public surface through the `safe()` wrapper and every method
 * lands as `(...args: any) => ...`, erasing the JSDoc types this codebase
 * treats as its single source of truth.
 *
 * @type {import("./types.js").Revu}
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

  /**
   * Stop all capture for this visitor and persist the choice across reloads.
   * The route a cookie banner's "reject" / "withdraw consent" path should
   * call: while opted out, every interaction (autocapture, pageviews, custom
   * events, identity events) is suppressed and nothing leaves the browser.
   * Persisted identity ids are kept, so {@link revu.optIn} resumes the same
   * visitor. No-op before `init()`.
   */
  optOut: safe(() => client?.optOut(), onError),

  /**
   * Resume capture after a prior {@link revu.optOut} and persist the choice.
   * The cookie banner "accept" counterpart. No-op before `init()`.
   */
  optIn: safe(() => client?.optIn(), onError),

  /**
   * Whether capture is currently suppressed by a prior {@link revu.optOut}.
   * Returns false before `init()`. Unlike the void methods this returns a
   * value, so it catches internally (rather than via `safe()`) to always hand
   * back a real boolean and never `undefined`.
   * @returns {boolean}
   */
  hasOptedOut() {
    try {
      return client ? client.hasOptedOut() : false;
    } catch (err) {
      onError(err);
      return false;
    }
  },

  /**
   * Category-level consent control. The granular counterpart to the
   * {@link revu.optOut} / {@link revu.optIn} master switch:
   *
   * ```js
   * revu.consent.set({ analytics: "granted", marketing: "denied" });
   * revu.consent.get(); // { analytics: "granted", marketing: "denied", functional: "granted" }
   * ```
   *
   * `set()` merges a partial map and persists it; denying `analytics`
   * suppresses all capture exactly like `optOut()`. `marketing` and
   * `functional` are declarative - the SDK stamps them on every event
   * (`properties.$consent`) for the server to honor, but does not gate on them.
   * Before `init()`, `set()` is a no-op and `get()` returns the all-granted
   * default. `get()` catches internally (like `hasOptedOut`) so it always
   * returns a real state object, never `undefined`.
   * @type {{ set: (categories: Record<string, "granted"|"denied">) => void, get: () => import("./types.js").ConsentState }}
   */
  consent: {
    set: safe((categories) => client?.setConsent(categories), onError),
    get() {
      try {
        return /** @type {import("./types.js").ConsentState} */ (
          client ? client.getConsent() : defaultConsent()
        );
      } catch (err) {
        onError(err);
        return /** @type {import("./types.js").ConsentState} */ (defaultConsent());
      }
    },
  },

  /** Flush buffered events immediately. @returns {Promise<boolean>|undefined} */
  flush: safe(() => client?.flush(), onError),

  /**
   * Build version of `@revu-ai/core` baked into this bundle. Useful for
   * support tickets, console introspection (`console.log(revu.version)`),
   * and feature-gating consumer code on the SDK build it loaded.
   */
  version: VERSION,
};

export default revu;
