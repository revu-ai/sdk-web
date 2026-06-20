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

/** Max nesting depth retained when sanitizing caller-supplied properties. */
const SANITIZE_MAX_DEPTH = 6;

/**
 * Produce a JSON-serializable copy of caller-supplied event properties.
 *
 * Custom `capture()` properties are untrusted input: a host can pass a value
 * the transport's `JSON.stringify` cannot encode (a circular reference, a
 * `BigInt`, a function, a DOM node, a getter that throws). Left unchecked,
 * one such value poisons the durable queue - the bad event sits at the head
 * and every flush re-throws on it, so nothing ships again. We defuse that at
 * the source: only the wire-safe leaf types documented for event properties
 * (string, finite number, boolean, null) survive; nested plain objects and
 * arrays are cloned with cycle detection and a depth cap; everything else is
 * dropped (a non-finite number becomes null, matching native JSON behavior).
 *
 * Returns undefined for non-object input so the caller can fall back to "no
 * properties" cleanly. Never throws.
 *
 * @param {unknown} input
 * @returns {Record<string, unknown>|undefined}
 */
export function sanitizeProperties(input) {
  if (input == null || typeof input !== "object" || Array.isArray(input)) return undefined;
  const seen = new Set();
  const out = sanitizeValue(input, seen, 0);
  return /** @type {Record<string, unknown>|undefined} */ (out) || undefined;
}

/**
 * Recursively coerce a value to its JSON-safe form, or undefined when it has
 * no wire-safe representation (so the caller drops the key/element).
 * @param {unknown} value
 * @param {Set<object>} seen   Ancestor objects, for cycle detection.
 * @param {number} depth
 * @returns {unknown}
 */
function sanitizeValue(value, seen, depth) {
  if (value === null) return null;
  const type = typeof value;
  if (type === "string" || type === "boolean") return value;
  if (type === "number") return Number.isFinite(/** @type {number} */ (value)) ? value : null;
  // bigint, function, symbol, undefined: no JSON representation - drop.
  if (type !== "object") return undefined;
  if (depth >= SANITIZE_MAX_DEPTH) return undefined;
  const obj = /** @type {object} */ (value);
  if (seen.has(obj)) return undefined; // cycle: drop the back-reference.
  // Objects exposing toJSON (e.g. Date) get to define their own wire form;
  // re-run the result through the sanitizer so a throwing/odd toJSON cannot
  // smuggle an unserializable value back in.
  const toJson = /** @type {{ toJSON?: () => unknown }} */ (obj).toJSON;
  if (typeof toJson === "function") {
    try {
      return sanitizeValue(toJson.call(obj), seen, depth);
    } catch {
      return undefined;
    }
  }
  seen.add(obj);
  try {
    if (Array.isArray(obj)) {
      const arr = obj.map((item) => {
        const clean = sanitizeValue(item, seen, depth + 1);
        // JSON renders a dropped array slot as null; preserve positions.
        return clean === undefined ? null : clean;
      });
      return arr;
    }
    /** @type {Record<string, unknown>} */
    const result = {};
    for (const key of Object.keys(obj)) {
      let raw;
      try {
        raw = /** @type {Record<string, unknown>} */ (obj)[key];
      } catch {
        continue; // a throwing getter: skip this key.
      }
      const clean = sanitizeValue(raw, seen, depth + 1);
      if (clean !== undefined) result[key] = clean;
    }
    return result;
  } finally {
    seen.delete(obj);
  }
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
