# REVU Web SDK

One-line, lightweight behavioral analytics for the web - part of the **REVU** product & customer intelligence platform. Autocapture with zero instrumentation; the AI taxonomy, self-healing, and fusion live server-side, so the SDK stays tiny.

```js
import revu from "@revu-ai/core";

revu.init({ apiKey: "your-write-key" });
// That's it - page views and clicks are captured automatically.
revu.identify("user-123");                      // optional, on login
revu.track("Plan Upgraded", { tier: "pro" });   // optional explicit event
```

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
