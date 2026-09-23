# Changelog

All notable changes to `@revu-ai/core` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] - 2026-09-23

Give the server a second, independent source for the browser a visitor claims to be, so automated traffic that wears a convincing user agent can be caught by contradiction rather than by pattern matching a string against itself.

### Added

- **`context.ua_brands` / `context.ua_mobile` / `context.ua_platform`.** The low-entropy User-Agent Client Hints, read synchronously from `navigator.userAgentData` and stamped on every event. The browser engine generates these, so a client that sets a UA header or redefines `navigator.userAgent` does not get matching hints to go with it, and the server can cross-check one source against the other. Chromium and secure contexts only, so the trio is absent on Safari, Firefox, and plain-http pages and is simply omitted there. The brand list is passed through as reported, including the randomized GREASE entry, which the server compares verbatim. The high-entropy set (`getHighEntropyValues()`) is deliberately not read: it is asynchronous, so it would miss the first `$pageview` that the server pins the visitor's type from, and the full version list, platform version, and device model are fingerprinting-relevant.
- **`context.languages`.** The browser's ordered language list (the plural `navigator.languages`, alongside the existing singular `context.language`). An empty list is stamped rather than omitted, because an empty list is itself the signal. Low entropy: the same information already rides every request as `Accept-Language`.
- **`context.navigation_type`.** The Navigation Timing entry type for this page load (`navigate`, `reload`, `back_forward`, or `prerender`), so a genuine landing can be told apart from a reload or a back-forward. Both attribution models key off the visitor's first `$pageview` and could not previously distinguish the three.

### Fixed

- **The page-hide batch is no longer lost.** The terminal flush delivered its batch with `navigator.sendBeacon` and a body typed `application/json`. That is not a CORS-safelisted request content type, so cross-origin the request needs a preflight and a beacon does not survive one; every site is cross-origin to the ingest host. `sendBeacon` still reported success, and the batch was dropped from the durable queue on the strength of it, so the events were gone with no retry and no error. Measured across Chromium, Safari and Firefox: the beacon never arrived, while `fetch` with `keepalive` arrived in all three during a real unload. The terminal flush now uses `fetch` with `keepalive`. This was losing `$page_leave` and its `engagement_time_ms`, the `$web_vital` events (LCP, INP and CLS are emitted on page hide by design) and the last events of every session that ended by navigation or close, in every release so far.
- **A batch can no longer outgrow what the browser will send.** `maxBatch` bounds a batch by event count, which says nothing about its serialized size, and a browser refuses a `keepalive` request whose body exceeds roughly 64 KiB (measured: 64 KiB accepted, 65 KiB rejected, and less than that when another such request is in flight, since the quota is shared per origin). Both send paths set `keepalive`, so a batch of events carrying rich properties could be refused on every attempt and wedge the durable queue behind it indefinitely. A batch is now halved until it fits and the remainder waits for the next flush. A single event too large to split is sent without `keepalive` on the normal path, where the page is alive and the limit does not apply, rather than being dropped or retried forever.
- **A batch is removed from the queue by identity, not by position.** Confirmation is asynchronous now, so a terminal send and a normal send can be in flight over the same batch, and whichever confirms first shifts the queue. Removing "the oldest N" at that point would delete whatever had moved to the head, including events that were never sent. Each confirmation now removes exactly the events it delivered, so any interleaving is safe.
- **A terminal batch is sent once, not twice.** A desktop close fires both `pagehide` and `visibilitychange -> hidden`. The old path committed synchronously, so the second signal found an empty queue; with asynchronous confirmation the second signal would have re-sent the batch the first was still delivering. A send already in flight now suppresses the duplicate.
- **A failure that throws instead of rejecting can no longer escape the page-hide flush.** `fetch` throws synchronously under a CSP `connect-src` block, and on a page that has replaced it with something of its own. The terminal request is deliberately not awaited, so such an error surfaced in the host page as an unhandled rejection. It is contained now, the batch stays queued, and a later terminal signal can still retry.
- **A confirmed page-hide send now clears the retry backoff.** Each failed flush during an outage lengthens the backoff, up to a minute between attempts. The normal path resets that on a successful send, but the page-hide path did not, so a session that had been backing off kept refusing normal flushes even after a terminal send had confirmed the endpoint was healthy again, leaving a backlog stranded that could have been draining. Both paths now clear it.
- **Nothing leaves the queue unconfirmed.** The terminal batch is now removed only on a confirmed 2xx, which a page that survives the signal does see (a tab switch or a mobile backgrounding fires the hide signal without tearing the page down). When the page really goes away the response never arrives, the batch stays queued and ships on the visitor's next page load, where the endpoint discards it if it already landed, keyed on the client-generated `event_id`. The previous behavior traded that duplicate for a permanently lost batch.


