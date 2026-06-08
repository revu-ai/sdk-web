/**
 * @file Storage - first-party persistence for identity ids across reloads.
 *
 * Identity ids (anonymous, user) live in two stores by default:
 *
 *   - localStorage  - zero per-request bandwidth and a large quota; the
 *                     industry default for analytics SDKs. Vulnerable to
 *                     Safari ITP eviction (~7 days without user interaction)
 *                     and any explicit "Clear site data".
 *   - first-party cookie - ships on every request to the host domain (small,
 *                     one UUID per cookie) but survives some Safari paths
 *                     that wipe localStorage. Can also span subdomains when
 *                     `cookieDomain` is set, which localStorage cannot do.
 *
 * In "both" mode (the default) we write to both stores on every mutation
 * and read with cookie-wins reconciliation: if both have a value and they
 * differ, the cookie wins because it tends to be the more durable of the
 * two; if only one has a value, the other is rehydrated on read so the
 * stores stay in sync for the next page load.
 *
 * Every operation is best-effort: a throwing or absent store falls
 * through to the next one, and the SDK keeps working with an in-memory
 * id for the rest of the page lifetime if both stores are blocked.
 *
 * Nothing client-side is truly forever; a user clearing site data, a
 * private window, or a different device all reset the ids. For
 * cross-device, post-clear identity the host app must call
 * `revu.identify(authUserId)` once it knows who the user is.
 */

const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365 * 2; // ~2 years

/**
 * @typedef {"localStorage" | "cookie" | "both"} StorageMode
 */

/**
 * @typedef {object} Storage
 * @property {(key: string) => (string|null)} read
 * @property {(key: string, value: string) => void} write
 * @property {(key: string) => void} remove
 */

/**
 * Build a storage facade for the configured persistence mode.
 *
 * @param {object} [options]
 * @param {StorageMode} [options.mode="both"]   Which stores to write to.
 * @param {string|null} [options.cookieDomain]  When set, written as the
 *   cookie's Domain attribute so it spans subdomains (e.g. ".example.com"
 *   shares one id between app.example.com and www.example.com). Unset by
 *   default - the cookie stays host-only.
 * @returns {Storage}
 */
export function createStorage(options = {}) {
  const mode = options.mode || "both";
  const cookieDomain = options.cookieDomain || null;
  const useLocalStorage = mode !== "cookie";
  const useCookie = mode !== "localStorage";

  return {
    read(key) {
      const fromCookie = useCookie ? readCookie(key) : null;
      const fromLs = useLocalStorage ? readLocalStorage(key) : null;
      // Cookie wins when both stores hold a non-empty value: it survives
      // a subset of Safari ITP scenarios that wipe localStorage, so a
      // disagreement most likely means "localStorage was repopulated by
      // a stale path; trust the cookie".
      const value = fromCookie || fromLs;
      if (!value) return null;
      // Repair: rehydrate the empty store from the surviving one so the
      // next page load sees consistent state without re-running this
      // reconciliation path.
      if (useLocalStorage && fromLs !== value) writeLocalStorage(key, value);
      if (useCookie && fromCookie !== value) writeCookie(key, value, cookieDomain);
      return value;
    },

    write(key, value) {
      if (useLocalStorage) writeLocalStorage(key, value);
      if (useCookie) writeCookie(key, value, cookieDomain);
    },

    remove(key) {
      if (useLocalStorage) removeLocalStorage(key);
      if (useCookie) removeCookie(key, cookieDomain);
    },
  };
}

// ---------------------------------------------------------------------------
// localStorage
// ---------------------------------------------------------------------------

/** @param {string} key @returns {string|null} */
function readLocalStorage(key) {
  try {
    return localStorage.getItem(key) || null;
  } catch {
    return null;
  }
}

/** @param {string} key @param {string} value */
function writeLocalStorage(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Quota full, private mode, or storage disabled - in-memory only.
  }
}

/** @param {string} key */
function removeLocalStorage(key) {
  try {
    localStorage.removeItem(key);
  } catch {
    // Best-effort.
  }
}

// ---------------------------------------------------------------------------
// First-party cookie
// ---------------------------------------------------------------------------
// Attributes: Path=/ so the cookie is sent on every request to the host
// domain (analytics covers the whole site, not one route). Max-Age=2y
// gives a long-but-finite lifetime - browsers cap effective cookie age
// in many cases, so going to "100 years" buys nothing. SameSite=Lax is
// the safe default (blocks cross-site CSRF without breaking top-level
// navigations). Secure is added on https origins so the cookie is never
// sent over plaintext. No HttpOnly: the SDK must be able to read the
// value from JS to mirror it back to localStorage and to construct
// outgoing events.

/** @param {string} name @returns {string|null} */
function readCookie(name) {
  try {
    if (typeof document === "undefined") return null;
    const raw = document.cookie;
    if (!raw) return null;
    const prefix = encodeURIComponent(name) + "=";
    for (const part of raw.split("; ")) {
      if (part.startsWith(prefix)) {
        const value = decodeURIComponent(part.slice(prefix.length));
        return value || null;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** @param {string} name @param {string} value @param {string|null} domain */
function writeCookie(name, value, domain) {
  try {
    if (typeof document === "undefined") return;
    const parts = [
      `${encodeURIComponent(name)}=${encodeURIComponent(value)}`,
      "Path=/",
      `Max-Age=${COOKIE_MAX_AGE_SECONDS}`,
      "SameSite=Lax",
    ];
    if (domain) parts.push(`Domain=${domain}`);
    if (typeof location !== "undefined" && location.protocol === "https:") {
      parts.push("Secure");
    }
    document.cookie = parts.join("; ");
  } catch {
    // Best-effort.
  }
}

/** @param {string} name @param {string|null} domain */
function removeCookie(name, domain) {
  try {
    if (typeof document === "undefined") return;
    const parts = [
      `${encodeURIComponent(name)}=`,
      "Path=/",
      "Max-Age=0",
      "SameSite=Lax",
    ];
    if (domain) parts.push(`Domain=${domain}`);
    document.cookie = parts.join("; ");
  } catch {
    // Best-effort.
  }
}
