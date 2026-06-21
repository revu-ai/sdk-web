# @revu-ai/core

[![npm](https://img.shields.io/npm/v/@revu-ai/core.svg)](https://www.npmjs.com/package/@revu-ai/core)
[![ci](https://github.com/revu-ai/sdk-web/actions/workflows/ci.yml/badge.svg)](https://github.com/revu-ai/sdk-web/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/@revu-ai/core.svg)](https://github.com/revu-ai/sdk-web/blob/main/LICENSE)
[![size](https://img.shields.io/badge/min-32.41%20kB-blue)](#size)
[![gzip](https://img.shields.io/badge/gzip-10.22%20kB-blue)](#size)

The lean capture core of the REVU Web SDK. One line in your page
captures pageviews, clicks, scroll depth, form submits, downloads,
outbound links, engagement time, and Web Vitals, with a persistent
visitor id already attached. The intelligence (taxonomy, self-healing,
cross-modal fusion) runs server-side, so the bundle on your page stays
small, fast, and single-purpose: capture, identify, transport.

```js
import revu from "@revu-ai/core";

revu.init({ apiKey: "revu_pk_..." });
// Pageviews and clicks ship automatically. Every event carries a
// persistent visitor id, a rolling session id, and environment context.

revu.identify("user-123"); // on login
revu.capture("checkout_completed", { plan: "pro" }); // optional explicit event
revu.reset(); // on logout
```

ESM only. **Zero runtime dependencies.** 32.41 kB minified, 10.22 kB gzipped.

## Documentation

The full reference manual lives in **[docs/](./docs/index.md)**: public
API, configuration, concepts, plugins, privacy, transport, and
troubleshooting. Start there for anything beyond the quickstart on this
page.

A few high-traffic jumps:

- [Public API](./docs/api.md) - every method, with signature, example,
  and edge cases.
- [Why sessions continue across reloads](./docs/configuration.md#sessiontimeoutms-sessions-are-engagement-not-page-visits) -
  the 30 minute window, how to change it, and why a session is
  engagement (not a single page visit).
- [Troubleshooting](./docs/troubleshooting.md) - CSP, `sendBeacon`,
  mobile Safari terminal events, durable queue, identify and reset
  semantics.

## Install

From a package manager:

```bash
npm install @revu-ai/core
# or
bun add @revu-ai/core
# or
pnpm add @revu-ai/core
```

Or load it directly from `cdn.revu.ai` (no build step required, see
the [script tag quickstart](#plain-html-script-tag-no-bundler)):

```html
<script type="module">
  import revu from "https://cdn.revu.ai/behavior/0.1.0";
</script>
```

## Your first event in 60 seconds

### ES modules (Vite, Next.js, SvelteKit, Remix, Astro, etc.)

```js
// app.js
import revu from "@revu-ai/core";

revu.init({
  apiKey: "revu_pk_your_write_key",
});
```

Open the page. A `$pageview` and the surrounding environment context
ship within five seconds (the default flush interval), or sooner if a
batch fills up. Click anything: a `$autocapture` event is queued.

### Plain HTML (script tag, no bundler)

The SDK is hosted on `cdn.revu.ai` as ESM. Use the floating
`latest` URL for getting started:

```html
<script type="module">
  import revu from "https://cdn.revu.ai/behavior";
  revu.init({ apiKey: "revu_pk_your_write_key" });
</script>
```

For production, **pin an exact version** so a future SDK release does
not change the bytes your page loads without warning:

```html
<script type="module">
  import revu from "https://cdn.revu.ai/behavior/0.1.0";
  revu.init({ apiKey: "revu_pk_your_write_key" });
</script>
```

The CDN sets long-cache headers on pinned URLs (the file at a given
version never changes), and a short cache TTL on `latest` so a release
propagates within minutes. Every response is pre-compressed at
publish time, so a modern browser receives the bundle as brotli
(typically around 7.9 kB on the wire for the current version).

If you would rather self-host, copy
`node_modules/@revu-ai/core/dist/index.js` into your own asset
pipeline and import from there:

```html
<script type="module">
  import revu from "/vendor/revu-core.js";
  revu.init({ apiKey: "revu_pk_your_write_key" });
</script>
```

### Verify

The fastest way to confirm capture is working before you have the
dashboard in front of you:

```js
revu.init({
  apiKey: "revu_pk_your_write_key",
  debug: true, // logs every captured event
  onEvent: (event) => console.log(event),
});
```

You should see at least a `$pageview` in the console immediately after
init, plus one event per interaction.

## What gets captured automatically

| Event                           | When it fires                                                                                   |
| ------------------------------- | ----------------------------------------------------------------------------------------------- |
| `$pageview`                     | Initial load and every SPA route change (`pushState`, `replaceState`, `popstate`, `hashchange`) |
| `$autocapture`                  | A click anywhere; carries a semantic fingerprint of the element                                 |
| `$rightclick`                   | Context-menu click on any element                                                               |
| `$rageclick`                    | Three clicks on the same target within one second                                               |
| `$scroll`                       | 25 / 50 / 75 / 100% scroll-depth milestones (once per page)                                     |
| `$resize`                       | Final viewport size after a resize gesture (debounced)                                          |
| `$form_submit`                  | Form structure (field names and types). Never values.                                           |
| `$change`                       | Form-control change (select / checkbox / radio / input); the interaction, never the value       |
| `$file_download`                | Click on a link with `download` or a known file extension                                       |
| `$outbound_link`                | Click on a link to a different hostname                                                         |
| `$page_leave`                   | Terminal close or SPA route change, with `engagement_time_ms`                                   |
| `$page_restore`                 | Back/forward bfcache restore (`pageshow` with `persisted`)                                      |
| `$tab_hidden`, `$tab_visible`   | Tab visibility transitions, with elapsed ms in each state                                       |
| `$idle`, `$active`              | No mouse / keyboard / scroll / touch for `idleTimeoutMs`, then resumed                          |
| `$web_vital`                    | LCP, INP, and CLS (session-windowed per spec), emitted on page hide                             |
| `$identify`, `$reset`, `$alias` | Identity transitions                                                                            |

Every event also carries an engine `context` bucket (`user_agent`,
`language`, `timezone`, screen and viewport geometry, online state,
connection type when available, initial referrer, consent state) and a
`sdk_version` stamp so the server can correlate behavior with the exact
SDK build that produced it. `context` is separate from your `capture()`
`properties`, so the two never collide.

## Browser support

Modern evergreen browsers from early 2021 onward: **Safari 14+, Chrome
88+, Firefox 88+, Edge 88+**. The SDK relies on platform APIs
(`fetch`, `localStorage`, `sendBeacon`, `PerformanceObserver`,
`MutationObserver`, `Intl.DateTimeFormat`, `crypto.getRandomValues`,
the URL constructor) that every browser in that floor supports.

Optional APIs are read defensively. Network Information
(`navigator.connection`) is absent on Safari and Firefox today; events
captured on those engines simply omit `context.connection_type` and
`context.connection_downlink_mbps` without affecting capture.

## Size

| Metric          | Current | Budget |
| --------------- | ------- | ------ |
| Minified        | 32.41 kB | 34 kB  |
| Gzipped on wire | 10.22 kB  | 12 kB  |

Both axes are CI gates (`bun run size`). Gzipped is the transfer cost
users pay; minified is the parse and compile cost the browser pays on
low-end devices. The budget is a deliberate constraint so the SDK
cold-loads on any page without being noticed.

When the SDK is served from `cdn.revu.ai`, the actual wire cost is
lower than the gzipped budget: the CDN pre-compresses each asset with
brotli at publish time and serves the brotli variant to every browser
that supports it (every modern browser does). The current bundle ships
as around 9 kB on the wire for browsers that advertise brotli, with
gzip as the fallback.

## Versioning and stability

`@revu-ai/core` follows **semver**.

- **Patch** releases (`0.1.0 -> 0.1.1`) ship internal fixes and
  performance improvements. No public API change.
- **Minor** releases (`0.1.0 -> 0.2.0`) add new options, new
  autocapture event types, or new public methods. Existing API stays.
- **Major** releases (`0.x -> 1.0`, `1.x -> 2.0`) are reserved for
  breaking changes. We deprecate first: a method or option scheduled
  for removal stays in place and is called out in the changelog for at
  least one minor release before it goes away.

The event shape on the wire (the contract with ingest) is versioned
separately and evolves additively: new fields appear, existing ones
do not change meaning. The `context.sdk_version` on every event lets the
server correlate behavior with the exact build that emitted it.

The public surface is exactly:

- `revu.init`, `revu.capture`, `revu.identify`, `revu.alias`,
  `revu.reset`, `revu.flush`, `revu.use`, `revu.version`.
- The `RevuClient` class, for advanced use cases that need multiple
  instances.
- The exported types (`RevuConfig`, `ResolvedConfig`, `RevuEvent`,
  `Fingerprint`, `RevuPlugin`, `PluginApi`, `SendFn`).

Everything else (internal modules under `src/`, helpers, the storage
facade) is implementation detail and may change without notice.

## Changelog

See [CHANGELOG.md](./CHANGELOG.md) for the release history.

## License

Apache-2.0.
