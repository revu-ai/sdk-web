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
 * @property {"production"|"staging"|"development"} [environment="production"] Environment label stamped on every event as `properties.$environment`. The dashboard filters out non-production environments by default so dev clicks and staging integration tests do not pollute production analytics. Invalid values throw at init.
 * @property {boolean} [autocapture=true]  Auto-capture clicks + page views with no instrumentation.
 * @property {boolean} [autoIdentify=false] When true, auto-generate a persistent user id on first visit. Off by default: anonymous visitors are identified by `anonymous_id` alone and `user_id` stays null until the host app calls `identify()`, so any non-null `user_id` means a real authenticated user. This keeps the analytics model clean (anonymous vs identified is unambiguous) and lets the server safely refuse to merge two different accounts. Turning it on reintroduces a per-device auto id that looks identified before login; not recommended.
 * @property {"localStorage"|"cookie"|"both"} [persistentStorage="both"] Where identity ids are persisted across reloads. `"both"` mirrors to localStorage and a first-party cookie so an eviction of one store is recoverable from the other (defends against Safari ITP wiping localStorage). `"localStorage"` removes the per-request cookie bandwidth on the host domain. `"cookie"` is rarely the right choice but available for completeness.
 * @property {string|null} [cookieDomain=null] When the cookie store is active, the Domain attribute written on the identity cookie. Set to ".example.com" to share one visitor id across subdomains (app.example.com + www.example.com). Unset by default so the cookie stays host-only.
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
 * @property {number} [sessionMaxMs=86400000] Absolute cap on a session's total length. Even a continuously-active session rotates once it has been alive this long (default 24 hours), so a long-lived tab, kiosk, or always-on dashboard does not accumulate one multi-day session that skews duration and engagement. Set to 0 to disable the cap.
 * @property {number} [sampleRate=1] Fraction of sessions to capture, in [0, 1]. `1` captures everything (default); `0.1` keeps roughly 10% of sessions and drops the rest before they are queued, trading dashboard precision for ingest volume on high-traffic sites. The decision is session-sticky (a whole session is kept or dropped, never half), and identity events (`$identify`, `$reset`, `$alias`) are always sent so person-stitching stays correct. Kept sampled (non-identity) events carry `context.sample_rate` so the server can scale aggregates; identity events never carry it (they are not sampled). Out-of-range values throw at init.
 * @property {boolean} [honorGpc=false] When true, a browser Global Privacy Control signal defaults the `analytics` consent category to denied (suppressing capture) unless the visitor has already made an explicit choice, which always wins. Default false: honoring GPC is the host's jurisdictional decision (a valid opt-out signal under CCPA/CPRA, but not the consent mechanism under GDPR), and auto-denying would silently drop data on upgrade. The GPC signal is stamped on every event as `context.gpc` regardless of this flag, so the server can act on it either way.
 * @property {((event: RevuEvent) => RevuEvent | null | false | void) | null} [beforeSend=null] Last-mile hook called with each fully-built event just before it is queued. Return the event (mutated in place or a replacement object) to send it, `null` or `false` to drop it, or nothing to send it unchanged. Use it to enrich events with host context, redact a field, or filter noisy events. Fail-open: a throwing hook logs in debug and sends the original event rather than dropping it, so a bug never silently deletes analytics. The returned event's `properties` are re-sanitized to a JSON-safe shape so a hook cannot poison the durable queue.
 * @property {string[]} [autocaptureAllowSelectors=[]] When non-empty, restricts element-targeted autocapture (clicks, right-clicks, form-control changes) to elements matching - or nested inside - one of these CSS selectors. Everything else is not autocaptured. An empty list (the default) captures everything.
 * @property {string[]} [autocaptureDenySelectors=[]] CSS selectors whose elements (and their descendants) are excluded from element-targeted autocapture. Deny wins over `autocaptureAllowSelectors`. A complement to `data-revu-mask` (which redacts an element's fingerprint but still emits the event): a deny selector suppresses the event entirely, including the file-download / outbound-link / rage events derived from a click.
 * @property {RevuPlugin[]} [plugins]      Plugins to install during `init()`. Equivalent to calling `revu.use(plugin)` for each, but co-located with the rest of the config.
 */

/**
 * Per-category consent state. Each known category maps to "granted" or
 * "denied". `analytics` is the only category that gates capture (denied
 * suppresses every event); `marketing` and `functional` are declarative
 * signals stamped on events (`context.consent`) for the server to honor on
 * downstream destinations.
 * @typedef {Record<"analytics"|"marketing"|"functional", "granted"|"denied">} ConsentState
 */

/**
 * The public SDK singleton returned as the default export of `@revu-ai/core`
 * (and installed at `window.revu` by the IIFE build). Declared explicitly so
 * consumers who `import revu from "@revu-ai/core"` get full parameter types
 * and inline docs on every method, rather than the `any`-typed surface a
 * generated declaration would otherwise infer through the `safe()` wrapper.
 *
 * @typedef {object} Revu
 * @property {(config: RevuConfig) => void} init  Initialize the SDK (idempotent; later calls are ignored).
 * @property {(plugin: RevuPlugin) => void} use   Register a plugin (queued before `init()`, installed immediately after).
 * @property {(eventType: string, properties?: Record<string, unknown>) => void} capture  Capture a custom event. Empty / non-string names are ignored; properties are sanitized to a JSON-safe shape.
 * @property {(userId: string) => void} identify  Link the anonymous visitor to a known user id.
 * @property {(authoritativeId: string) => void} alias  Join the current identity to a separate authoritative id (cross-device stitching).
 * @property {() => void} reset                   Sign-out: clear the user, rotate the session, emit `$reset`.
 * @property {() => void} optOut                  Stop all capture for this visitor and persist the choice (alias for denying the `analytics` consent category).
 * @property {() => void} optIn                   Resume capture after a prior `optOut()` and persist the choice (alias for granting the `analytics` consent category).
 * @property {() => boolean} hasOptedOut          Whether capture is currently suppressed (the `analytics` category is denied).
 * @property {{ set: (categories: Record<string, "granted"|"denied">) => void, get: () => ConsentState }} consent  Category-level consent control. `set()` merges a partial category map and persists it (denying `analytics` is equivalent to `optOut()`); `get()` returns the current state. Only `analytics` gates capture; `marketing` / `functional` are stamped on events for the server to honor. Before `init()`, `set()` is a no-op and `get()` returns the all-granted default.
 * @property {() => (Promise<boolean>|undefined)} flush  Flush buffered events immediately.
 * @property {string} version                     Build version of `@revu-ai/core` baked into this bundle.
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
 * @property {string} [aria_label]         Value of `aria-label` attribute when present (truncated; masked if sensitive). Lets the server name icon-only buttons that have no visible text.
 * @property {string} [title]              Value of the `title` attribute when present (truncated; masked if sensitive). Used as a fallback label after text and aria-label.
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
 * @property {string|null} user_id         Identified visitor id. Null by default (autoIdentify off) until the host app calls identify(), so a non-null value always denotes a real authenticated user. With autoIdentify on, a persistent UUID is assigned on first visit instead.
 * @property {string} session_id           Per-session UUID.
 * @property {number} sequence_no          Per-page-load monotonic counter, starting at 0 on each SDK construction. Detects event loss *within* a single page load (a gap means a dropped event). It does NOT span a session: a session continued across reloads / tabs restarts the counter at 0 each load, so loss detection across loads relies on `event_id` (the dedupe key) rather than this field. A true per-session counter is deferred until the cross-tab queue mutex lands (sharing one counter across tabs without it would race).
 * @property {"web"} platform              Capture platform.
 * @property {string} event_type           "$pageview" | "$autocapture" | custom name.
 * @property {string} screen               Route/path at capture time.
 * @property {Fingerprint} [fingerprint]   Present for $autocapture interactions.
 * @property {Record<string, unknown>} context  Engine environment, unprefixed: the session-stable + per-event signals the SDK auto-populates (`user_agent`, `language`, `timezone`, `screen_*`, `viewport_*`, `online`, `connection_*`, `environment`, `sdk_version`, `consent`, `gpc`, `sample_rate`, and attribution `initial_utm_*` / `utm_*` / `gclid` / `fbclid` / `initial_landing_path` / `initial_seen_at`). Describes the environment the event happened in; kept separate from `properties` so it never collides with caller payload (the de-facto context-vs-properties shape).
 * @property {Record<string, unknown>} properties The event's own payload: capture-layer fields (`path`, `url`, `depth_percent`, form structure, ...) and caller-supplied custom properties from `capture()`. Masked, PII-free, never input values.
 * @property {string} device_time          ISO-8601 capture timestamp.
 */

/**
 * Transport sink - sends a batch of events. Returns true on success.
 * @callback SendFn
 * @param {RevuEvent[]} batch
 * @returns {Promise<boolean>}
 */

export {};
