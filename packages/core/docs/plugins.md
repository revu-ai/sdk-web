# Plugins

[Docs index](./index.md) - [package README](../README.md)

A plugin extends the SDK with new event types or behaviors without
bloating the core. Every plugin implements the same minimal contract,
regardless of how it is distributed.

## The contract

```js
/** @type {import("@revu-ai/core").RevuPlugin} */
export function myPlugin(options = {}) {
  return {
    name: "my-plugin", // unique id; double-install is a no-op
    install({ record, identity, context, config }) {
      // Wire listeners, observers, timers. Emit through `record()` so
      // events go through the standard pipeline (identity + context +
      // transport).
      record("$my_event", { properties: { foo: "bar" } });
    },
    uninstall() {
      // Optional. Tear down anything install() wired up.
    },
  };
}
```

The `install` API is the minimum a plugin needs:

- **`record(eventType, data?)`** to emit an event through the standard
  pipeline. `data` accepts `fingerprint` and `properties` (the latter
  wins over engine context on collision).
- **`identity`** for read access to `anonymousId`, `userId`, `sessionId`.
- **`context`** for read access to the environment context builder.
- **`config`** for the resolved config (host, environment, debug, etc).

## Registering a plugin

Two equivalent paths (`exceptions()` and `replay()` here stand in for
plugins you author or install; they are not shipped exports of this
package):

```js
revu.init({ apiKey: "revu_pk_...", plugins: [exceptions(), replay()] });
```

```js
revu.use(exceptions());
revu.use(replay());
revu.init({ apiKey: "revu_pk_..." });
```

Both paths queue pre-init `use()` calls and drain them when `init()`
runs. The same plugin name registered twice is a no-op so a redundant
wiring path does not cause double listeners.

## When to ship a feature as a plugin vs put it in core

Core stays universal. Anything every customer uses regardless of segment
or use case (autocapture, identity, transport, attention, web vitals)
lives in core. Anything **segment-specific** (B2B-only signals,
framework adapters, industry compliance, paid-plan capabilities) ships
as a plugin so customers who do not use it carry **zero bytes** after
tree-shaking.

The rule of thumb on distribution:

- **Subpath plugin** (`@revu-ai/core/<name>`) when the feature is small,
  uses no separate ingest, and shares the privacy posture of core. It
  ships in the same package and tree-shakes out when not imported.
- **Separate npm package** (a future `@revu-ai/replay` and so on) when
  the feature exceeds ~5 kB gzipped, has its own ingest endpoint, has a
  materially different privacy posture, or needs independent
  versioning.

The plugin contract is identical either way.

## A worked example

A small plugin that captures uncaught exceptions (an illustrative plugin
you would author yourself, not a shipped export):

```js
/** @type {import("@revu-ai/core").RevuPlugin} */
export function exceptions() {
  return {
    name: "exceptions",
    install({ record }) {
      if (typeof window === "undefined") return;
      window.addEventListener("error", (e) => {
        record("$exception", {
          properties: {
            message: e.message,
            filename: e.filename,
            line: e.lineno,
            column: e.colno,
            stack: e.error?.stack,
          },
        });
      });
      window.addEventListener("unhandledrejection", (e) => {
        record("$unhandled_rejection", {
          properties: { reason: String(e.reason) },
        });
      });
    },
  };
}
```

Three things worth noting:

- The plugin emits through `record()`, so the event picks up identity,
  session, and environment context just like an autocaptured event.
- It does its own DOM work (`window.addEventListener`). The plugin API
  is deliberately minimal; everything the plugin needs from the host
  environment comes from platform APIs, not from a wrapper layer.
- It is SSR-safe (guards on `typeof window`). Plugins are responsible
  for their own environment guards, same as core.
