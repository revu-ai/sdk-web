/**
 * @file Consent - category-aware capture control.
 *
 * The SDK understands three consent categories: `analytics` (its own bucket),
 * `marketing`, and `functional`. Only `analytics` gates capture: while it is
 * "denied" every `record()` call (autocapture, pageviews, custom `capture()`,
 * identity events) is a no-op, so no event is built and nothing leaves the
 * browser - identical to the master opt-out this replaces. `marketing` and
 * `functional` are declarative: the SDK does not act on them, it stamps the
 * full state on every event (`properties.$consent`) so the server can honor
 * the visitor's banner choices on the destinations downstream.
 *
 * `optOut()` / `optIn()` are kept as aliases for denying / granting the
 * `analytics` category, so existing cookie-banner wiring keeps working
 * unchanged.
 *
 * State is persisted through the same first-party store as identity
 * (localStorage plus a cookie mirror by default), so a choice made on one
 * page load is honored on the next without re-prompting. A pre-existing binary
 * opt-out (the legacy `revu_opt_out` key) is read on construction so an
 * upgrade keeps honoring a prior reject rather than silently re-enabling
 * capture.
 *
 * Global Privacy Control (GPC): when the host opts in via `honorGpc` and the
 * browser advertises the signal, `analytics` defaults to "denied" - unless the
 * visitor has already made an explicit choice, which always wins. The GPC
 * signal itself is stamped on events (`properties.$gpc`, see context.js)
 * regardless of `honorGpc`, so the server sees it either way.
 */

/** Persisted category state (current format). */
const CONSENT_KEY = "revu_consent";
/** Legacy binary opt-out key, read for backward-compatible upgrades. */
const LEGACY_OPT_OUT_KEY = "revu_opt_out";

/** The categories the SDK understands. `analytics` is the only one it gates on. */
const CATEGORIES = ["analytics", "marketing", "functional"];
const GRANTED = "granted";
const DENIED = "denied";

/**
 * The default state with no stored preference: every category granted, which
 * preserves the historical "capture on by default" behavior.
 * @returns {Record<string, "granted"|"denied">}
 */
export function defaultConsent() {
  return { analytics: GRANTED, marketing: GRANTED, functional: GRANTED };
}

/**
 * Owns the per-category consent state and persists it across reloads.
 */
export class Consent {
  /**
   * @param {object} [options]
   * @param {import("./storage.js").Storage} [options.storage] First-party store
   *   for the persisted preference. Omit to keep state in memory for the
   *   current page only (used in tests / SSR).
   * @param {boolean} [options.honorGpc=false] When true, a browser GPC signal
   *   defaults `analytics` to denied (unless an explicit choice is persisted).
   * @param {boolean} [options.gpc] The browser's Global Privacy Control value,
   *   read once by the caller (see {@link import("./utils.js").readGpc}).
   */
  constructor(options = {}) {
    /** @type {import("./storage.js").Storage|null} */
    this._storage = options.storage || null;
    /** @type {Record<string, "granted"|"denied">} */
    this._state = defaultConsent();
    // Whether the visitor (or a prior page load) has made an explicit choice.
    // An explicit grant always wins over the GPC default below.
    let explicit = false;

    const stored = this._storage ? this._storage.read(CONSENT_KEY) : null;
    if (stored) {
      this._merge(parseConsent(stored));
      explicit = true;
    } else {
      // Backward compatibility: honor a pre-existing binary opt-out so an
      // upgrade does not silently re-enable capture for a visitor who
      // rejected. "0" is an explicit opt-in, which likewise blocks the GPC
      // default from flipping analytics off.
      const legacy = this._storage ? this._storage.read(LEGACY_OPT_OUT_KEY) : null;
      if (legacy === "1") {
        this._state.analytics = DENIED;
        explicit = true;
      } else if (legacy === "0") {
        explicit = true;
      }
    }

    // GPC sets the default only when the host opts to honor it AND the visitor
    // has not already chosen: an explicit grant via a banner always overrides.
    if (options.honorGpc && options.gpc === true && !explicit) {
      this._state.analytics = DENIED;
    }
  }

  /**
   * @returns {boolean} True while capture is suppressed (analytics denied).
   *   Named for the master-switch semantics that the gate in
   *   `client.record()` and the public `hasOptedOut()` rely on.
   */
  optedOut() {
    return this._state.analytics === DENIED;
  }

  /** Deny the `analytics` category (stop all capture) and persist the choice. */
  optOut() {
    this.set({ analytics: DENIED });
  }

  /** Grant the `analytics` category (resume capture) and persist the choice. */
  optIn() {
    this.set({ analytics: GRANTED });
  }

  /**
   * Merge a partial category map over the current state and persist the
   * result. Unknown categories and values other than "granted" / "denied" are
   * ignored (never throws - the cardinal invariant), so a host wiring a cookie
   * banner can pass through whatever shape it has without guarding.
   * @param {Record<string, "granted"|"denied">} categories
   */
  set(categories) {
    this._merge(categories);
    if (this._storage) this._storage.write(CONSENT_KEY, serializeConsent(this._state));
  }

  /**
   * @returns {Record<string, "granted"|"denied">} A copy of the current
   *   category state - safe for the caller to read and for stamping on events.
   */
  get() {
    return { ...this._state };
  }

  /**
   * Apply a partial category map in place, keeping only known categories with a
   * valid value.
   * @param {Record<string, unknown>} categories
   */
  _merge(categories) {
    if (!categories || typeof categories !== "object") return;
    for (const category of CATEGORIES) {
      const value = categories[category];
      if (value === GRANTED || value === DENIED) this._state[category] = value;
    }
  }
}

/**
 * Serialize the category state to the compact persisted form
 * `analytics:granted|marketing:denied|functional:granted`. Compact (over JSON)
 * to keep the cookie mirror small.
 * @param {Record<string, "granted"|"denied">} state
 * @returns {string}
 */
function serializeConsent(state) {
  return CATEGORIES.map((category) => `${category}:${state[category]}`).join("|");
}

/**
 * Parse the persisted form back into a partial category map. Tolerant of an
 * unknown or malformed entry (it is skipped) so a value written by a newer
 * build never throws when read by an older one.
 * @param {string} raw
 * @returns {Record<string, "granted"|"denied">}
 */
function parseConsent(raw) {
  /** @type {Record<string, "granted"|"denied">} */
  const out = {};
  for (const part of String(raw).split("|")) {
    const [category, value] = part.split(":");
    if (
      category &&
      (value === GRANTED || value === DENIED) &&
      CATEGORIES.includes(category)
    ) {
      out[category] = value;
    }
  }
  return out;
}
