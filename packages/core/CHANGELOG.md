# Changelog

All notable changes to `@revu-ai/core` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.2.0]: https://github.com/revu-ai/sdk-web/releases/tag/v0.2.0
[0.1.0]: https://github.com/revu-ai/sdk-web/releases/tag/v0.1.0
