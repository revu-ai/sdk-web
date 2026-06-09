# Architecture

Durable design principles for the REVU Web SDK. Things that should not change without a deliberate, well-reasoned override.

## Plugin vs separate package

Every new feature lands in one of three shapes:

1. **In core, always on.** Universal, small, no privacy posture to weigh.
2. **Plugin inside core.** Lives under a subpath (e.g. `@revu-ai/core/exceptions`), opt-in via `revu.init({ plugins: [...] })` so it tree-shakes out for hosts that do not register it.
3. **Separate workspace package.** Its own `package.json` and npm publication (e.g. `@revu-ai/replay`), still implements the plugin contract.

### When a feature becomes a separate package

A feature graduates to its own workspace package when ANY of the following is true:

- size > ~5 kB gzipped
- it ships its own ingest endpoint
- it has a materially different privacy posture (replay, fingerprinting, anything that captures user data beyond behavior signals)
- it needs independent versioning (rapid iteration that should not gate core releases)
- it would otherwise force a runtime dependency on core (core is and must remain zero-dep)

Otherwise it is a **plugin inside core** under a subpath.

A feature stays **in core, always on** when it is also tiny (a few hundred bytes), zero-PII, and universally wanted. Web Vitals is the canonical example.

### Why these axes

- **Size > 5 kB**: protects the core size budget by construction, not by discipline.
- **Separate ingest endpoint**: the feature already has its own deployment surface; npm distribution should match.
- **Different privacy posture**: a separate npm install is visible on SBOMs and security reviews in a way a subpath import is not. For features that capture meaningfully different data classes (DOM mutations, fingerprints, full stack traces), this audit signal is worth the extra distribution overhead.
- **Independent versioning**: replay-style features iterate fast and should not gate stable core releases.
- **Avoids runtime dep in core**: core is zero-dep forever. Anything that needs a real dependency lives in a separate package whose own dep tree is its concern.

### Applied to the current roadmap

| Feature | Shape | Reason |
|---|---|---|
| Pageviews, clicks, scroll, forms, page-leave, identity | In core, always on | Universal baseline of behavior capture |
| Web Vitals (LCP / INP / CLS) | In core, always on | Tiny, zero-PII, universally wanted |
| Exceptions | Plugin inside core (`@revu-ai/core/exceptions`) | Privacy-relevant but ~800 bytes; subpath import is enough opt-in |
| Session replay | Separate package (`@revu-ai/replay`) | Hits 5/5 separate-package criteria |
| Surveys (future) | Separate package | UI library, large, independent product surface |
| Feature flags (future) | Plugin inside core | Small, no privacy posture, deeply integrated with identity |

Apply the rubric before the design conversation starts. Revisit it only if a feature lands in an unanticipated shape.

## The plugin contract

```ts
RevuPlugin = {
  name: string,                          // unique, used for dedup
  install(api: PluginApi): void,
  uninstall?(): void,
}

PluginApi = {
  record(eventType, data?),              // emit through the standard pipeline
  identity,                              // read-only access to ids
  context,                               // read-only environment context
  config,                                // read-only resolved config
}
```

A plugin's `install` is called once at start (or immediately on `use()` if start has already happened). The same plugin name registered twice is a no-op. Malformed plugins (missing name or install) are silent no-ops because of the cardinal invariant: never crash the host.

Plugins emit via `record()` so events automatically pick up identity, environment context, and the durable transport. They do not own their own transport; there is one queue, one batcher, one ingest path.

## Cardinal invariants

The six rules every part of the SDK respects. They do not change without a deliberate, well-reasoned override.

1. **Never crash the host page.** Every public entry point is wrapped with `safe()`. Internal errors are swallowed (and logged in debug mode).
2. **Never block.** Work is light, off the critical path; high-frequency events are throttled or debounced; the transport batches.
3. **Redact at source.** Capture interactions, not input values. Mask by default.
4. **Lightweight by design.** Size budget is a CI gate (`bun run size`).
5. **Stable public API.** Deprecate, do not break.
6. **Grounding.** The SDK captures; the server computes. No client-side metrics.

Every new feature, plugin, or package must respect all six.
