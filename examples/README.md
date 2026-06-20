# Examples

Runnable demos of the REVU Web SDK in real HTML pages. Both exercise the
same built artifact (`packages/core/dist/iife/index.js`) and both use the
recommended stub-queue install snippet from
[`packages/core/docs/install.md`](../packages/core/docs/install.md). They
differ only in scope.

| Example | What it covers |
|---|---|
| [`vanilla/`](./vanilla/index.html) | The full SDK surface: every major event type, redaction demo with `data-revu-mask`, SPA route change, identity (identify + reset + alias), custom events, bfcache restore |
| [`cdn/`](./cdn/index.html) | A minimal page that demonstrates the install snippet itself, end-to-end through a real CDN |

## Quick start: vanilla example

From the repo root:

```bash
bun run build         # produces dist/index.js + dist/iife/index.js
bun run examples      # static server on http://localhost:8080
```

Then open <http://localhost:8080/examples/vanilla/index.html>.

The vanilla example loads the SDK via a relative path
(`../../packages/core/dist/iife/index.js`) and works with just the
examples server running.

## CDN example: end-to-end setup

The CDN example loads the bundle from `http://localhost:8787/behavior` -
the local CDN dev server - to mirror what production looks like when the
SDK loads from `https://cdn.revu.ai/behavior`. To run it end-to-end you
need both servers and a one-time publish into the local CDN's storage.

In one shell, start the local CDN:

```bash
cd ../cdn        # sibling repo
bun run dev      # serves http://localhost:8787
```

In another shell, publish the local SDK build into it:

```bash
cd ../cdn
bun run publish-asset behavior 0.1.0 ../sdk-web/packages/core/dist/iife --force
```

In a third shell (from `sdk-web/`), start the examples server:

```bash
bun run examples
```

Open <http://localhost:8080/examples/cdn/index.html>. The page now loads
the IIFE bundle through the local CDN exactly the way production
customers will load it through `cdn.revu.ai`.

Republish the SDK after every `bun run build` so the CDN serves the
fresh bytes; `--force` is required for re-publishing the same version
(pinned versions are immutable in non-development environments).

## What you'll see

Both examples mirror captured events to a panel on the page and, when
`debug: true` is set, to the browser console. Network requests to the
ingest endpoint don't actually succeed in the demo (the demo `apiKey`
and `host` are placeholders), but every SDK behavior is observable
before the transport layer ships the events.

## Stopping

Both servers run in the foreground; stop them with `Ctrl+C` when done.
