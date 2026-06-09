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
 * @property {boolean} [autoIdentify=true] Auto-generate a persistent user id on first visit so every event arrives attributed to a stable visitor. Explicit `identify()` always overrides and is also persisted. Set to false to keep `user_id` null until the host app calls `identify()`.
 * @property {"localStorage"|"cookie"|"both"} [persistentStorage="both"] Where identity ids are persisted across reloads. `"both"` mirrors to localStorage and a first-party cookie so an eviction of one store is recoverable from the other (defends against Safari ITP wiping localStorage). `"localStorage"` removes the per-request cookie bandwidth on the host domain. `"cookie"` is rarely the right choice but available for completeness.
 * @property {string|null} [cookieDomain=null] When the cookie store is active, the Domain attribute written on the identity cookie. Set to ".example.com" to share one visitor id across subdomains (app.example.com + www.example.com). Unset by default so the cookie stays host-only.
 * @property {boolean} [maskAllInputs=true] Never read input field values (redact-at-source).
 * @property {number} [flushIntervalMs=5000] Max time before a partial batch is sent.
 * @property {number} [flushAt=20]         Queue size that triggers an immediate flush.
 * @property {number} [maxBatch=50]        Max events sent per request (bounds request body size).
 * @property {number} [maxQueue=1000]      Hard cap on durably-queued events; oldest are pruned first.
 * @property {boolean} [debug=false]       Log captured events to the console.
 * @property {(event: RevuEvent) => void} [onEvent] Optional hook called for every captured event (debug overlays, tests).
 * @property {boolean} [captureWebVitals=true] Emit `$web_vital` events for LCP, INP, and CLS on page hide. Pure-observer, zero PII.
 * @property {boolean} [captureAttention=true] Emit `$tab_hidden`, `$tab_visible`, `$idle`, and `$active` events as the user's attention to the page changes. The engagement clock that powers `$page_leave`'s `engagement_time_ms` always runs regardless of this flag.
 * @property {number} [idleTimeoutMs=30000] Milliseconds of no mouse / keyboard / scroll / touch activity before the user is considered idle. Setting to 0 disables idle detection entirely (engagement_time_ms then ticks as long as the tab is visible).
 * @property {number} [sessionTimeoutMs=1800000] How long (in ms) a session can sit idle before the next SDK construction rotates to a fresh `session_id`. Default 30 minutes. Set to 0 to disable continuation entirely so every page load gets a brand new session.
 * @property {RevuPlugin[]} [plugins]      Plugins to install during `init()`. Equivalent to calling `revu.use(plugin)` for each, but co-located with the rest of the config.
 */

/**
 * A REVU plugin. Plugins extend the SDK with new event types or behaviors
 * without bloating the core. They receive a small API surface at install
 * time and can call `record()` to emit events through the same pipeline
 * (identity, environment context, transport) as built-in autocapture.
 *
 * Distribution is orthogonal to the plugin contract:
 *   - Subpath plugins live inside `@revu-ai/core` (e.g. `@revu-ai/core/exceptions`)
 *     and tree-shake out when not registered.
 *   - Separate packages (e.g. a future `@revu-ai/replay`) implement the same
 *     contract but ship their own npm publication. Use a separate package when
 *     the feature exceeds ~5 kB gzipped, has its own ingest endpoint, has a
 *     materially different privacy posture, or needs independent versioning.
 *
 * @typedef {object} RevuPlugin
 * @property {string} name                  Unique plugin id. Installing the same `name` twice is a no-op.
 * @property {(api: PluginApi) => void} install  Called once at SDK start (or immediately on `use()` if start has already happened).
 * @property {() => void} [uninstall]       Optional teardown hook for plugins that wire listeners or timers.
 */

/**
 * The API surface a plugin sees at install time. Deliberately minimal: a
 * plugin emits events through `record`, reads identity / context / config,
 * and does its own DOM / network / browser-API work as needed.
 *
 * @typedef {object} PluginApi
 * @property {(eventType: string, data?: { fingerprint?: Fingerprint, properties?: Record<string, unknown> }) => void} record  Emit an event through the standard pipeline.
 * @property {import("./identity.js").Identity} identity  Read-only access to the current ids.
 * @property {import("./context.js").Context} context     Read-only access to the environment context builder.
 * @property {ResolvedConfig} config        Read-only access to the resolved config.
 */

/**
 * A fully-resolved config (defaults applied). @see RevuConfig
 * @typedef {Required<RevuConfig>} ResolvedConfig
 */

/**
 * The element fingerprint for an auto-captured interaction. A semantic,
 * weighted summary of the element (tag, role, visible text, classes, a short
 * selector path, sibling ordinal) so the server can later name the action and
 * match it across DOM rewrites without an exact selector.
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
 * @property {string|null} user_id         Identified visitor id. With autoIdentify (default), a persistent UUID is assigned on first visit and stays attached until the host app overrides it via identify(). With autoIdentify off, null until identify() is called.
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
