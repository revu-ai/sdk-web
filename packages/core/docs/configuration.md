# Configuration

[Docs index](./index.md) - [package README](../README.md)

Every option passed to `revu.init({ ... })` is optional except `apiKey`.
Defaults are tuned to be the right answer for a typical product surface.

## Options

| Option              | Type                                         | Default                 | Use when                                                                                                                                                                                                                                                            |
| ------------------- | -------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apiKey`            | `string`                                     | required                | Your public write key. Starts with `revu_pk_`. Resolves to org and entity server-side.                                                                                                                                                                              |
| `host`              | `string`                                     | `"https://api.revu.ai"` | Override only when self-hosting the ingest service, running a regional endpoint, or pointing at a local dev server. Must be http or https.                                                                                                                          |
| `environment`       | `"production" \| "staging" \| "development"` | `"production"`          | Stamped on every event as `$environment`. The default dashboard view filters out non-production, so set this to `"staging"` or `"development"` on those builds to keep them out of production analytics.                                                            |
| `autocapture`       | `boolean`                                    | `true`                  | Auto-capture pageviews and clicks. Disable only when you want a fully manual `capture()`-only instrumentation.                                                                                                                                                      |
| `autoIdentify`      | `boolean`                                    | `true`                  | Auto-assign a persistent `user_id` on first visit so every event arrives attributed to a stable visitor even before login. Disable when your privacy posture requires anonymous-until-login.                                                                        |
| `persistentStorage` | `"localStorage" \| "cookie" \| "both"`       | `"both"`                | Where identity ids live. `"both"` mirrors to localStorage and a first-party cookie so eviction of one is recoverable from the other. Pick `"localStorage"` to drop the per-request cookie bandwidth, or `"cookie"` to share ids across subdomains exclusively.      |
| `cookieDomain`      | `string \| null`                             | `null`                  | Set to `".example.com"` to share one visitor across `app.example.com` and `www.example.com`. Leave unset to keep the cookie host-only.                                                                                                                              |
| `sessionTimeoutMs`  | `number`                                     | `1_800_000` (30 min)    | How long a session can sit idle before the next SDK construction rotates `session_id`. See the [callout below](#sessiontimeoutms-sessions-are-engagement-not-page-visits). Set to `0` to disable continuation entirely so every page load gets a brand new session. |
| `captureAttention`  | `boolean`                                    | `true`                  | Emit `$tab_hidden`, `$tab_visible`, `$idle`, `$active`. Disable to halve attention-event volume if you do not use the corresponding insights; engagement time on `$page_leave` always works regardless.                                                             |
| `idleTimeoutMs`     | `number`                                     | `30_000`                | Inactivity threshold (mouse, keyboard, scroll, touch) before `$idle` fires. Set to `0` to disable idle detection entirely.                                                                                                                                          |
| `captureWebVitals`  | `boolean`                                    | `true`                  | Emit `$web_vital` for LCP, INP, CLS on page hide. Disable only when you have a separate vitals pipeline.                                                                                                                                                            |
| `flushIntervalMs`   | `number`                                     | `5000`                  | Max time a partial batch sits before going out. Lower it for low-volume pages where you want events to land faster.                                                                                                                                                 |
| `flushAt`           | `number`                                     | `20`                    | Queue size that triggers an immediate flush. Lower it for chatty pages where you want smaller, more frequent batches.                                                                                                                                               |
| `maxBatch`          | `number`                                     | `50`                    | Hard cap on events per request body. Bound exists so a single network round-trip never sends an oversized payload.                                                                                                                                                  |
| `maxQueue`          | `number`                                     | `1000`                  | Hard cap on durably-queued events. When the cap is hit, the oldest events are pruned first (recent behavior is more valuable than stale backlog).                                                                                                                   |
| `sampleRate`        | `number`                                     | `1`                     | Fraction of sessions to capture, in `[0, 1]`. `1` keeps everything; `0.1` keeps ~10% of sessions and drops the rest before they queue, trading dashboard precision for ingest volume on high-traffic sites. Session-sticky (a whole session is kept or dropped), identity events always send (and never carry `$sample_rate`), and kept sampled events carry `$sample_rate` so the server scales aggregates. Out-of-range values throw at init. |
| `honorGpc`          | `boolean`                                    | `false`                 | When `true`, a browser [Global Privacy Control](#consent-and-gpc) signal defaults the `analytics` consent category to denied (suppressing capture) unless the visitor has made an explicit choice. Left `false` by default: honoring GPC is a jurisdictional decision for you to make (it is a valid opt-out under CCPA/CPRA but not the consent mechanism under GDPR), and auto-denying would silently drop data on upgrade. The signal is stamped on every event as `$gpc` regardless of this flag. |
| `debug`             | `boolean`                                    | `false`                 | Log every captured event and internal error to the console with a `[REVU]` prefix.                                                                                                                                                                                  |
| `onEvent`           | `(event) => void`                            | `() => {}`              | Local hook called with every captured event. Useful for debug overlays, screenshot annotations, and tests.                                                                                                                                                          |
| `beforeSend`        | `(event) => event \| null \| false \| void`  | `null`                  | [Last-mile hook](#beforesend-enrich-redact-or-drop) called with each built event before it queues. Return the event (mutated or replaced) to send it, `null` / `false` to drop it, or nothing to send it unchanged. Use it to enrich, redact, or filter. Fail-open: a throwing hook sends the event unchanged rather than dropping it. |
| `autocaptureAllowSelectors` | `string[]`                           | `[]`                    | When non-empty, only elements matching (or nested inside) one of these CSS selectors are autocaptured for clicks, right-clicks, and form-control changes. See [selector filtering](#autocapture-selector-filtering).                                                  |
| `autocaptureDenySelectors`  | `string[]`                           | `[]`                    | CSS selectors whose elements (and descendants) are excluded from element-targeted autocapture. Deny wins over allow. See [selector filtering](#autocapture-selector-filtering).                                                                                      |
| `plugins`           | `RevuPlugin[]`                               | `[]`                    | Plugins to install during `init()`. Equivalent to a `revu.use(plugin)` for each, but co-located with the rest of the config.                                                                                                                                        |

## `sessionTimeoutMs`: sessions are engagement, not page visits

This is the single most common point of confusion, so the default is
worth stating explicitly.

A **session** is a span of continuous engagement with your product, not
a single page visit. With the default `sessionTimeoutMs` of 30 minutes,
the SDK continues the previous session whenever the gap since the last
recorded activity is under 30 minutes. That means all of the following
stay inside one session:

- A page reload (refresh).
- An SPA route change.
- Opening a second tab on the same site.
- Closing the tab and reopening it within 30 minutes.
- Coming back from a 28-minute background while reading something else.

The session only rotates (gets a fresh `session_id`) once the gap since
the last recorded activity exceeds the timeout. 30 minutes is the
conventional default in behavioral analytics; it is the value behind
"average session duration" numbers you have seen elsewhere.

If you want every page load to start a new session (rarely the right
choice, but available for parity with very old per-load instrumentation
patterns), set:

```js
revu.init({ apiKey: "...", sessionTimeoutMs: 0 });
```

If your product is more like a content site where each visit really is a
distinct intent, shorten the window:

```js
revu.init({ apiKey: "...", sessionTimeoutMs: 10 * 60 * 1000 }); // 10 minutes
```

The session id is persisted (per `persistentStorage`) along with a
`last_seen` timestamp; on every event the SDK touches `last_seen`
(throttled so a chatty page does not pay a write per event), and the
next construction reads both to decide whether to continue or rotate.

## Consent and GPC

Capture is gated on a per-category consent state the host controls at
runtime, so a cookie banner routes its choices through the SDK rather
than wrapping every call in a check. There are three categories:

- **`analytics`** - the SDK's own bucket. This is the only category that
  gates capture: while it is `"denied"`, every interaction is suppressed
  before an event is built, so nothing leaves the browser.
- **`marketing`** and **`functional`** - declarative. The SDK does not
  act on them; it stamps the full consent state on every event
  (`properties.$consent`) so the server honors the visitor's choices on
  the destinations downstream.

```js
// Map a cookie banner's result straight through:
revu.consent.set({ analytics: "granted", marketing: "denied" });

