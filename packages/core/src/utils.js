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
 * Deterministic 32-bit string hash (FNV-1a). Stable across reloads and
 * platforms, so a value derived from it (e.g. session-sticky sampling) makes
 * the same decision everywhere for the same input. Not cryptographic.
 * @param {string} str
 * @returns {number} An unsigned 32-bit integer.
 */
export function hashUint32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    // h *= 16777619, via shifts to stay in 32-bit integer math.
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
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
 * Query-parameter keys whose VALUES must never leave the browser. Matched
 * case-insensitively against whole keys or `_`/`-`-delimited segments, so
 * `token`, `access_token`, `reset-token`, and `user_email` all hit while
 * benign keys (`utm_source`, `gclid`, `key`, `code`, `state`) do not - that
 * matters because the server derives campaign attribution from the URL's
 * query, so the scrub must preserve UTM and click ids while removing
 * credentials and PII.
 */
const SENSITIVE_PARAM_KEY =
  /(^|[_-])(password|passwd|pwd|secret|token|auth|authorization|otp|ssn|apikey|api_key|access_key|client_secret|jwt|bearer|signature|sig|sessionid|session|sid|email)($|[_-])/i;

/** Placeholder written in place of a redacted query value. */
const REDACTED = "[redacted]";

/**
 * Redact the VALUES of sensitive parameters in an absolute URL - in both the
 * query string AND the fragment - while leaving the path and every
 * non-sensitive parameter intact. Capturing a pageview should never ship a
 * password-reset token or an email address that happened to ride in the URL,
 * but it must keep UTM / click-id params so server-side attribution still
 * works, so this scrubs by key, not wholesale. The fragment is covered
 * because the OAuth/OIDC implicit flow returns tokens after the `#`
 * (`#access_token=...`). Returns the input unchanged when nothing sensitive is
 * present, it is not an absolute URL, or it is not a string. Never throws.
 *
 * @param {string} url
 * @returns {string}
 */
export function scrubUrl(url) {
  if (typeof url !== "string" || url.length === 0) return url;
  try {
    const parsed = new URL(url);
    let changed = false;
    // Snapshot keys before mutating; set() collapses duplicates, which is
    // fine for the credential-bearing params we target.
    for (const key of [...parsed.searchParams.keys()]) {
      if (SENSITIVE_PARAM_KEY.test(key)) {
        parsed.searchParams.set(key, REDACTED);
        changed = true;
      }
    }
    // Fragment credentials (implicit-flow tokens, hash-router query) never
    // touch `search`, so scrub them separately.
    const scrubbedHash = scrubFragment(parsed.hash);
    if (scrubbedHash !== parsed.hash) {
      parsed.hash = scrubbedHash;
      changed = true;
    }
    return changed ? parsed.toString() : url;
  } catch {
    // Relative or malformed URL: nothing safe to parse, leave it as-is.
    return url;
  }
}

/**
 * Redact sensitive `key=value` params carried in a URL fragment, leaving the
 * route portion of a hash-router path and any non-sensitive params intact.
 * Handles both `#access_token=...` (OAuth/OIDC implicit flow, no leading `?`)
 * and `#/route?token=...` (hash router with a query). Returns the fragment
 * unchanged when it carries no `key=value` pairs (a plain `#/route` or
 * `#anchor`) or no sensitive key, so non-credential fragments are never
 * normalized. Accepts a fragment with or without the leading `#` and preserves
 * whichever form it was given. Never throws.
 *
 * @param {string} hash
 * @returns {string}
 */
export function scrubFragment(hash) {
  if (!hash || hash.indexOf("=") === -1) return hash;
  const hasHashPrefix = hash.charAt(0) === "#";
  const body = hasHashPrefix ? hash.slice(1) : hash;
  const qIndex = body.indexOf("?");
  const routePart = qIndex === -1 ? "" : body.slice(0, qIndex);
  const queryPart = qIndex === -1 ? body : body.slice(qIndex + 1);
  if (queryPart.indexOf("=") === -1) return hash;
  let params;
  try {
    params = new URLSearchParams(queryPart);
  } catch {
    return hash;
  }
  let changed = false;
  for (const key of [...params.keys()]) {
    if (SENSITIVE_PARAM_KEY.test(key)) {
      params.set(key, REDACTED);
      changed = true;
    }
  }
  if (!changed) return hash;
  const rebuiltBody = qIndex === -1 ? params.toString() : `${routePart}?${params.toString()}`;
  return hasHashPrefix ? `#${rebuiltBody}` : rebuiltBody;
}

/**
 * Read the browser's Global Privacy Control signal. Returns the boolean when
 * the property is present (a user agent that advertises GPC), or undefined
 * when the platform does not expose it (most browsers today). The value is
 * session-stable: it does not change inside a single page load. SSR-safe;
 * never throws.
 * @returns {boolean|undefined}
 */
export function readGpc() {
  try {
    if (typeof navigator === "undefined") return undefined;
    const value = /** @type {{ globalPrivacyControl?: unknown }} */ (navigator)
      .globalPrivacyControl;
    return typeof value === "boolean" ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The current "route" path used as the screen/page identifier. Combines
 * pathname with the hash so a hash-router app (e.g. `/#/pricing`) treats each
 * hash as a distinct route, and plain anchor navigation (e.g. `#section-2`)
 * is also visible as a separate screen. The hash is run through
 * {@link scrubFragment} so a credential-bearing fragment (an OAuth
 * implicit-flow `#access_token=...` landing) never lands in `screen` /
 * `properties.path`. SSR-safe: returns "" when there is no `location`.
 * @returns {string}
 */
export function routePath() {
  if (typeof location === "undefined") return "";
  return location.pathname + scrubFragment(location.hash);
}
