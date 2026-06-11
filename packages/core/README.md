# @revu-ai/core

[![npm](https://img.shields.io/npm/v/@revu-ai/core.svg)](https://www.npmjs.com/package/@revu-ai/core)
[![ci](https://github.com/revu-ai/sdk-web/actions/workflows/ci.yml/badge.svg)](https://github.com/revu-ai/sdk-web/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/@revu-ai/core.svg)](https://github.com/revu-ai/sdk-web/blob/main/LICENSE)

One-line web behavioral analytics. The lean capture core for [REVU](https://revu.ai), the Feedback and Behavior Intelligence platform.

```js
import revu from "@revu-ai/core";

revu.init({ apiKey: "your-write-key" });
// Page views and clicks are captured automatically.
// Every event already carries a persistent visitor id.

revu.identify("user-123");                            // on login
revu.capture("checkout_completed", { plan: "pro" });  // optional explicit event
revu.reset();                                         // on logout
```

## Install

```bash
npm install @revu-ai/core
# or: bun add @revu-ai/core
# or: pnpm add @revu-ai/core
```

ESM only. Zero runtime dependencies. **21.3 kB minified / 6.9 kB gzipped.**

## What gets captured automatically

| Event | When |
|---|---|
| `$pageview` | Initial load and SPA route changes (`pushState`, `replaceState`, `popstate`, `hashchange`) |
| `$autocapture` | Click on any element; carries a stable selector fingerprint |
| `$rightclick`, `$rageclick` | Context-menu and three clicks on the same target within 1 s |
| `$scroll`, `$resize` | 25 / 50 / 75 / 100% scroll milestones; debounced resize gestures |
| `$form_submit` | Field metadata only, never values |
| `$file_download`, `$outbound_link` | Download links and off-domain links |
| `$page_leave` | With `engagement_time_ms` (visible time on the page) |
| `$tab_hidden`, `$tab_visible`, `$idle`, `$active` | Engagement and idle lifecycle |
| `$web_vital` | LCP, INP, CLS on terminal page lifecycle |
| `$identify`, `$reset` | Identity transitions |

Every event also carries environment context (`$user_agent`, viewport, language, timezone, referrer, UTM and click ids) so the server can break down by browser, locale, and campaign without host wiring.

Set `environment: "staging"` (or `"development"`) in `init()` to keep non-prod traffic out of the default dashboard view. The label is stamped on every event as `$environment`. Default is `"production"`.

## Identity

- **`anonymousId`** (device-level) generated on first visit, persisted across reloads.
- **`userId`** (person-level) auto-generated on first visit. `revu.identify("real-id")` replaces it on login; `revu.reset()` rotates on logout.
- **`sessionId`** rolls forward across reloads inside a 30-minute window (`sessionTimeoutMs`). Set to `0` to give every load a fresh session.

Both persistent ids are mirrored to localStorage and a first-party cookie by default, so eviction of one store recovers from the other.

## Custom events

For signals autocapture cannot see (server-side completions, async events, wizard steps that do not change the URL):

```js
revu.capture("checkout_completed", {
  plan: "pro",
  amount_cents: 4900,
  currency: "USD",
});
revu.capture("report_exported", { format: "pdf", pages: 12 });
```

Caller properties always win over engine values on collision, so the host can override anything when it knows better.

## Privacy

- **No input values are ever read** from `<input>`, `<textarea>`, `<select>`, or `contenteditable` elements.
- **Form submits carry metadata only**: `form_id`, `form_name`, `action`, `method`, `field_names[]`, `field_types[]`, `field_count`. Never values.
- **Masking attribute.** Add `data-revu-mask` to any element (or ancestor) to opt its subtree out of text and label capture.
- **Sensitive input types** (`password`, `email`, `tel`, credit-card, `search`) are redacted at source.

## Safety

Every public entry (`init`, `capture`, `identify`, `reset`, `flush`, `use`) is wrapped so internal errors are swallowed and (with `debug: true`) logged. The SDK never throws into the host page.

## Transport and offline

- **Batched JSON POST** to the configured `host` (default `https://api.revu.ai`). `fetch` with `keepalive: true` while the page is live; `sendBeacon` on `pagehide` / `visibilitychange=hidden` to flush the last batch on unload.
- **Capped exponential backoff** on transient failures.
- **Durable offline queue** backed by localStorage. Events captured offline survive reloads and auto-flush on the next `online` event.

## Size

| Metric | Current | Budget |
|---|---|---|
| Minified | 21.3 kB | 30 kB |
| Gzipped on wire | 6.9 kB | 10 kB |

Both axes are CI gates (`bun run size`). Gzipped size is the transfer cost users pay; minified size is the parse and compile cost the browser pays on low-end devices. The budget is a deliberate constraint so the SDK is light enough to cold-load on any page.

## Configuration

```js
revu.init({
  apiKey: "...",                  // required, public write key (prefix revu_pk_)
  host: "https://api.revu.ai",    // default
  environment: "production",      // "production" | "staging" | "development"
  autoIdentify: true,             // auto-assign userId on first visit
  persistentStorage: "both",      // "both" | "localStorage"
  cookieDomain: ".example.com",   // share visitor across subdomains
  sessionTimeoutMs: 1_800_000,    // 30 minutes; 0 = fresh session every load
  captureAttention: true,         // $tab_*, $idle, $active events
  captureWebVitals: true,         // $web_vital events
  idleTimeoutMs: 30_000,          // 0 disables idle detection
  debug: false,                   // log internal errors when true
  onEvent: (event) => { ... },    // local hook (debugging, mirroring)
  plugins: [],                    // opt-in modules
});
```

## Plugins

```js
import revu from "@revu-ai/core";
import { exceptions } from "@revu-ai/core/exceptions"; // future

revu.init({ apiKey: "...", plugins: [exceptions()] });
```

`revu.use(plugin)` is the alternative to passing through `init`. Plugins registered before `init()` are queued and drained when init runs.

## Architecture

- **Vanilla JavaScript (ESM) + JSDoc** as the single source of truth for both runtime behavior and emitted `.d.ts` types.
- **Zero runtime dependencies.** Platform and Web APIs only.
- **Tree-shakeable** (`"sideEffects": false`); unused modules drop out at the consumer's bundler.
- **Defensive boundary.** Every public entry is `safe()`-wrapped so an internal failure never propagates into the host page.

## Browser support

Modern evergreen browsers from early 2021 onward: **Safari 14+, Chrome 88+, Firefox 88+, Edge 88+**. The SDK uses platform APIs (`fetch`, `localStorage`, `sendBeacon`, `PerformanceObserver`, `MutationObserver`, `Intl.DateTimeFormat`, `crypto.getRandomValues`, the URL constructor) that all browsers in that floor support. Optional APIs (Network Information for connection type) are read defensively and absent in some engines without affecting capture.

## Changelog

See [CHANGELOG.md](./CHANGELOG.md) for the release history.

## License

Apache-2.0.
