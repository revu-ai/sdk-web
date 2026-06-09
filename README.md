# REVU Web SDK

One-line, lightweight behavioral analytics for the web - part of the **REVU** product & customer intelligence platform. Autocapture with zero instrumentation; the AI taxonomy, self-healing, and fusion live server-side, so the SDK stays tiny.

```js
import revu from "@revu-ai/core";

revu.init({ apiKey: "your-write-key" });
// That's it - page views and clicks are captured automatically.
// Every event already carries a persistent visitor id (autoIdentify).
revu.identify("user-123");                      // on login, replaces the auto id
revu.track("Plan Upgraded", { tier: "pro" });   // optional explicit event
revu.reset();                                   // on logout
```

## Identity

The SDK assigns every visitor a stable id on first load and keeps it across reloads, so the dashboard can attribute sessions even before the host app knows who the user is.

- **`anonymousId`** - device-level id. UUID generated on first visit, persisted across reloads, survives logout.
- **`userId`** - person-level id. With `autoIdentify` (default), a UUID is auto-generated on first visit and persisted. Call `revu.identify("real-id")` on login - the manual id wins and is also persisted. `revu.reset()` on logout rotates to a fresh auto id (next visitor on the browser is treated as a new person).
- **`sessionId`** - per-load id. Rotates on every page load and on `reset()`.

Both persistent ids are mirrored to **localStorage and a first-party cookie** by default, so an eviction of one store is recoverable from the other (defends against Safari ITP wiping localStorage). Nothing client-side is truly forever though: a "Clear site data" action, private mode, or a different device all reset the ids. For cross-device, post-clear identity, pass your real auth id via `revu.identify(authUserId)` once the user logs in.

Knobs:

```js
revu.init({
  apiKey: "...",
  autoIdentify: false,            // keep user_id null until identify()
  persistentStorage: "localStorage", // drop the cookie (zero per-request bandwidth)
  cookieDomain: ".example.com",   // share one visitor across subdomains
});
```

## Autocaptured event types

Out of the box, the SDK emits these without any host wiring (every event also carries the engine context below):

| Event | When | Key properties |
|---|---|---|
| `$pageview` | Initial load + SPA route changes (pushState / replaceState / popstate / hashchange) | `url`, `path`, `referrer`, `title` |
| `$autocapture` | Any click anywhere in the document | `fingerprint` (tag, role, id, classes, selector, text - text redacted when sensitive), `path` |
| `$rightclick` | Context-menu (right-click) | `fingerprint`, `path` |
| `$rageclick` | 3 clicks on the same element within 1 s | `fingerprint`, `click_count`, `window_ms` |
| `$scroll` | Crossing 25 / 50 / 75 / 100% scroll depth (once per milestone per page) | `depth_percent`, `path` |
| `$resize` | After a resize gesture settles (500 ms debounce) | `from_width`, `from_height`, `to_width`, `to_height` |
| `$form_submit` | Form submission | `form_id`, `form_name`, `action`, `method`, `field_names[]`, `field_types[]`, `field_count` - **never values** |
| `$file_download` | Click on a link with `download` attribute or known file extension (pdf, csv, zip, ...) | `url`, `filename`, `extension` |
| `$outbound_link` | Click on a link whose hostname differs from `location.hostname` | `url`, `target_host` |
| `$page_leave` | SPA route change (for the previous page) + `pagehide` (terminal) | `engagement_time_ms`, `path` |
| `$identify` / `$reset` | `revu.identify()` / `revu.reset()` | `previous_user_id` on transitions |
| `$web_vital` | `pagehide` / `visibilitychange=hidden` | `name` ("LCP" / "INP" / "CLS"), `value`, `unit` |

`$page_leave`'s `engagement_time_ms` excludes time when the tab was hidden (paused on `visibilitychange=hidden`, resumed on `visible`), so a user who opens a tab and walks away for an hour does not get credited with an hour of engagement.

Form events respect `data-revu-mask`: a form (or any ancestor) carrying the attribute still emits `$form_submit` for the action / method / id metadata but omits `field_names`, `field_types`, and `field_count` entirely.

`$web_vital` reports Google's three Core Web Vitals (LCP, INP, CLS) on terminal page lifecycle. Pure PerformanceObserver; no runtime dependencies. Turn off with `revu.init({ captureWebVitals: false })`.

## Plugins

