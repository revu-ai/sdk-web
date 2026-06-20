/**
 * @file Fire-before-load queue drain logic. Internal to the IIFE entry.
 *
 * The customer's install snippet creates a tiny stub at `window.revu`
 * (either a plain object with a `.q` array or a Proxy that synthesizes
 * queue-pushing methods) and may call `revu.init(...)`, `revu.capture(...)`,
 * etc. before the SDK bundle finishes loading. When the bundle does
 * load, `bootIife` replays those queued calls against the real
 * singleton in arrival order, then replaces the stub with the live
 * client so subsequent calls go straight through. Queue items are
 * arrays of the form `[methodName, ...args]`; calls to methods the real
 * client does not expose are silently dropped (the SDK never throws
 * into the host page).
 *
 * This logic lives in its own module so `src/iife.js` (the actual IIFE
 * bundle entry) can be export-free. An export-free IIFE bundle collapses
 * Rollup's wrapper to its minimal `!function(){...}()` form, drops the
 * need for an `output.name` global, and shaves bytes off every customer
 * download.
 */

/**
 * Drain a fire-before-load stub queue against the target client, then
 * install `target` as `globalThis.revu`.
 *
 * @template {object} T
 * @param {T} target  The real singleton to install.
 * @param {unknown} stubBefore  The pre-existing `globalThis.revu` value
 *   captured before installation. If it has a `.q` array of
 *   `[methodName, ...args]` items, those calls are replayed against
 *   `target` in arrival order.
 */
export function bootIife(target, stubBefore) {
  const stub = /** @type {{ q?: unknown[] } | null | undefined} */ (stubBefore);
  if (stub && Array.isArray(stub.q)) {
    for (const args of stub.q) {
      if (!Array.isArray(args) || args.length === 0) continue;
      const [method, ...rest] = args;
      // Resolve dynamically; the SDK never throws into the host, so an
      // unknown method or a thrown call is swallowed silently.
      const fn = /** @type {Record<string, unknown>} */ (target)[method];
      if (typeof method === "string" && typeof fn === "function") {
        try {
          /** @type {(...a: unknown[]) => unknown} */ (fn).apply(target, rest);
        } catch {
          // Cardinal invariant: never crash the host page.
        }
      }
    }
  }
  /** @type {Record<string, unknown>} */ (globalThis).revu = target;
}
