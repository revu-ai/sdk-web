/**
 * @file `@revu-ai/core/local-data` - remove what the SDK stores in the browser.
 *
 * For a visitor who withdraws consent and asks for their data to go with it.
 * `revu.optOut()` stops capture but leaves events queued under the earlier
 * consent to flush, and leaves the visitor's ids in storage. `clear()`
 * removes both: every queued event (in memory and every persisted chunk),
 * the identity ids and the attribution records. It keeps the consent record,
 * so the opt-out itself is still honored on the next load.
 *
 * A plugin rather than core because most sites never need it, so they ship
 * none of it.
 *
 * ```js
 * import revu from "@revu-ai/core";
 * import localData from "@revu-ai/core/local-data";
 *
 * const data = localData();
 * revu.init({ apiKey: "revu_pk_...", plugins: [data] });
 *
 * // When the visitor withdraws consent:
 * revu.optOut();
 * data.clear();
 * ```
 */

import { IDENTITY_KEYS } from "../identity.js";

/**
 * @typedef {import("../types.js").RevuPlugin & { clear: () => void }} LocalDataPlugin
 */

/**
 * Remove the queue's index and every chunk from storage. Matched by prefix
 * rather than by the queue's chunk count, so chunks orphaned by an earlier
 * partial cleanup (removing only the index) go too.
 * @param {import("../queue.js").PersistentQueue} queue
 */
function removeQueue(queue) {
  const store = queue.storage;
  if (!store) return;
  for (let i = store.length - 1; i >= 0; i -= 1) {
    const key = store.key(i);
    if (key === queue.key || key?.startsWith(`${queue.key}.`)) store.removeItem(key);
  }
}

/**
 * Create the local-data plugin. Register it with `revu.init({ plugins })`
 * or `revu.use()`, keep the returned object, and call its `clear()` when the
 * visitor withdraws consent.
 * @returns {LocalDataPlugin}
 */
export default function localData() {
  /** @type {import("../types.js").PluginApi|null} */
  let api = null;
  return {
    name: "local-data",
    install(pluginApi) {
      api = pluginApi;
    },
    /**
     * Drop every queued event and remove the ids and attribution records
     * from storage. The ids in memory are rotated, so an event recorded
     * after an opt-in on the same page is not linked to the visitor whose
     * data was removed. No-op before the SDK has started. Never throws.
     */
    clear() {
      if (!api) return;
      try {
        const { queue, identity, attribution } = api;
        queue.items = [];
        queue.dirtyFrom = Infinity;
        queue.chunkCount = 0;
        removeQueue(queue);
        identity.reset();
        for (const key of IDENTITY_KEYS) identity._storage.remove(key);
        attribution.clear();
      } catch (err) {
        if (api.config.debug) console.error("[REVU] local-data", err);
      }
    },
  };
}
