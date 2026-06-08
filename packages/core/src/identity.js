/**
 * @file Identity - first-party anonymous id + session, and identify()/alias.
 * Anonymous id is a generated UUID persisted in localStorage (NOT a device
 * fingerprint). See corpus Privacy-Consent-Identity-Design §1.
 */

import { uuid } from "./utils.js";

const ANON_KEY = "revu_anonymous_id";

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
    // Storage blocked (private mode / cookies off) → ephemeral per-load id.
    return uuid();
  }
}

/**
 * Manages anonymous/identified identity and the current session.
 */
export class Identity {
  constructor() {
    /** @type {string} */
    this.anonymousId = loadAnonymousId();
    /** @type {string|null} */
    this.userId = null;
    /** @type {string} */
    this.sessionId = uuid();
  }

  /**
   * Link the current anonymous id to the customer's user id (on login/register).
   * @param {string} userId
   */
  identify(userId) {
    if (typeof userId === "string" && userId.length > 0) {
      this.userId = userId;
    }
  }

  /** Clear the identified user (on logout) - keeps the anonymous id. */
  reset() {
    this.userId = null;
    this.sessionId = uuid();
  }
}
