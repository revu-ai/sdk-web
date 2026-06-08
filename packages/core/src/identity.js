/**
 * @file Identity - first-party anonymous id, persistent user id, and session.
 *
 * Two persistent ids and one ephemeral id:
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
 *   - sessionId    - per-load UUID. Always fresh on init; rotates on reset.
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
   */
  constructor(options = {}) {
    /** @type {boolean} */
    this.autoIdentify = options.autoIdentify !== false;
    /** @type {import("./storage.js").Storage} */
    this._storage = createStorage({
      mode: options.persistentStorage,
      cookieDomain: options.cookieDomain,
    });
    /** @type {string} */
    this.anonymousId = this._loadOrGenerate(ANON_KEY);
    /** @type {string|null} */
    this.userId = this._resolveUserId();
    /** @type {string} */
    this.sessionId = uuid();
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
   * session. The user id behavior depends on autoIdentify:
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
  }
}
