# Install

Two paths, pick the one that matches how your site is built.

## Path 1: CDN snippet

Paste these tags into your `<head>`:

```html
<script async src="https://cdn.revu.ai/behavior"></script>
<script>
  window.revu = window.revu || new Proxy({q:[]}, {
    get: (t, m) => m in t ? t[m] : (...a) => t.q.push([m, ...a]),
  });
  revu.init({ apiKey: "revu_pk_..." });
</script>
```

What this does:

1. The first tag starts fetching the SDK bundle in parallel with HTML
   parsing (`async`). It does not block the browser.
2. The inline `<script>` runs immediately. It installs a small `Proxy`
   stub at `window.revu` that buffers any `revu.x(...)` call into a
   queue (`revu.q`), then calls `revu.init(...)`, which gets queued like
   any other call.
3. When the bundle finishes loading, it reads the queue, replays every
   call against the real SDK in arrival order (so the queued
   `revu.init` actually runs, the SDK comes online, autocapture starts),
   then replaces the stub with the live singleton. Subsequent calls go
   straight through.

The stub queue is what makes the install bulletproof. Anything that
fires between "snippet runs" and "SDK finishes loading" - a tag manager
call, an inline `onclick="revu.capture(...)"` handler, a cookie banner
consent event, a server-rendered identity injection, a click on a CTA
before the page settles - is queued and replayed instead of silently
lost. The stub is ~100 bytes inline, future-proof for any method we
add later (the `Proxy` covers method names dynamically), and disappears
entirely once the SDK takes over.

### Version pinning on the CDN

The `cdn.revu.ai` URL path encodes how tightly you pin to a release.
Pick the form that matches your stability needs.

| URL form | Resolves to | Cache | Use when |
|---|---|---|---|
| `cdn.revu.ai/behavior/1.2.3` | The exact 1.2.3 release | One year, immutable | Maximum stability; you opt into every version bump by editing the URL. |
| `cdn.revu.ai/behavior/latest` | The newest published release | Five minutes | You want updates automatically and accept the responsibility of testing across releases. |
| `cdn.revu.ai/behavior` | Same as `behavior/latest`, shortest form | Five minutes | Same as above, shortest URL. The snippet above uses this form. |

Each pinned URL is paired with `.map` for source maps. The response
also carries a `Content-Encoding` of `br` or `gzip` when your browser
advertises support, and a `SourceMap` header pointing at the companion
map for production debugging.

### Subresource Integrity (SRI)

Pin the script with an `integrity` attribute for tamper detection. SRI
only works against the exact-version URL; the `latest` and bare-product
forms serve different bytes over time and would invalidate the hash on
every release.

```html
<script
  async
  src="https://cdn.revu.ai/behavior/1.2.3"
  integrity="sha384-..."
  crossorigin="anonymous"
></script>
<script>
  window.revu = window.revu || new Proxy({q:[]}, {
    get: (t, m) => m in t ? t[m] : (...a) => t.q.push([m, ...a]),
  });
  revu.init({ apiKey: "revu_pk_..." });
</script>
```

The hash for each release is in the release notes. The CDN also returns
it on every response as an `X-Content-Integrity` header, so you can
verify or fetch it programmatically.

## Path 2: npm install (bundler-based apps)

For React, Vue, Svelte, Next.js, Nuxt, and similar bundler-based
projects, install from npm and import the SDK like any other module.

```bash
bun add @revu-ai/core
# or: npm install @revu-ai/core
```

```js
import revu from "@revu-ai/core";

revu.init({ apiKey: "revu_pk_..." });
```

The npm distribution is ESM-only. Modern bundlers (Vite, Rollup,
esbuild, webpack 5+) tree-shake against `"sideEffects": false` so a
customer who imports only `revu.init` and `revu.capture` does not pay
for the modules they do not reach.

The CDN bundle and the npm bundle ship the same source, the same public
API, and the same wire shape. Pick whichever fits your build.

## What the bundle does not do

By design, the install path does not:

- Set any cookies on the CDN domain. The bundle is served cookieless.
- Block first paint. The bundle loads asynchronously.
- Require a build step or polyfills. The bundle targets ES2020 (Chrome
  85+, Safari 13.1+, Firefox 79+, Edge 85+), which covers ~97% of
  browsers globally without transpilation overhead.
- Force a specific module loader. Modern bundler, legacy `<script>` tag,
  or hybrid setups all work.

## Where to next

- **[Configuration](./configuration.md)** for every option you can pass
  to `init()`.
- **[Concepts](./concepts.md)** for the mental model behind `anonymous_id`,
  `user_id`, sessions, and the canonical event shape.
- **[Privacy and data](./privacy.md)** for what is masked by default and
  how to mark additional regions sensitive.
