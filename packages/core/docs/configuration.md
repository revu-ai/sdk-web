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
| `debug`             | `boolean`                                    | `false`                 | Log every captured event and internal error to the console with a `[REVU]` prefix.                                                                                                                                                                                  |
| `onEvent`           | `(event) => void`                            | `() => {}`              | Local hook called with every captured event. Useful for debug overlays, screenshot annotations, and tests.                                                                                                                                                          |
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
