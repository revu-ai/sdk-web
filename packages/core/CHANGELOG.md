# Changelog

All notable changes to `@revu-ai/core` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-06-11

First public release. Lean capture core for web behavioral analytics: one-line install, autocapture out of the box, durable offline queue, persistent first-party identity, zero runtime dependencies.

### Added

- **One-line boot.** `revu.init({ apiKey })` wires capture, identity, transport, and the queue in a single call. Every public entry (`init`, `capture`, `identify`, `reset`, `flush`, `use`) is wrapped with `safe()` so the SDK can never throw into the host page.
- **Autocapture.** `$pageview` (initial load plus SPA route changes via pushState / replaceState / popstate / hashchange), `$autocapture` (clicks anywhere), `$rightclick`, `$rageclick` (3 clicks on the same target within 1 s), `$scroll` milestones (25 / 50 / 75 / 100%), `$resize` (debounced to settled value), `$form_submit` (field metadata only, never values), `$file_download`, `$outbound_link`. Each event carries a stable selector fingerprint (tag, text, role, id, classes, ordinal) plus the route path.
- **Engagement layer.** `$page_leave` with `engagement_time_ms` (visible time on the page; hidden time excluded, idle time included), `$tab_hidden` / `$tab_visible` with paired durations, `$idle` / `$active` with paired durations (default `idleTimeoutMs: 30_000`, off when set to `0`). `captureAttention: false` keeps the engagement clock but suppresses the synthetic events.
- **Web Vitals.** `$web_vital` events for LCP, INP, and CLS emitted on terminal page lifecycle (`pagehide` / visibility-hidden). Pure PerformanceObserver, zero runtime dependencies. Disable with `captureWebVitals: false`.
- **Persistent identity.**
  - `anonymousId` (device-level) generated on first visit and persisted across reloads.
  - `userId` (person-level) with `autoIdentify` default-on: a UUID is auto-generated and persisted; a later `revu.identify("real-id")` replaces it. `revu.reset()` rotates to a fresh auto id.
  - `sessionId` rolls forward across reloads inside a 30-minute continuation window (`sessionTimeoutMs`); set to `0` to give every page load a fresh session.
  - Both persistent ids mirrored to `localStorage` and a first-party cookie by default, so eviction of one store recovers from the other. Switch with `persistentStorage: "localStorage"` to drop the cookie.
  - `cookieDomain` config shares one visitor across subdomains.
- **Identity transitions.** `$identify` and `$reset` events with `previous_user_id` so the server can join the pre- and post-login behavioral graph.
- **Cross-device identity join.** `revu.alias(authoritativeId)` declares "the current id is the same person as `authoritativeId`" without changing the local user id. Motivating flow is cross-device (sign up on desktop, click email link on phone); the server records the mapping so dashboards stitch the journey across devices. Idempotent on the server: repeated calls produce one mapping, not duplicates. Distinct from `identify()`, which replaces the local id.
- **Durable transport.** Batched JSON POST to `/v1/behavior/events`. `fetch` with `keepalive: true` while the page is live; `navigator.sendBeacon` on `pagehide` / `visibilitychange=hidden` to flush the last batch on unload. Capped exponential backoff on transient failures.
- **Durable offline queue.** `localStorage`-backed buffer survives reloads and offline gaps. Auto-flushes on the `online` event so events captured offline ship the moment connectivity returns.
- **Plugin contract.** `revu.use(plugin)` or `init({ plugins: [...] })`. Plugins registered before init are queued and drained on init. The Web Vitals layer ships through this contract as a built-in plugin.
- **Environment context.** Every event carries `$user_agent`, viewport and screen dimensions, language, timezone, and referrer host stamped at capture time.
- **Environment label.** `environment: "production" | "staging" | "development"` config field (default `"production"`) stamps `$environment` on every event so the dashboard can keep dev and staging traffic out of the production view. Invalid values throw at init.
- **Input masking.** `data-revu-mask` attribute opts a subtree out of text-content capture; sensitive `<input>` types (`password`, `email`, `tel`, `credit-card`, `search`) are redacted at source. Form submits emit metadata only (`field_names`, `field_types`, `field_count`), never values.
- **Shadow DOM coverage.** Clicks inside open Shadow DOM custom elements are captured against the actual internal element via `composedPath()` instead of the retargeted host. Ancestor walks in the fingerprint (selector path) and masking check (`data-revu-mask`) cross the shadow boundary via `ShadowRoot.host`, so a mask on the host applies to its shadow tree and selectors keep their full ancestor context across Web Components and component-library UIs.

### Architecture

- **Vanilla JavaScript (ESM) with JSDoc** as the single source of truth for both runtime and emitted `.d.ts` types.
- **Zero runtime dependencies.** No published package declares a `dependencies` entry. Platform and Web APIs only.
- **Tree-shakeable.** `"sideEffects": false`; unused modules drop out at the consumer's bundler.
- **Bundle size: 22 kB minified / 7 kB gzipped**, under the 30 kB / 10 kB CI gate.
- **Defensive boundary.** Every public entry is `safe()`-wrapped; internal errors are swallowed and (in `debug: true`) logged, never propagated to the host page.

### Security

- Field values are never read from `<input>`, `<textarea>`, `<select>`, or `contenteditable` elements.
- Form submit events carry shape metadata only, never values.
- The masking attribute (`data-revu-mask`) opts a subtree out of text and label capture.
- The transport sends only fields explicitly built by the client; no DOM serialization, no cookie reads other than the SDK's own first-party identity cookie.

[0.1.0]: https://github.com/revu-ai/sdk-web/releases/tag/v0.1.0