- **Array-valued context fields are no longer shared between events.** `context.ua_brands` and `context.languages` are `FrozenArray` values owned by the browser engine. They are now copied when read and copied again per event, so a `beforeSend` hook that adjusts one event's list cannot leak that edit into every later event on the page, and the engine's own arrays are never handed out. Every other context value is a primitive and was never affected.
- **A hostile `navigator` getter can no longer suppress all capture.** User-agent spoofing extensions and privacy tools replace `navigator` properties with getters of their own, and a badly written one throws on read. Every `navigator` read in the context layer is now guarded, so such a getter costs at most the field it belongs to instead of failing `init()` and leaving the visitor with no analytics. `userAgentData`, the property those tools replace most often, is read last so a throw there cannot cost the signals collected before it.

### Changed

- **The size budget is now one number instead of four.** `packages/core/.size-limit.js` declares a single brotli budget of 10 kB, which is what "cold-loads in single-digit kilobytes" means for a browser downloading the SDK from the CDN, and derives the gzip (fallback transfer) and raw-minified (parse cost) gates from it. Previously each gate was an independent figure, so a gate could be raised on its own to admit a change; now buying room means raising the one budget, which is a deliberate decision rather than a build fix. The raw-minified gate is also expressed as a maximum ratio to compressed size rather than a fixed byte count, so it detects the one thing it usefully can: the bundle growing faster uncompressed than compressed. Brotli was never gated before this, despite being the figure the README quoted.

- **Web Vitals moved out of core into `@revu-ai/core/vitals`.** BREAKING for module consumers. Core's one job is behavioral capture, and page performance is a different question about the same page: a host can reasonably want every click and no vitals, or the reverse. In core it cost every visitor its bytes whether the host wanted it or not, which is what the plugin seam exists to prevent. Core is now 9.31 kB brotli (from 9.83), and the plugin is 0.83 kB that only an importer pays.

  ```js
  import revu from "@revu-ai/core";
  import webVitals from "@revu-ai/core/vitals";

  revu.init({ apiKey: "revu_pk_...", plugins: [webVitals()] });
  ```

  **The `<script>` install is unchanged and needs no action**: a tag consumer has no import to make and cannot tree-shake, so the CDN bundle registers the plugin itself and keeps reporting vitals exactly as before. The `captureWebVitals` option is gone, since installing the plugin or not is now the switch; passing it is simply ignored.
- **The measurement boundary is written down.** `docs/concepts.md` gains "What the SDK measures, and what the server works out", stating the rule the SDK follows: it computes a value only when that value cannot be reconstructed from what it would otherwise send. Scroll depth, engagement time, idle and active durations, and Web Vitals are the entire list, each with the reason it is on it. Everything else, including user agent parsing, campaign attribution from a URL, geography, sessionization and bot classification, is worked out server-side from the events that arrive, so it can be corrected and re-run over history without anyone redeploying.
- **The durable queue is stored in chunks rather than as one blob.** `localStorage.setItem` rewrites whatever it is given in full, so appending one event to a long queue cost a serialization and a write of the *entire* queue, on the capture path, for every event. The queue is now mirrored as a series of 64-event chunks with a small index, so an append rewrites one chunk. Events at the cap are also dropped a block at a time rather than one at a time, because pruning a single event on every append would shift the front and dirty every chunk, undoing the point. The cap is still never exceeded and pruning is still oldest-first. A queue written by an earlier version is read in its old layout and rewritten in chunks on the next append, so an upgrade never loses a pending event.

