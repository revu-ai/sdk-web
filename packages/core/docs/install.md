# Install

Two paths, pick the one that matches how your site is built.

## Path 1: CDN snippet

Paste one `<script>` tag in `<head>`. The SDK loads asynchronously and starts
capturing as soon as it finishes loading.

```html
<script
  async
  src="https://cdn.revu.ai/behavior"
  onload="revu.init({ apiKey: 'revu_pk_...' })"
></script>
```

What this does:

1. The browser fetches the bundle in parallel with HTML parsing (`async`).
2. When the script finishes loading and executing, the inline `onload`
   handler runs and calls `revu.init(...)`.
3. `revu.init` registers the first `$pageview`, starts the autocapture
   listeners, and brings the SDK online.

That covers the entire install for the typical case. If your only contact
with REVU is the snippet itself and the SDK's autocapture, you're done.

### When you need to call `revu.x()` from elsewhere on the page

The simple snippet has one constraint: `window.revu` is undefined until the
bundle finishes loading. If you call `revu.capture(...)`, `revu.identify(...)`,
or any other method **before** the bundle has loaded (from a tag manager,
from an inline event handler, from a script that runs above the snippet),
the call throws and the event is lost.

For those cases, paste this stub-queue snippet instead. It buffers every
call into a queue that the SDK drains on load:

```html
<script async src="https://cdn.revu.ai/behavior"></script>
<script>
  window.revu = window.revu || new Proxy({q:[]}, {
    get: (t, m) => m in t ? t[m] : (...a) => t.q.push([m, ...a]),
  });
  revu.init({ apiKey: "revu_pk_..." });
</script>
```

How the stub works: the `Proxy` synthesizes a method for every property
access (`revu.init`, `revu.capture`, `revu.identify`, anything you call)
that pushes `[methodName, ...args]` onto `revu.q`. When the bundle
loads, it reads that queue, replays each call against the real client
in arrival order, then replaces the stub with the live singleton. The
`m in t` check ensures `revu.q` itself returns the queue array rather
than a synthesized method, so the drain logic can detect it.

The stub is ~100 bytes inline and works for any future method without
having to update the method-name list.

Use this snippet if any of the following are true:

- You integrate REVU via a tag manager (Google Tag Manager, Tealium,
  Adobe Launch). Tag managers commonly fire calls during page load before
  async scripts finish.
- Inline `onclick` handlers or other inline scripts call `revu.x(...)`.
- Your Content Security Policy forbids inline event handlers (no
  `'unsafe-inline'`, no nonce). The queue snippet does not rely on
  `onload`, so it works under strict CSPs.
- You fire critical events extremely early in the page lifecycle (cookie
  banner choice, A/B test exposure, identity from a server-rendered
  cookie) and need every one captured.

Both snippets call the same SDK; they differ only in how they handle the
window between "snippet runs" and "SDK finishes loading."

### Version pinning on the CDN

The `cdn.revu.ai` URL path encodes how tightly you pin to a release.
Pick the form that matches your stability needs.

| URL form | Resolves to | Cache | Use when |
|---|---|---|---|
| `cdn.revu.ai/behavior/1.2.3/index.js` | The exact 1.2.3 release | One year, immutable | Maximum stability; you opt into every version bump by editing the URL. |
| `cdn.revu.ai/behavior/latest/index.js` | The newest published release | Five minutes | You want updates automatically and accept the responsibility of testing across releases. |
| `cdn.revu.ai/behavior` | Same as `latest/index.js`, shortest form | Five minutes | Same as above, shortest URL. The snippets above use this form. |

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
  src="https://cdn.revu.ai/behavior/1.2.3/index.js"
  integrity="sha384-..."
  crossorigin="anonymous"
  onload="revu.init({ apiKey: 'revu_pk_...' })"
></script>
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
- Block first paint. Both snippets load the bundle asynchronously.
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
