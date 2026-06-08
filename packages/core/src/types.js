/**
 * @file Shared type definitions for the REVU Web SDK core.
 * JSDoc is the single source of truth for types - `tsc` generates `.d.ts`
 * from these at build time (DRY: docs + types in one place).
 */

/**
 * User-supplied configuration passed to {@link init}.
 * @typedef {object} RevuConfig
 * @property {string} apiKey               Public ingest write-key (org/entity resolved server-side).
 * @property {string} [host="https://api.revu.ai"] Ingest host base URL (the API service, not the app/dashboard).
 * @property {boolean} [autocapture=true]  Auto-capture clicks + page views with no instrumentation.
 * @property {boolean} [maskAllInputs=true] Never read input field values (redact-at-source).
 * @property {number} [flushIntervalMs=5000] Max time before a partial batch is sent.
 * @property {number} [flushAt=20]         Queue size that triggers an immediate flush.
 * @property {number} [maxBatch=50]        Max events sent per request (bounds request body size).
 * @property {number} [maxQueue=1000]      Hard cap on durably-queued events; oldest are pruned first.
 * @property {boolean} [debug=false]       Log captured events to the console.
 * @property {(event: RevuEvent) => void} [onEvent] Optional hook called for every captured event (debug overlays, tests).
 */

/**
 * A fully-resolved config (defaults applied). @see RevuConfig
 * @typedef {Required<RevuConfig>} ResolvedConfig
 */

/**
 * The element fingerprint for an auto-captured interaction.
 * Semantic-weighted, fuzzy-matchable - see corpus Canonical-Behavior-Schemas §2.
 * @typedef {object} Fingerprint
 * @property {string} tag                  Element tag (e.g. "button").
 * @property {string} [text]               Visible text (truncated; masked if sensitive).
 * @property {string} [role]               ARIA role / type.
 * @property {string} [id]                 Element id, if present (stable).
 * @property {string[]} [classes]          Class list (medium stability).
 * @property {string} selector             A best-effort CSS selector (fragile; tiebreaker).
 * @property {number} [ordinal]            Position among siblings.
 */

/**
 * A single captured behavioral event (pre-ingest shape).
 * @typedef {object} RevuEvent
 * @property {string} event_id             Client-generated UUID - idempotency/dedupe key.
 * @property {string} anonymous_id         First-party device/session UUID.
 * @property {string|null} user_id         Customer account id once identified, else null.
 * @property {string} session_id           Per-session UUID.
 * @property {number} sequence_no          Per-session monotonic counter (gap = loss).
 * @property {"web"} platform              Capture platform.
 * @property {string} event_type           "$pageview" | "$autocapture" | custom name.
 * @property {string} screen               Route/path at capture time.
 * @property {Fingerprint} [fingerprint]   Present for $autocapture interactions.
 * @property {Record<string, unknown>} properties Masked, PII-free context.
 * @property {string} device_time          ISO-8601 capture timestamp.
 */

/**
 * Transport sink - sends a batch of events. Returns true on success.
 * @callback SendFn
 * @param {RevuEvent[]} batch
 * @returns {Promise<boolean>}
 */

export {};