### Performance

Measured on the built bundle in Safari 27 and Firefox 155, seven interleaved rounds against the previous build, medians reported.

- **Building an event's context costs 0.26 us (Safari) / 0.44 us (Firefox) per event**, up 0.02 us and 0.06 us respectively. The per-event copies of `ua_brands` and `languages` introduced in this release are the reason those numbers moved at all, and they are the smallest part of it.
- **A full `capture()` call no longer gets slower as the queue grows.** On a queue holding 1000 rich events, an append cost about 2.5 ms before the chunked layout and about 0.1 ms after it, and the figure is now flat from an empty queue to a full one instead of rising with depth. This matters most in the case that produces a long queue in the first place: a session capturing steadily while the network is unavailable.
- **A full `capture()` call costs 44 us (Safari) / 58 us (Firefox) per event**, up around 6 us and 4 us. That figure is dominated by the durable queue's synchronous storage write, not by building the event, so it scales with the serialized size of an event rather than with the work done to create one. An event grew by 49 bytes (Safari) / 56 bytes (Firefox), about 6 to 7 percent, and the added time tracks that growth.
- **With the queue at its 1000-event cap**, the worst case, `capture()` costs 164 us (Safari) / 330 us (Firefox). This is the storage write scaling with a full queue and is unchanged in character from previous releases.

### Size

- **Bundle size: 9.35 kB brotli on the wire / 10.41 kB gzipped / 34.02 kB minified**, plus 0.83 kB brotli for the vitals plugin if you import it. The `<script>` bundle, which includes the plugin, is 9.9 kB brotli. The chunked queue accounts for around 0.27 kB of that and buys a 25x reduction in append cost at depth.

## [0.3.0] - 2026-09-05

Capture the browser automation signal so the server can separate headless and synthetic traffic from real visits, even when the automated client wears a normal browser user agent.

### Added

- **`context.webdriver`.** `navigator.webdriver` is stamped on every event when the browser reports automation (Selenium, Playwright, Puppeteer, headless Chrome, and most synthetic monitors), and omitted otherwise so a genuine visit adds no bytes. It rides the session-scoped context like `context.gpc`, so it lands on the first `$pageview` and every subsequent event, which lets the server classify automated traffic that carries a human-looking user agent (a headless browser on a normal UA string, which server-side user-agent parsing cannot catch on its own). Absence means "not automated", consistent with the server treating an unclassified visit as human.

### Size

- **Bundle size: 33.78 kB minified / 10.4 kB gzipped** (around 9 kB brotli on the wire), still under the 34 kB / 12 kB CI gate.

## [0.2.0] - 2026-06-22

Clean, unified identity that does not over-merge on shared devices. A family, home, library, or kiosk computer (one OS login, several people using the same web app) previously risked collapsing into a single person; sequential users on one device are now tracked separately.

### Changed

