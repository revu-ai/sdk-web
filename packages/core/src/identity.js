/**
 * @file Identity - first-party anonymous id, persistent user id, and session.
 *
 * Two persistent ids and one ephemeral id:
 *
 *   - anonymousId  - the device id. A UUID generated on first visit and
 *                    persisted in localStorage forever. Never tied to a
 *                    known person; survives logout.
 *   - userId       - the person id. With `autoIdentify` (the default), a
 *                    persistent UUID is auto-generated on first visit so
 *                    every event arrives attributed to a stable visitor.
 *                    Host apps replace it with their real auth id via
 *                    `revu.identify(...)`; the manual id wins and is also
 *                    persisted. `reset()` rotates the auto id (logout =
 *                    new visitor) or clears it when autoIdentify is off.
 *   - sessionId    - per-load UUID. Always fresh on init; rotates on reset.
 *
 * Storage is best-effort: if localStorage is blocked (private mode,
 * cookies off), ids fall back to in-memory per-load values and the
 * SDK continues to function.
 */

import { uuid } from "./utils.js";

const ANON_KEY = "revu_anonymous_id";
const USER_KEY = "revu_user_id";

/**
 * Read or lazily create the persistent first-party anonymous id.
 * @returns {string}
 */
function loadAnonymousId() {
  try {
    const existing = localStorage.getItem(ANON_KEY);
    if (existing) return existing;
    const fresh = uuid();
    localStorage.setItem(ANON_KEY, fresh);
    return fresh;
  } catch {
    return uuid();
  }
}

/**
 * Read the persisted user id (manual or auto-generated on a prior visit).
 * @returns {string|null}
 */
function loadPersistedUserId() {
  try {
    return localStorage.getItem(USER_KEY) || null;
  } catch {
    return null;
  }
}

/**
 * Persist (or clear, when value is null) the user id. Failures are
 * swallowed so a quota-full / cookies-disabled browser still gets a
 * working in-memory userId for the rest of the page lifetime.
 * @param {string|null} userId
 */
function persistUserId(userId) {
  try {
    if (userId === null) localStorage.removeItem(USER_KEY);
    else localStorage.setItem(USER_KEY, userId);
  } catch {
    // Best-effort.
  }
}

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
   */
  constructor(options = {}) {
    /** @type {boolean} */
    this.autoIdentify = options.autoIdentify !== false;
    /** @type {string} */
    this.anonymousId = loadAnonymousId();
    /** @type {string|null} */
    this.userId = this._resolveUserId();
    /** @type {string} */
    this.sessionId = uuid();
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
    const persisted = loadPersistedUserId();
    if (persisted) return persisted;
    if (!this.autoIdentify) return null;
    const fresh = uuid();
    persistUserId(fresh);
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
      persistUserId(userId);
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
    persistUserId(null);
    if (this.autoIdentify) {
      const fresh = uuid();
      persistUserId(fresh);
      this.userId = fresh;
    } else {
      this.userId = null;
    }
    this.sessionId = uuid();
  }
}
