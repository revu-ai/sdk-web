/**
 * @file Small, dependency-free helpers shared across the core (DRY).
 */

/**
 * RFC4122-ish v4 UUID. Uses `crypto.randomUUID` when available, else a fallback.
 * @returns {string}
 */
export function uuid() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Fallback (older browsers): not cryptographically strong, fine for an anonymous id.
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/** @returns {string} ISO-8601 timestamp for "now". */
export function nowIso() {
  return new Date().toISOString();
}

/**
 * Wrap a function so it can NEVER throw into the host page. This is the
 * cardinal SDK invariant: an analytics SDK that breaks the host site is
 * worse than no SDK at all. Errors are swallowed and, in debug, logged.
 * @template {(...args: any[]) => any} F
 * @param {F} fn
 * @param {(err: unknown) => void} [onError]
 * @returns {(...args: Parameters<F>) => ReturnType<F> | undefined}
 */
export function safe(fn, onError) {
  return function safeWrapped(...args) {
    try {
      return fn(...args);
    } catch (err) {
      if (onError) onError(err);
      return undefined;
    }
  };
}

/**
 * Truncate a string to a max length (keeps payloads small; avoids leaking long values).
 * @param {string|null|undefined} value
 * @param {number} [max=255]
 * @returns {string|undefined}
 */
export function truncate(value, max = 255) {
  if (value == null) return undefined;
  const s = String(value);
  return s.length > max ? s.slice(0, max) : s;
}

/**
 * The current "route" path used as the screen/page identifier. Combines
 * pathname with the hash so a hash-router app (e.g. `/#/pricing`) treats each
 * hash as a distinct route, and plain anchor navigation (e.g. `#section-2`)
 * is also visible as a separate screen. SSR-safe: returns "" when there is
 * no `location`.
 * @returns {string}
 */
export function routePath() {
  if (typeof location === "undefined") return "";
  return location.pathname + location.hash;
}