The core covers the universal, privacy-neutral baseline. Anything beyond that lands as a plugin so the core stays small and customers only pay for what they use.

```js
import revu from "@revu-ai/core";
import { exceptions } from "@revu-ai/core/exceptions"; // future
import { replay } from "@revu-ai/replay";              // future, separate package

revu.init({
  apiKey: "...",
  plugins: [exceptions(), replay({ sampleRate: 0.1 })],
});
```

A plugin is `{ name: string, install(api): void }`. Inside `install`, the plugin gets `record(type, props)` to emit events through the standard pipeline (identity + environment context + transport), plus read-only access to `identity`, `context`, and `config`.

Plugins live in different distribution units depending on size and lifecycle - the rubric is in [BACKLOG.md](./BACKLOG.md).

## Environment context on every event

Every event also carries engine-emitted properties (prefixed `$`) so the dashboard can break out by browser, viewport, locale, and campaign without any host-side wiring:

| Field | Source | Stable per |
|---|---|---|
| `$user_agent` | `navigator.userAgent` (server parses os / browser / device) | page load |
| `$language` | `navigator.language` | page load |
| `$timezone` | `Intl.DateTimeFormat().resolvedOptions().timeZone` | page load |
| `$screen_width`, `$screen_height`, `$screen_pixel_ratio` | `screen.*`, `devicePixelRatio` | page load |
| `$viewport_width`, `$viewport_height` | `window.innerWidth/Height` | event |
| `$online` | `navigator.onLine` | event |
| `$connection_type`, `$connection_downlink_mbps`, `$connection_rtt_ms`, `$save_data` | Network Information API (Chromium only today) | event |
| `$initial_referrer`, `$initial_referrer_host` | `document.referrer` at init | page load |
| `$utm_source`, `$utm_medium`, `$utm_campaign`, `$utm_term`, `$utm_content`, `$gclid`, `$fbclid` | URL query at init | page load |

Caller-supplied properties on `revu.track(name, props)` always win over engine values on collision, so the host can override anything when it knows better. UA parsing into os / browser / device happens server-side so the SDK stays tiny.

## Why this codebase looks the way it does

- **Vanilla JavaScript + JSDoc** - the source is plain, runnable ESM. **JSDoc is the single source of truth for both docs and types** (DRY); `tsc` generates `.d.ts` declarations at build time, so consumers still get full TypeScript intellisense without the source being TS.
- **Lean core + opt-in modules (monorepo)** - `@revu-ai/core` is the only required package; `surveys`, `replay`, etc. are added later as separate packages that share the core. Unused modules ship **zero** bytes.
- **Never block, never crash the host** - every public entry point is wrapped so an internal failure is swallowed (and, in debug, logged) instead of bubbling into the host page. All work is kept off the critical path.

## Structure

```
sdk-web/
├── packages/
│   └── core/                  @revu-ai/core - the lean capture core
│       ├── src/
│       │   ├── index.js       public API (the `revu` singleton)
│       │   ├── client.js      orchestrator (identity + capture + transport)
│       │   ├── capture.js     DOM autocapture (page views, clicks, SPA routes)
│       │   ├── fingerprint.js element → semantic fingerprint
│       │   ├── transport.js   batching + flush (fetch / sendBeacon) + backoff
│       │   ├── queue.js       durable offline queue (localStorage-backed)
│       │   ├── identity.js    anonymous id + identify()
│       │   ├── context.js     per-event environment (ua, viewport, utm, connection)
│       │   ├── storage.js     localStorage + cookie persistence
│       │   ├── config.js      defaults + resolution
│       │   ├── utils.js       uuid, safe(), truncate (DRY helpers)
│       │   └── types.js       JSDoc typedefs (single source of types)
│       └── package.json
├── examples/vanilla/          a static page to click around + watch events
├── tsconfig.base.json         JSDoc → .d.ts config
└── package.json               workspace root (Bun)
```

## Develop

Tooling uses **Bun** (same as the REVU backend).

```bash
bun install
# Run the example: serve the repo root statically, then open examples/vanilla/index.html
bunx serve .          # or: python3 -m http.server

bun test              # unit tests
bun run lint          # eslint
bun run format        # prettier
bun run types         # generate .d.ts from JSDoc (tsc)
bun run build         # bundle ESM to dist/
bun run size          # check the bundle stays within budget
```

## License

Apache-2.0 - see `LICENSE`. (The REVU backend is proprietary; the SDKs are open.)