- **`autoIdentify` now defaults to `false`** (was `true`). Anonymous visitors are identified by `anonymous_id` alone and `user_id` stays `null` until you call `identify()`, so a non-null `user_id` always denotes a real authenticated account. This also makes the dashboard's "identified only" filter meaningful (previously every visitor had an auto id). Set `autoIdentify: true` to restore the old per-device auto id, though it is no longer recommended. Wire impact: pre-login events now ship `user_id: null` instead of an auto UUID.
- **`reset()` now rotates the `anonymous_id`** (in addition to the session and user id). Logout severs the device thread so the next person on a shared device starts a clean identity. A returning user re-unifies by their `user_id` on the next `identify()`, so rotation does not fragment them.
- **`identify()` treats a switch to a different known user as an implicit logout.** When a different account logs in, the SDK emits `$reset`, rotates the `anonymous_id`, and does not stitch the two user ids together, so two accounts never merge just because they shared a device, even if the host did not call `reset()` on logout. An anonymous-to-identified transition still binds the existing device to the user as before.
- **Campaign attribution is now visitor-scoped and cleared on logout.** `reset()` (and the implicit logout above) now clears first-touch and last-touch attribution along with the `anonymous_id`, so the next person on a shared device does not inherit the previous person's acquisition campaign. The server still derives per-event campaign from the `$pageview` URL; only the persisted cross-session copy is rotated.

### Added

