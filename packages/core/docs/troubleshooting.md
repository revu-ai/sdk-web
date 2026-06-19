# Troubleshooting

[Docs index](./index.md) - [package README](../README.md)

The SDK fails closed and never throws into the host page, so most
problems show up as "no events arrive" rather than as a stack trace.
The flow below isolates the cause.

## Events do not appear in the dashboard

1. **Confirm init ran.** With `debug: true`, you should see at least
   one `[REVU] event` log on first interaction.
2. **Confirm `environment` matches your dashboard filter.** The default
   dashboard view shows `production` only, so a `staging` or
   `development` build is hidden until you switch the filter.
3. **Check the network panel** for a POST to
   `${host}/v1/behavior/events`. A pending, blocked, or failed request
   points at one of the next sections.

## CSP blocks the ingest request

Symptom: console message about Content Security Policy. The SDK never
throws, but no events reach ingest. Fix by allowing the ingest host in
your `connect-src` directive:

```http
Content-Security-Policy: connect-src 'self' https://api.revu.ai
```

If you have set a custom `host`, allow that origin instead. The SDK
issues exactly one type of request (POST `/v1/behavior/events`), so a
single `connect-src` entry covers every path.

## The request returns 403

Symptom: the network panel shows a POST to `/v1/behavior/events` that
returns `403`. The key is valid but the request `Origin` is not on that
key's allowed-origin list, so ingest rejects it. Add your site's origin
(for example `https://app.example.com`) to the allowed origins for the
key. This is distinct from a CSP block, which fails inside the browser
before any request leaves the page.

## `sendBeacon` returns false on unload

Symptom: the terminal `$page_leave` and `$web_vital` events do not
arrive on tab close. Two common causes:

- **Content type.** `sendBeacon` defaults a string body to
  `text/plain`, which strict ingest endpoints reject. The SDK already
  wraps the body in a `Blob` with `application/json`, so an upgrade to
  the current version fixes this. If you front the SDK with your own
  proxy, make sure it accepts `application/json`.
- **Cross-origin and CSP.** `sendBeacon` honors `connect-src` just like
  `fetch`. See the section above.

## Mobile Safari does not deliver the final batch

iOS Safari frequently skips `pagehide` when the user backgrounds the
app or closes the tab. The SDK works around this by listening on
**both** `pagehide` and `visibilitychange -> hidden`, deduping so each
real terminal close emits one `$page_leave` and one transport flush.
If you still see missing terminal events, check:

- Are you wrapping the SDK in another layer that intercepts page
  lifecycle events? A wrapper that swallows `visibilitychange` removes
  the only reliable terminal signal on iOS Safari.
- Is the page being killed by the OS before the SDK can flush? The
  events are durably queued; they ship on the next visit to the same
  origin in the same browser.

## Events disappear after a page reload

Unlikely: the durable queue is backed by localStorage and `add()`
persists on every mutation. If you see this, check:

- **Are events queued in a different storage origin?** localStorage is
  scoped to the origin, so a hop from `app.example.com` to
  `www.example.com` is a different store. Identity is the same unless
  `cookieDomain` is set; the queue is per-origin and cannot be shared
  across subdomains.
- **Is localStorage disabled?** Private mode, third-party storage
  blocked inside an iframe, or strict quotas force the SDK to fall
  back to an in-memory queue, which does not survive a reload. The
  fallback is logged in `debug: true`.
- **Has the queue hit `maxQueue` and pruned oldest?** Recent events
  still ship. If this happens steadily, you are buffering offline
  longer than `maxQueue` can hold; raise the cap.

## `revu.identify()` does not seem to take effect

- The call is idempotent. Calling `identify("u_4b9a2")` when the
  current id is already `u_4b9a2` is a no-op, including the synthetic
  `$identify` event. This is by design.
- Empty string or non-string id is a no-op.
- A persisted id survives reloads, so a prior `identify` is restored on
  the next page load even without a fresh call.

## `revu.reset()` does nothing

`reset()` is a no-op when there is no identified user. The intent is
that a redundant sign-out path (multiple components calling reset on
logout) does not accidentally rotate the session for an anonymous
visitor. If you want to force-rotate the session id, prefer
`sessionTimeoutMs: 0` for a session-per-load model.

## I see a `$pageview` per route, but no `$autocapture` clicks

- **Confirm autocapture is on.** `autocapture: false` disables click and
  pageview capture entirely; you would only see explicit `capture()`
  calls.
- **Confirm clicks are reaching the document.** The SDK installs at
  capture phase, so it observes interactions even when the host stops
  propagation at a lower handler. But a higher capture-phase wrapper
  above the SDK can still preempt it.

## Sessions rotate when I do not expect them to

If `session_id` rotates between page loads inside what you think of as
one visit, check:

- **Has the gap exceeded `sessionTimeoutMs`?** The default is 30
  minutes; a 35-minute gap rotates as designed. See
  [concepts.md - sessions](./concepts.md#sessions-engagement-not-page-visits).
- **Is `sessionTimeoutMs: 0` set?** That explicitly disables
  continuation so every page load gets a brand new session.
- **Is storage being cleared between loads?** If localStorage and
  cookies are both blocked, the session id is in-memory only and rotates
  on every load.

## Type errors against `.d.ts`

JSDoc in `src/types.js` is the single source of truth for both runtime
behavior and emitted types. `bun run types` (from the repo root)
rebuilds the `.d.ts`. If your IDE shows stale types after pulling,
restart the TS server and rerun `bun run types`.
