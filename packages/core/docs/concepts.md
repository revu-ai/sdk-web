# Concepts

[Docs index](./index.md) - [package README](../README.md)

The mental model behind the SDK. Four ideas cover almost everything you
will run into: identity, sessions, the canonical event shape, and the
"interactions, never values" rule.

## Contents

- [`anonymous_id` vs `user_id`](#anonymous_id-vs-user_id)
- [Sessions: engagement, not page visits](#sessions-engagement-not-page-visits)
- [The canonical event shape](#the-canonical-event-shape)
- [Interactions, never values](#interactions-never-values)

## `anonymous_id` vs `user_id`

Two ids, two layers:

- **`anonymous_id`** is the **device** id. A UUID generated on first
  visit and persisted across reloads. It never changes by user action.
  Logging out does not rotate it; `reset()` preserves it on purpose.
- **`user_id`** is the **person** id. With `autoIdentify` (the default),
  a UUID is auto-generated on first visit so every event arrives
  attributed to a stable visitor before login. `identify()` replaces
  it with your real auth id and persists. `reset()` rotates the auto id
  (logout becomes a new anonymous person from analytics' perspective)
  or clears it to `null` when `autoIdentify` is off.

Both ids are mirrored to localStorage and a first-party cookie by
default. If one store is evicted (Safari ITP can wipe localStorage
without touching cookies), the surviving store rehydrates the other on
the next read. When both stores are blocked (private mode, strict
quotas), the SDK falls back to in-memory ids for the page lifetime; it
never crashes the host.

Cross-device identity (the same person on two browsers) is joined via
[`revu.alias()`](./api.md#revualiasauthoritativeid).

## Sessions: engagement, not page visits

The single most common point of confusion. The short version:

A session is a span of continuous engagement with your product, not a
single page visit. With the default `sessionTimeoutMs` of 30 minutes,
all of the following stay inside one session:

- A page reload.
- An SPA route change.
- Opening a second tab on the same site.
- Closing the tab and reopening it within 30 minutes.
- Coming back from a 28-minute background while reading something else.

The session only rotates once the gap since the last recorded activity
exceeds the timeout. 30 minutes is the conventional default in
behavioral analytics; it is the value behind "average session duration"
numbers you have seen elsewhere.

Full discussion (including how to switch to per-load sessions or shorten
the window) is in [configuration.md](./configuration.md#sessiontimeoutms-sessions-are-engagement-not-page-visits).

### Engagement clock vs idle clock

Engagement time on `$page_leave` is the time the tab was **visible**,
not the time the user was **active**. A page where the user reads
silently for two minutes before scrolling still has two minutes of
engagement; the `$idle` and `$active` events are a separate signal that
the user stopped or resumed interacting. The two are orthogonal so that
content products and tool products can both reason about engagement
without one model contaminating the other.

A `$page_leave` fires on every `visibilitychange -> hidden`, not only on
a true exit, so one page view can produce several `$page_leave` events
(one per visible span) as the user tabs away and back. The `trigger`
property says what the SDK knew at emit time:

- `"navigation"` - an SPA route change closed the previous page. A
  transition, not an exit.
- `"pagehide"` - the definitive terminal signal fired (tab close,
  navigation, bfcache). The page is gone.
- `"hidden"` - the tab was backgrounded. The SDK cannot yet tell a
  blur from a close: on a real desktop close `visibilitychange ->
  hidden` fires *before* `pagehide`, so a `"hidden"` checkpoint is
  emitted first and then upgraded by a following `"pagehide"`. On
  mobile, where `pagehide` is unreliable, a `"hidden"` with no
  upgrade is often the only signal a terminal close ever produces.

Engagement is banked on the first emit for a span, so a `"pagehide"`
that upgrades a `"hidden"` carries ~0 additional `engagement_time_ms`.

For the server: sum `engagement_time_ms` grouped by `(session_id,
properties.path)` for total engagement (the upgrade's 0 is a no-op).
Count an exit when a span ends in `"pagehide"`, OR ends in `"hidden"`
with no subsequent activity on that `session_id` (the page was left and
never resumed) - do not treat every `"hidden"` as an exit, since a
blurred-then-resumed tab also produces one.

### Scroll depth: max + final on `$page_leave`

Every `$page_leave` carries two scroll-depth scalars alongside
`engagement_time_ms`:

- `max_scroll_percent` (0-100): the furthest depth reached on the page.
- `final_scroll_percent` (0-100): the depth at the moment of leave.

Together they answer three questions the milestone events cannot:

1. **Exact percentile depth** instead of buckets. Distinguishes "reached
   98%" from "stopped at 76%" instead of collapsing both to the 75%
   milestone.
2. **Scrollback**. `max_scroll_percent - final_scroll_percent > 0` means
   the user scrolled back up before leaving (re-reading, refer-back,
   abandoning after reaching the bottom). The size of the gap encodes
   how far back they went.
3. **Drop-off depth**. `final_scroll_percent` is the page position the
   user actually left from, useful for content quality grading.

A page shorter than the viewport reports `max = final = 100` on the
first `$page_leave` even if the user never scrolled, because the entire
document was already visible.

## The canonical event shape

Every event the SDK emits, autocaptured or explicit, has the same
shape:

```json
{
  "event_id": "11111111-1111-4111-8111-111111111111",
  "anonymous_id": "22222222-2222-4222-8222-222222222222",
  "user_id": "u_4b9a2",
  "session_id": "33333333-3333-4333-8333-333333333333",
  "sequence_no": 17,
  "platform": "web",
  "event_type": "$autocapture",
  "screen": "/pricing",
  "fingerprint": {
    "tag": "button",
    "text": "Start free trial",
    "selector": "button.primary",
    "ordinal": 0
  },
  "context": {
    "user_agent": "...",
    "language": "en-US",
    "timezone": "Europe/London",
    "viewport_width": 1440,
    "viewport_height": 900,
    "environment": "production",
    "sdk_version": "0.1.0",
    "consent": { "analytics": "granted", "marketing": "granted", "functional": "granted" }
  },
  "properties": {
    "path": "/pricing"
  },
  "device_time": "2026-06-15T10:21:33.014Z"
}
```

- **`event_id`** is a client-generated UUID and the idempotency key.
  The ingest endpoint dedupes on it if the SDK ever retries a batch
  that actually landed.
- **`sequence_no`** is a per-page-load monotonic counter, starting at 0
  on each SDK construction. A gap within one page load is evidence of
  loss. It does not span a session: a session continued across reloads
  or tabs restarts the counter at 0 each load, so cross-load loss
  detection relies on `event_id` (the dedupe key), not this field. A
  true per-session counter is deferred until the cross-tab queue mutex
  lands (sharing one counter across tabs without it would race).
- **`screen`** is the route at the moment the event is recorded and is
  the canonical page field. It equals `properties.path` for every event
  with one deliberate exception: on `$page_leave`, `screen` is the route
  being arrived at while `properties.path` is the page being left (on an
  SPA navigation the two differ). Group page-leave metrics (engagement
  time, scroll depth) by `properties.path`, not `screen`.
- **`fingerprint`** is present for `$autocapture` and `$rightclick`; it
  is a semantic, weighted summary of the clicked element so the server
  can name the action and survive DOM rewrites without an exact
  selector.
- **`context`** is the engine environment - the signals the SDK
  auto-populates, describing where the event happened. Keys are
  unprefixed and live in their own bucket, so they never collide with
  your `capture()` properties. It includes `user_agent`, `language`,
  `timezone`, `environment`, `sdk_version`, `viewport_width`,
  `viewport_height`, `screen_width`, `screen_height`,
  `screen_pixel_ratio`, `initial_referrer`, and `consent` (the
  per-category consent state), plus `connection_type`,
  `connection_downlink_mbps`, `connection_rtt_ms`, and `save_data` when
  the browser exposes the Network Information API, `gpc` when the browser
  advertises a Global Privacy Control signal, and the
  [attribution](#attribution-first-touch-and-last-touch) fields
  (`initial_utm_*` / `utm_*` and friends) when a visitor arrived from a
  campaign. The example above shows a representative subset.
- **`properties`** is the event's own payload: the capture layer's
  per-event fields (`path`, `url`, `depth_percent`, form structure, ...)
  and the custom properties you pass to `capture()`. Separate from
  `context`, so the two never collide.

JSDoc in `src/types.js` is the source of truth for the full type. Run
`bun run types` from the repo root to emit the corresponding `.d.ts`.

## Attribution: first touch and last touch

Campaign attribution has two halves. The server derives the immediate
attribution of a `$pageview` by parsing its captured URL. The SDK adds
the half the server cannot reconstruct on its own: persistence across
the visitor's lifetime, so a conversion that happens pages or days later
on a URL with no params still carries the campaign that drove it.

The SDK persists two records (in the same first-party store as identity)
and stamps both into every event's `context`, but only the keys actually
present:

- **First touch** (`context.initial_*`) is written once and never
  overwritten: the campaign that originally acquired the visitor. Fields:
  `initial_utm_source`, `initial_utm_medium`, `initial_utm_campaign`,
  `initial_utm_term`, `initial_utm_content`, `initial_gclid`,
  `initial_fbclid`, plus `initial_landing_path` and `initial_seen_at`
  (recorded even for a direct first visit).
- **Last touch** (`context.utm_source`, `utm_medium`, `utm_campaign`,
  `utm_term`, `utm_content`, `gclid`, `fbclid`) is rewritten whenever
  a new touch occurs - a landing that carries campaign params or arrives
  from an external referrer. Internal navigation does not overwrite it.

A direct visitor with no campaign carries almost nothing (just the first
landing path and time). Reading the stable `utm_*` / click-id keys is the
only client-side URL parsing the SDK does; everything else (user-agent,
geo) stays server-side.

## Interactions, never values

The SDK records what happened, not what was entered:

- No input value is ever read from `<input>`, `<textarea>`, `<select>`,
  or any `contenteditable` element.
- Form submits capture form structure only (`form_id`, `form_name`,
  `action`, `method`, `field_names[]`, `field_types[]`, `field_count`).
  Never values.
- Click fingerprints on sensitive targets (the elements above, plus
  anything inside a `[data-revu-mask]` subtree) are redacted: tag,
  role, and a fragile selector survive; text, `aria-label`, and `title`
  do not.
- When fingerprinting a non-sensitive container, the visible-text walker
  skips any sensitive descendant so a card's `innerText` cannot leak a
  child input's value.

This is not a tuning knob. It is the invariant the SDK exists to
enforce. Full details (including how to opt arbitrary regions out with
`data-revu-mask`) are in [privacy.md](./privacy.md).

## Event catalog

Autocaptured events, grouped by category. All carry the canonical
envelope above; the rows below describe what's distinctive about each.

**Lifecycle**

| Event | Fires when | Notable properties |
|---|---|---|
| `$pageview` | First load and on every SPA route change | `url`, `path`, `referrer`, `title` |
| `$page_leave` | SPA route change, tab close, navigation, or `visibilitychange -> hidden` | `path` (the page being left), `trigger` (`"navigation"` / `"hidden"` / `"pagehide"`), `engagement_time_ms`, `max_scroll_percent`, `final_scroll_percent`, `persisted` |
| `$page_restore` | `pageshow` with `persisted: true` (bfcache restore via Back button) | `path` |
| `$tab_hidden` / `$tab_visible` | Visibility flips | `visible_ms` / `hidden_ms` |
| `$idle` / `$active` | User stops or resumes interacting (gated by `idleTimeoutMs`) | `active_ms` / `idle_ms` |

**Interactions**

| Event | Fires when | Notable properties |
|---|---|---|
| `$autocapture` | Any click (with `fingerprint`) | `path` |
| `$rightclick` | Right-click / context menu | `path` |
| `$rageclick` | A burst of repeated clicks on the same element | `click_count`, `window_ms`, `path` |
| `$file_download` | Click on an anchor classified as a download | `url`, `filename`, `extension`, `path` |
| `$outbound_link` | Click on an anchor leaving the current host | `url`, `target_host`, `path` |
| `$form_submit` | Form submitted | `form_id`, `form_name`, `action`, `method`, `field_names[]`, `field_types[]`, `field_count` (no values) |
| `$change` | `change` on `<input>`, `<select>`, `<textarea>` (skips password / file / hidden) | `control_type`, `checked` for boolean controls, `fingerprint`. **Never** the entered value; inside a `data-revu-mask` region `checked` is withheld too. |
| `$scroll` | Reaching 25% / 50% / 75% / 100% depth, once per milestone per page | `depth_percent`, `path` |
| `$resize` | Viewport resize (debounced) | `from_width`, `from_height`, `to_width`, `to_height` |

**Identity**

| Event | Fires when | Notable properties |
|---|---|---|
| `$identify` | `identify(userId)` ties the anonymous visitor to a known user | `previous_user_id` (when an already-identified user changes) |
| `$alias` | `alias(authoritativeId)` merges the current ids under one authoritative id | `authoritative_id`, `current_user_id`, `current_anonymous_id` |
| `$reset` | `reset()` ends the identified session (sign-out) | `previous_user_id` |

**Quality**

| Event | Fires when | Notable properties |
|---|---|---|
| `$web_vital` | LCP / INP / CLS report on page hide | `name`, `value`, `unit` (`"ms"` or `"score"`) |
