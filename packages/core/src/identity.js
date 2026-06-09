/**
 * @file Identity - first-party anonymous id, persistent user id, and session.
 *
 * Two device/person ids and one rolling session id:
 *
 *   - anonymousId  - the device id. A UUID generated on first visit and
 *                    persisted across reloads. Never tied to a known
 *                    person; survives logout.
 *   - userId       - the person id. With `autoIdentify` (the default), a
 *                    persistent UUID is auto-generated on first visit so
 *                    every event arrives attributed to a stable visitor.
 *                    Host apps replace it with their real auth id via
 *                    `revu.identify(...)`; the manual id wins and is also
 *                    persisted. `reset()` rotates the auto id (logout =
 *                    new visitor) or clears it when autoIdentify is off.
 *   - sessionId    - the session id. With session continuation enabled
 *                    (the default, sessionTimeoutMs > 0), the previous
 *                    session is reused when the gap since last activity
 *                    is under the timeout - so a quick reload, an SPA
 *                    re-entry, or opening a second tab on the same site
 *                    all stay inside one session. Once the gap exceeds
 *                    the timeout, the next construction rotates.
 *
 * Persistence is delegated to {@link createStorage}, which by default
 * mirrors every id to both localStorage and a first-party cookie so the
 * SDK survives a wider set of storage-clear scenarios (Safari ITP can
 * evict one but leave the other; the surviving store rehydrates the
 * other on the next read). Both stores blocked falls back to in-memory
 * per-load ids; the SDK never crashes the host.
 */

import { createStorage } from "./storage.js";
import { uuid } from "./utils.js";

const ANON_KEY = "revu_anonymous_id";
const USER_KEY = "revu_user_id";
const SESSION_KEY = "revu_session_id";
const SESSION_SEEN_KEY = "revu_session_last_seen";
// `is_new_visitor` and `first_seen_at` are deliberately NOT stored or
// stamped client-side. They are computed server-side from the
// `behavior.visitors` rollup table where the API can keep them
// consistent across SDK upgrades, partial storage corruption, and
// definition changes (see invariant #6: "The SDK only captures").

const DEFAULT_SESSION_TIMEOUT_MS = 30 * 60 * 1000;
/**
 * Throttle window for persisting session.last_seen. We update the in-memory
 * timestamp on every event but only write through to storage once per ~5 s,
 * which keeps a chatty page (dozens of events per second under load) from
 * paying a storage write per event without losing meaningful continuation
 * precision against a 30-minute timeout.
 */
const SESSION_TOUCH_THROTTLE_MS = 5000;

/**
 * Manages the three layers of identity (device, person, session).
 */
export class Identity {
  /**
   * @param {object} [options]
   * @param {boolean} [options.autoIdentify=true] When true (the default),
   *   a persistent user id is auto-generated on first visit so every
   *   session carries a stable visitor identifier even before the host
   *   app calls identify(). When false, userId remains null until the
   *   host app calls identify() (or a prior identify is restored from
   *   storage).
   * @param {import("./storage.js").StorageMode} [options.persistentStorage="both"]
   *   Which client-side stores to use for persisting ids. "both" mirrors
   *   to localStorage and a first-party cookie for maximum durability;
   *   "localStorage" disables the cookie (no per-request bandwidth);
   *   "cookie" disables localStorage.
   * @param {string|null} [options.cookieDomain] When set (and the cookie
   *   store is active), the cookie carries this as its Domain attribute
   *   so the same id is shared across the host's subdomains.
   * @param {number} [options.sessionTimeoutMs=1800000] How long (in ms) a
   *   session can sit idle before the next construction rotates to a
   *   fresh id. Set to 0 to disable continuation entirely (every load
   *   gets a brand new sessionId, matching pre-continuation behavior).
   */
  constructor(options = {}) {
    /** @type {boolean} */
    this.autoIdentify = options.autoIdentify !== false;
    /** @type {number} */
    this.sessionTimeoutMs = typeof options.sessionTimeoutMs === "number"
      ? options.sessionTimeoutMs
      : DEFAULT_SESSION_TIMEOUT_MS;
    /** @type {import("./storage.js").Storage} */
    this._storage = createStorage({
      mode: options.persistentStorage,
      cookieDomain: options.cookieDomain,
    });
    /** @type {string} */
    this.anonymousId = this._loadOrGenerate(ANON_KEY);
    /** @type {string|null} */
    this.userId = this._resolveUserId();
    /** @type {number} Last time we persisted `session_last_seen`. */
    this._sessionLastTouchPersisted = 0;
    /** @type {string} */
    this.sessionId = this._resolveSession();
  }

