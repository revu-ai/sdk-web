/**
 * @file Attribution - durable first-touch and last-touch campaign capture.
 *
 * The server already parses UTM and click ids from each `$pageview`'s captured
 * URL, but that only attributes the event whose URL actually carried the
 * params. The piece the server cannot reconstruct on its own is persistence
 * across the visitor's lifetime: the campaign that ORIGINALLY acquired them
 * (first touch) and the most recent campaign that brought them back (last
 * touch), replayed onto a conversion that happens pages or days later on a URL
 * with no params. Only the client can carry that across sessions, so this one
 * piece of attribution lives here rather than server-side.
 *
 * Two records, persisted through the same first-party store as identity:
 *   - First touch: written once, ever. The first landing's campaign params,
 *     landing path, and time. Never overwritten.
 *   - Last touch: rewritten whenever a NEW touch occurs - a landing that
 *     carries campaign params, or one that comes from an external referrer.
 *     Internal navigation does not overwrite it.
 *
 * Emitted into the event's `context` bucket (only the keys actually present):
 * first touch as `initial_*`, last touch as the bare `utm_*` / `gclid` /
 * `fbclid` convention used across the analytics space.
 *
 * Reading the known, stable `utm_*` / click-id keys via URLSearchParams is
 * cheap and never drifts, so this does not cross the "no parsers shipped to
 * the client" boundary that keeps user-agent and geo enrichment server-side.
 */

import { nowIso, routePath, scrubUrl } from "./utils.js";

const FIRST_KEY = "revu_attribution_first";
const LAST_KEY = "revu_attribution_last";

/** Campaign + click-id query keys captured for attribution (stable set). */
const PARAM_KEYS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "gclid",
  "fbclid",
];

/**
 * Resolves and persists first/last-touch attribution and exposes the flat
 * property bag stamped on every event.
 */
export class Attribution {
  /**
   * @param {object} [options]
   * @param {import("./storage.js").Storage} [options.storage] First-party store
   *   for the persisted records. Omit to keep them in memory for the current
   *   page only (used in tests / SSR).
   */
  constructor(options = {}) {
    /** @type {import("./storage.js").Storage|null} */
    this._storage = options.storage || null;
    /** @type {Record<string, unknown>} Flat props stamped on every event. */
    this._props = this._resolve();
  }

  /**
   * @returns {Record<string, unknown>} The cached attribution properties to
   *   merge into every event. Session-stable: computed once at construction.
   */
  properties() {
    return this._props;
  }

  /**
   * Read the current landing, update the persisted first/last-touch records,
   * and flatten both into the property bag stamped on events.
   * @returns {Record<string, unknown>}
   */
  _resolve() {
    const touch = readTouch();
    const isNewTouch = touch.hasCampaign || touch.externalReferrer;

    // First touch: persist once, ever. A direct first visit (no campaign, no
    // external referrer) still records the landing path and time as the
    // acquisition origin.
    let first = this._read(FIRST_KEY);
    if (!first) {
      first = touch.record;
      this._write(FIRST_KEY, first);
    }

    // Last touch: (re)write on a genuinely new touch, or seed it when absent.
    let last = this._read(LAST_KEY);
    if (isNewTouch || !last) {
      last = touch.record;
      this._write(LAST_KEY, last);
    }

    /** @type {Record<string, unknown>} */
    const props = {};
    // First touch under `initial_*`: campaign params plus landing context.
    for (const key of PARAM_KEYS) {
      if (first[key] != null) props[`initial_${key}`] = first[key];
    }
    if (first.landing_path != null) props.initial_landing_path = first.landing_path;
    if (first.at != null) props.initial_seen_at = first.at;
    // Last touch under the bare `utm_*` / `gclid` / `fbclid` convention.
    for (const key of PARAM_KEYS) {
      if (last[key] != null) props[key] = last[key];
    }
    return props;
  }

  /**
   * Drop the persisted first/last-touch records and stop stamping attribution
   * on subsequent events. Called on logout (`reset()`): attribution is
   * visitor-scoped, so it rotates with the `anonymous_id` and must not carry
   * the previous person's acquisition campaign onto the next person who uses
   * a shared device. A fresh visitor re-establishes attribution on their next
   * campaign landing (or on the next full page load).
   */
  clear() {
    if (this._storage) {
      this._storage.remove(FIRST_KEY);
      this._storage.remove(LAST_KEY);
    }
    this._props = {};
  }

  /** @param {string} key @returns {Record<string, unknown>|null} */
  _read(key) {
    if (!this._storage) return null;
    const raw = this._storage.read(key);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }

  /** @param {string} key @param {Record<string, unknown>} value */
  _write(key, value) {
    if (!this._storage) return;
    try {
      this._storage.write(key, JSON.stringify(value));
    } catch {
      // Best-effort; an unserializable record never blocks capture.
    }
  }
}

/**
 * Read the current landing into a normalized touch record (the campaign params
 * and click ids present in the query, plus the landing path and time), with
 * flags the caller uses to decide first/last-touch persistence.
 * @returns {{ record: Record<string, unknown>, hasCampaign: boolean, externalReferrer: boolean }}
 */
function readTouch() {
  /** @type {Record<string, unknown>} */
  const record = {};
  let hasCampaign = false;

  if (typeof location !== "undefined" && location.search) {
    try {
      const params = new URLSearchParams(location.search);
      for (const key of PARAM_KEYS) {
        const value = params.get(key);
        if (value) {
          // Scrub in case a credential rode in a UTM value; keeps the
          // redact-at-source guarantee even on the attribution path.
          record[key] = scrubUrl(value);
          hasCampaign = true;
        }
      }
    } catch {
      // Malformed query: no campaign params to read.
    }
  }

  // A referrer from a different host marks a fresh external touch, so last
  // touch updates even when the landing carries no UTM params (e.g. an organic
  // search or a link from another site). Internal navigation does not.
  let externalReferrer = false;
  if (typeof document !== "undefined" && document.referrer) {
    try {
      const host = new URL(document.referrer).hostname;
      externalReferrer =
        typeof location !== "undefined" && !!host && host !== location.hostname;
    } catch {
      // Malformed referrer; leave externalReferrer false.
    }
  }

  record.landing_path = routePath();
  record.at = nowIso();
  return { record, hasCampaign, externalReferrer };
}