revu.consent.get();
// -> { analytics: "granted", marketing: "denied", functional: "granted" }
```

`revu.optOut()` / `revu.optIn()` are aliases for denying / granting the
`analytics` category, so existing wiring keeps working. The state is
persisted in the same first-party store as identity, and a pre-existing
binary opt-out from an earlier SDK version is honored on upgrade.

**Global Privacy Control.** Some browsers advertise a GPC signal
(`navigator.globalPrivacyControl`). The SDK always stamps it on events as
`$gpc` so the server sees it. With `honorGpc: true`, a GPC signal also
defaults the `analytics` category to denied - unless the visitor has
already made an explicit choice through your banner, which always wins.
The default is `honorGpc: false`: whether GPC legally requires
suppression depends on your jurisdiction, so the decision is left to you.

```js
revu.init({ apiKey: "...", honorGpc: true }); // auto-deny on a GPC signal
```

## `beforeSend`: enrich, redact, or drop

`beforeSend` runs once per event, after the SDK has built the full event
but before it is queued. It is the place to add host context the SDK
cannot know, strip a field, or filter events you never want to store.

```js
revu.init({
  apiKey: "...",
  beforeSend(event) {
    // Enrich: attach something only the host knows.
    event.properties.tenant_plan = window.__APP__.plan;

    // Redact: drop a field you do not want stored.
    delete event.properties.some_internal_id;

    // Drop: filter noisy events entirely.
    if (event.event_type === "$autocapture" && event.screen === "/debug") {
      return null;
    }

    return event; // send it (mutated in place, or return a new object)
  },
});
```

- Return the event (the same one mutated, or a replacement object) to
  send it; return `null` or `false` to drop it; return nothing to send it
  unchanged.
- It is **fail-open**: if the hook throws, the original event is sent
  unchanged (and the error is logged when `debug` is on), so a bug in the
  hook never silently deletes analytics.
- The returned event's `properties` are re-sanitized to a JSON-safe shape,
  so the hook cannot poison the durable queue with an unserializable value.
- It does not run for events that were never built - capture suppressed by
  consent or sampling never reaches `beforeSend`.

## Autocapture selector filtering

`autocaptureDenySelectors` and `autocaptureAllowSelectors` scope which
elements element-targeted autocapture (clicks, right-clicks, form-control
changes) observes. Matching walks ancestors, so a selector on a container
also covers the elements inside it.

```js
revu.init({
  apiKey: "...",
  // Never autocapture anything inside these:
  autocaptureDenySelectors: [".sensitive-widget", "[data-no-track]"],
});

// Or capture ONLY inside an explicit set (everything else is ignored):
revu.init({
  apiKey: "...",
  autocaptureAllowSelectors: ["main", ".tracked"],
});
```

- **Deny wins.** An element matching a deny selector is never captured,
  even if it also matches an allow selector.
- A deny selector suppresses the event **entirely**, including the
  file-download, outbound-link, and rage-click events derived from a
  click. This is the difference from `data-revu-mask`, which still emits
  the event but redacts its fingerprint - use a deny selector when you
  want no event at all, and `data-revu-mask` when you want the interaction
  recorded without its labels. An invalid selector is ignored, not thrown.
