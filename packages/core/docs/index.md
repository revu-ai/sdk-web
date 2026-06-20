# Documentation

The reference manual for `@revu-ai/core`. The [package README](../README.md)
covers the pitch, install, and your first event in 60 seconds; this tree
covers everything else.

## A short tour

If you have five minutes, read in this order:

1. **[Concepts](./concepts.md)** for the mental model: two ids
   (`anonymous_id` for the device, `user_id` for the person), one
   rolling session, and one canonical event shape that the rest of the
   SDK is just plumbing for.
2. **[Public API](./api.md)** for the public surface you will actually
   call: the methods `init`, `capture`, `identify`, `alias`, `reset`,
   `flush`, and `use`, plus the `version` property. Most hosts only ever
   touch `init`, `identify`, `capture`, and `reset`.
3. **[Configuration](./configuration.md)** for every option, with
   defaults and "use when" notes. Includes the
   [sessionTimeoutMs callout](./configuration.md#sessiontimeoutms-sessions-are-engagement-not-page-visits)
   on why a session continues across reloads, SPA route changes, and
   second tabs by default (and how to change that).

The other four pages are reference material you reach for when you need
them, not front-to-back reading.

## All pages

### Using the SDK

- **[Install](./install.md)** - the CDN `<script>` snippet, the npm
  install, version pinning on `cdn.revu.ai`, and SRI hashes.
- **[Public API](./api.md)** - `init`, `capture`, `identify`, `alias`,
  `reset`, `flush`, `use`, `version`, and the `RevuClient` class.
  Signature, example, and edge cases per method.
- **[Configuration](./configuration.md)** - every option you can pass
  to `init()`. Default, type, and a one-line "use when" note. The
  `sessionTimeoutMs` callout is here.

### Understanding the SDK

- **[Concepts](./concepts.md)** - `anonymous_id` vs `user_id`,
  session continuation, the canonical event shape, and the
  "interactions, never values" rule.
- **[Privacy and data](./privacy.md)** - what is masked by default,
  `data-revu-mask` for opting subtrees out, what the SDK does not
  parse client-side, opt-out patterns.
- **[Transport and offline](./transport.md)** - the ingest endpoint,
  flush triggers, the durable localStorage queue, retry and backoff,
  and the dual-signal terminal flush that makes mobile Safari reliable.
- **[First-party ingest](./first-party-ingest.md)** - route events
  through your own domain for first-party data completeness, with
  copy-paste reverse-proxy recipes (Cloudflare, nginx, Caddy, Next.js).

### Extending and operating the SDK

- **[Plugins](./plugins.md)** - the plugin contract, how to register,
  when to ship as a subpath plugin vs a separate package, and a worked
  example.
- **[Troubleshooting](./troubleshooting.md)** - common failures and
  how to isolate them: CSP, `sendBeacon` Content-Type, mobile Safari
  terminal events, durable queue origin scoping, identify and reset
  semantics, unexpected session rotation.

## Common starting points

Looking for something specific?

- **"My events do not arrive."** Start at
  [troubleshooting.md - events do not appear in the dashboard](./troubleshooting.md#events-do-not-appear-in-the-dashboard).
- **"Why does every page load not start a new session?"** Read
  [configuration.md - sessions are engagement, not page visits](./configuration.md#sessiontimeoutms-sessions-are-engagement-not-page-visits).
- **"How do I track the same user across two devices?"** See
  [`revu.alias()`](./api.md#revualiasauthoritativeid).
- **"What does the SDK send, exactly?"** See
  [the canonical event shape](./concepts.md#the-canonical-event-shape).
- **"How do I mask a PII region or a sensitive form?"** See
  [`data-revu-mask`](./privacy.md#data-revu-mask).
- **"How do I add my own event type without bloating core?"** See
  [the plugin contract](./plugins.md#the-contract).

## A note on the source

JSDoc in `src/types.js` is the source of truth for parameter and
return types. These pages document semantics, defaults, and edge cases.
For the canonical type signatures, look at the JSDoc or the emitted
`.d.ts` after `bun run types`.
