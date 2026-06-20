/**
 * @file Consent - the master capture opt-out switch.
 *
 * A binary kill: while opted out, every `record()` call (autocapture,
 * pageviews, custom `capture()`, identity events) is a no-op, so no event is
 * built and nothing leaves the browser. Identity ids already on disk are
 * preserved - opting back in resumes capture for the same visitor rather
 * than minting a new one.
 *
 * The opt-out preference is persisted through the same first-party store as
 * identity (localStorage plus a cookie mirror by default), so a choice made
 * on one page load is honored on the next without re-prompting.
 *
 * Category-level consent (analytics / marketing / functional / ...), the
 * Consent Mode / TCF bridges, and reading a browser-level privacy signal
 * (Global Privacy Control) are deliberately out of scope here; they layer on
 * top of this master switch when the consent-plugin work lands.
 */

const OPT_OUT_KEY = "revu_opt_out";

/**
 * Owns the master opt-out state and persists it across reloads.
 */
export class Consent {
  /**
   * @param {object} [options]
   * @param {import("./storage.js").Storage} [options.storage] First-party
   *   store for the persisted preference. Omit to keep the state in memory
   *   for the current page only (used in tests / SSR).
   */
  constructor(options = {}) {
    /** @type {import("./storage.js").Storage|null} */
    this._storage = options.storage || null;
    const stored = this._storage ? this._storage.read(OPT_OUT_KEY) : null;
    // Opted out only on an explicit persisted choice; default to capture on.
    /** @type {boolean} */
    this._optedOut = stored === "1";
  }

  /** @returns {boolean} True while capture is suppressed. */
  optedOut() {
    return this._optedOut;
  }

  /** Suppress all capture and persist the choice so reloads honor it. */
  optOut() {
    this._optedOut = true;
    if (this._storage) this._storage.write(OPT_OUT_KEY, "1");
  }

  /** Resume capture and persist the choice. */
  optIn() {
    this._optedOut = false;
    if (this._storage) this._storage.write(OPT_OUT_KEY, "0");
  }
}