- **Debug-mode integration hint.** In `debug: true`, the SDK logs a one-time console hint if events flow for a while without `identify()` ever being called, in case an app with logins forgot to wire it. Silent in production and silent once `identify()` is called; the message notes that intentionally anonymous-only sites can ignore it.
- **Identity integration contract** documented in `docs/concepts.md` (call `identify()` on login, `reset()` on logout, `alias()` to join two accounts) with the shared-device guarantees spelled out per setup.
- **Device-id management API.** `revu.getAnonymousId()` returns the current device id (parity with other SDKs' `getDeviceId()`); `revu.regenerateAnonymousId()` mints a fresh device id on demand, rotating only the device id and leaving the user, session, and consent intact (for an explicit device reset outside the logout flow).

### Size

- **Bundle size: 33.71 kB minified / 10.58 kB gzipped** (around 9 kB brotli on the wire), still under the 34 kB / 12 kB CI gate.

## [0.1.0] - 2026-06-21

First public release. Lean capture core for web behavioral analytics: one-line install, autocapture out of the box, category consent with GPC, client-side campaign attribution, a durable offline queue, persistent first-party identity, and zero runtime dependencies.

### Added

- **One-line boot.** `revu.init({ apiKey })` wires capture, identity, consent, attribution, transport, and the queue in a single call. Every public entry (`init`, `capture`, `identify`, `alias`, `reset`, `optOut`, `optIn`, `hasOptedOut`, `consent.set` / `consent.get`, `flush`, `use`) is wrapped with `safe()` so the SDK can never throw into the host page.
- **Autocapture.** `$pageview` (initial load plus SPA route changes via pushState / replaceState / popstate / hashchange), `$autocapture` (clicks anywhere), `$rightclick`, `$rageclick` (3 clicks on the same target within 1 s), `$scroll` milestones (25 / 50 / 75 / 100%), `$resize` (debounced to settled value), `$form_submit` (field metadata only, never values), `$change` (control type plus checkbox / radio `checked`, never values), `$file_download`, `$outbound_link`, and `$page_restore` (back-forward cache restore). Each element event carries a stable selector fingerprint (tag, text, role, id, classes, ordinal) plus the route path.
- **Engagement layer.** `$page_leave` with `engagement_time_ms` (visible time on the page; hidden time excluded, idle time included), `$tab_hidden` / `$tab_visible` with paired durations, `$idle` / `$active` with paired durations (default `idleTimeoutMs: 30_000`, off when set to `0`). `captureAttention: false` keeps the engagement clock but suppresses the synthetic events.
- **Web Vitals.** `$web_vital` events for LCP, INP, and CLS emitted on terminal page lifecycle (`pagehide` / visibility-hidden). Pure PerformanceObserver, zero runtime dependencies. Disable with `captureWebVitals: false`.
- **Category consent + GPC.** Three consent categories (`analytics`, `marketing`, `functional`) via `revu.consent.set({ ... })` / `revu.consent.get()`, with `revu.optOut()` / `revu.optIn()` / `revu.hasOptedOut()` as aliases for denying / granting `analytics`. Only `analytics` gates capture (a denied analytics category suppresses every event before it is built); `marketing` and `functional` are declarative and stamped on every event as `context.consent` for the server to honor on downstream destinations. Global Privacy Control is stamped as `context.gpc`, and `honorGpc` (default off) defaults `analytics` to denied on a GPC signal unless the visitor has made an explicit choice. State persists in the first-party store; a legacy binary opt-out is honored on upgrade.
- **Campaign attribution.** First touch (`context.initial_utm_*`, `initial_gclid`, `initial_fbclid`, plus `initial_landing_path` / `initial_seen_at`) is captured once and never overwritten; last touch (`context.utm_*`, `gclid`, `fbclid`) refreshes on each new campaign or external-referrer landing. Both persist client-side so a conversion pages or days later still carries the campaign that acquired the visitor; the server still derives a session's immediate landing from the `$pageview` URL.
- **Persistent identity.**
  - `anonymousId` (device-level) generated on first visit and persisted across reloads.
  - `userId` (person-level) with `autoIdentify` default-on: a UUID is auto-generated and persisted; a later `revu.identify("real-id")` replaces it. `revu.reset()` rotates to a fresh auto id.
  - `sessionId` rolls forward across reloads inside a 30-minute continuation window (`sessionTimeoutMs`); set to `0` to give every page load a fresh session. An absolute cap (`sessionMaxMs`, default 24 h) rotates even a continuously-active session so a long-lived tab or kiosk does not accumulate one multi-day session.
  - Both persistent ids mirrored to `localStorage` and a first-party cookie by default, so eviction of one store recovers from the other. Switch with `persistentStorage: "localStorage"` to drop the cookie.
  - `cookieDomain` config shares one visitor across subdomains.
- **Identity transitions.** `$identify`, `$reset` (with `previous_user_id`), and `$alias` events so the server can join the pre- and post-login behavioral graph and stitch a person across devices. `revu.alias(authoritativeId)` declares "the current id is the same person as `authoritativeId`" without changing the local user id (motivating flow: sign up on desktop, click an email link on phone). Idempotent on the server; distinct from `identify()`, which replaces the local id.
- **Pipeline hooks.** `beforeSend(event)` runs on every built event just before it is queued: return the event (mutated or replaced) to send it, `null` / `false` to drop it, or nothing to send it unchanged. Fail-open (a throwing hook sends the original event), and the returned `properties` are re-sanitized so a hook cannot poison the durable queue. `autocaptureAllowSelectors` / `autocaptureDenySelectors` scope element-targeted autocapture by CSS selector; deny wins and suppresses the file-download / outbound-link / rage events derived from a click too.
- **Session sampling.** `sampleRate` (0-1, default `1`) drops whole sessions before they queue. The decision is session-sticky (a session is captured or skipped whole, never half), identity events are always sent, and kept sampled events carry `context.sample_rate` so the server can scale aggregates.
- **Durable transport.** Batched JSON POST to `/v1/behavior/events`. `fetch` with `keepalive: true` while the page is live; `navigator.sendBeacon` on `pagehide` / `visibilitychange=hidden` to flush the last batch on unload. Capped exponential backoff on transient failures; `event_id` is the idempotency key so a retried batch de-dupes server-side.
- **Durable offline queue.** `localStorage`-backed buffer survives reloads and offline gaps. Auto-flushes on the `online` event so events captured offline ship the moment connectivity returns. An unserializable event is quarantined so one bad event never blocks the queue.
- **First-party ingest.** Point `host` at your own domain to route events first-party (data-completeness measure); reverse-proxy recipes (Cloudflare, nginx, Caddy, Next.js) are in `docs/first-party-ingest.md`.
- **Plugin contract.** `revu.use(plugin)` or `init({ plugins: [...] })`. Plugins registered before init are queued and drained on init. The Web Vitals layer ships through this contract as a built-in plugin.
- **Event shape: `context` + `properties`.** Every event carries a top-level `context` object (engine environment, unprefixed: `user_agent`, `language`, `timezone`, `screen_*`, `viewport_*`, `online`, `connection_*`, `environment`, `sdk_version`, `consent`, `gpc`, `sample_rate`, and attribution) separate from `properties` (the event's own payload plus caller `capture()` props). The two buckets never collide, so there is no `$`-prefix and no caller-vs-engine merge - the de-facto context-vs-properties shape every warehouse / BI / SQL consumer expects. `properties.path` remains the per-event path; `screen` is the top-level route.
- **SDK build version.** `context.sdk_version` is stamped on every event so the server can correlate behavior with SDK versions when investigating a regression or rolling out a fix. The same string is exposed as `revu.version`. Source of truth is `package.json`; `src/version.js` is regenerated by `scripts/sync-version.js` (the `prebuild` hook) so a release-day bump touches one file. The generated file is committed so the vanilla example runs straight from `src/`.
- **Environment label.** `environment: "production" | "staging" | "development"` config field (default `"production"`) stamps `context.environment` so the dashboard can keep dev and staging traffic out of the production view. Invalid values throw at init.
- **Input masking and redaction.** Input values are never read from any field. Click fingerprints on `<input>` / `<textarea>` / `<select>` / `contenteditable` / `[data-revu-mask]` subtrees are redacted (tag, role, and selector survive; text, `aria-label`, and `title` are dropped); `$change` skips password / file / hidden inputs entirely; form submits emit metadata only (`field_names`, `field_types`, `field_count`), never values. Credential and PII values in captured URLs and referrers - in both the query string and the fragment (e.g. an OAuth implicit-flow `#access_token=...`) - are scrubbed at source while UTM and click ids are preserved.
- **Shadow DOM coverage.** Clicks inside open Shadow DOM custom elements are captured against the actual internal element via `composedPath()` instead of the retargeted host. Ancestor walks in the fingerprint (selector path) and masking check (`data-revu-mask`) cross the shadow boundary via `ShadowRoot.host`, so a mask on the host applies to its shadow tree and selectors keep their full ancestor context across Web Components and component-library UIs.

### Architecture

- **Vanilla JavaScript (ESM) with JSDoc** as the single source of truth for both runtime and emitted `.d.ts` types.
- **Zero runtime dependencies.** No published package declares a `dependencies` entry. Platform and Web APIs only.
- **Tree-shakeable.** `"sideEffects": false`; unused modules drop out at the consumer's bundler.
- **Bundle size: 32.41 kB minified / 10.22 kB gzipped** (around 9 kB brotli on the wire), under the 34 kB / 12 kB CI gate.
- **Defensive boundary.** Every public entry is `safe()`-wrapped; internal errors are swallowed and (in `debug: true`) logged, never propagated to the host page.

### Security

- Input values are never read from any field (`<input>`, `<textarea>`, `<select>`, `contenteditable`) - only interactions and structure.
- Form submit events carry shape metadata only, never values.
- `data-revu-mask` opts a subtree out of text and label capture; `autocaptureDenySelectors` suppresses capture for a region entirely.
- Credential and PII values in captured URLs and referrers are scrubbed at source - in both the query string and the fragment (UTM and click ids preserved).
- Consent is enforced before an event is built (a denied `analytics` category produces no event); Global Privacy Control is honored when `honorGpc` is set.
- The transport sends only fields explicitly built by the client; no DOM serialization, no cookie reads other than the SDK's own first-party identity cookie.

[0.3.0]: https://github.com/revu-ai/sdk-web/releases/tag/v0.3.0
[0.2.0]: https://github.com/revu-ai/sdk-web/releases/tag/v0.2.0
[0.1.0]: https://github.com/revu-ai/sdk-web/releases/tag/v0.1.0