  /**
   * Read a persisted id from the configured store(s), or generate, persist,
   * and return a fresh UUID when nothing is stored. Used for ids that must
   * always be present (the anonymous device id).
   * @param {string} key
   * @returns {string}
   */
  _loadOrGenerate(key) {
    const existing = this._storage.read(key);
    if (existing) return existing;
    const fresh = uuid();
    this._storage.write(key, fresh);
    return fresh;
  }

  /**
   * Restore a persisted user id when present (a prior identify, or a
   * prior auto-identify on the same browser). Otherwise auto-generate
   * one if enabled, or stay anonymous. A persisted id always wins so
   * an explicit identify on a previous load survives a refresh even
   * when autoIdentify is later disabled.
   * @returns {string|null}
   */
  _resolveUserId() {
    const persisted = this._storage.read(USER_KEY);
    if (persisted) return persisted;
    if (!this.autoIdentify) return null;
    const fresh = uuid();
    this._storage.write(USER_KEY, fresh);
    return fresh;
  }

  /**
   * Restore the prior session id when continuation is enabled and the
   * gap since the last recorded activity is under the timeout. Otherwise
   * generate, persist, and return a fresh session id. Continuation off
   * (sessionTimeoutMs <= 0) always returns a fresh id without touching
   * storage, preserving pre-continuation per-load semantics.
   * @returns {string}
   */
  _resolveSession() {
    if (this.sessionTimeoutMs <= 0) return uuid();
    const persistedId = this._storage.read(SESSION_KEY);
    const persistedSeen = this._storage.read(SESSION_SEEN_KEY);
    if (persistedId && persistedSeen) {
      const lastSeenMs = Number.parseInt(persistedSeen, 10);
      if (
        Number.isFinite(lastSeenMs) &&
        Date.now() - lastSeenMs < this.sessionTimeoutMs
      ) {
        // Seed the throttle from the persisted timestamp so the FIRST
        // touchSession() after restore correctly waits the throttle window
        // from when the prior page persisted, not from process start.
        this._sessionLastTouchPersisted = lastSeenMs;
        return persistedId;
      }
    }
    const fresh = uuid();
    const now = Date.now();
    this._storage.write(SESSION_KEY, fresh);
    this._storage.write(SESSION_SEEN_KEY, String(now));
    this._sessionLastTouchPersisted = now;
    return fresh;
  }

  /**
   * Mark the session as currently active. Called by the client on every
   * recorded event so the persisted last_seen reflects the real tail of
   * activity. Writes are throttled to one per ~5 s so a chatty page does
   * not pay a storage write per event.
   */
  touchSession() {
    if (this.sessionTimeoutMs <= 0) return;
    const now = Date.now();
    if (now - this._sessionLastTouchPersisted < SESSION_TOUCH_THROTTLE_MS) return;
    this._sessionLastTouchPersisted = now;
    this._storage.write(SESSION_SEEN_KEY, String(now));
  }

  /**
   * Replace the current user id with a host-supplied value (typically the
   * user's auth id on login). The manual id always wins over the auto id
   * and is persisted across reloads.
   * @param {string} userId
   */
  identify(userId) {
    if (typeof userId === "string" && userId.length > 0) {
      this.userId = userId;
      this._storage.write(USER_KEY, userId);
    }
  }

  /**
   * Sign-out: close the current identified session.
   *
   * The anonymous id is preserved (same browser remains a known device).
   * The session id always rotates so subsequent events start a fresh
   * session - logout is an explicit hard boundary that the continuation
   * window does not survive. The user id behavior depends on autoIdentify:
   *
   *   - autoIdentify true:  rotate to a fresh auto user id. The next
   *     visitor on this browser is treated as a new person by analytics,
   *     which matches typical "logged out" semantics for SaaS apps.
   *   - autoIdentify false: clear to null until the host app calls
   *     identify() again.
   */
  reset() {
    this._storage.remove(USER_KEY);
    if (this.autoIdentify) {
      const fresh = uuid();
      this._storage.write(USER_KEY, fresh);
      this.userId = fresh;
    } else {
      this.userId = null;
    }
    this.sessionId = uuid();
    if (this.sessionTimeoutMs > 0) {
      const now = Date.now();
      this._storage.write(SESSION_KEY, this.sessionId);
      this._storage.write(SESSION_SEEN_KEY, String(now));
      this._sessionLastTouchPersisted = now;
    }
  }
}
