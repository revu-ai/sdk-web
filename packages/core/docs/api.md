# Public API

[Docs index](./index.md) - [package README](../README.md)

The default export of `@revu-ai/core` is a singleton bound to a single
client. Every public method is wrapped so internal errors are swallowed
and (in `debug: true`) logged. The SDK never throws into the host page.

JSDoc in `src/types.js` is the source of truth for parameter and return
types. This page documents semantics, examples, and edge cases.

## Contents

- [`revu.init(config)`](#revuinitconfig)
- [`revu.capture(eventType, properties?)`](#revucaptureeventtype-properties)
- [`revu.identify(userId)`](#revuidentifyuserid)
- [`revu.alias(authoritativeId)`](#revualiasauthoritativeid)
- [`revu.reset()`](#revureset)
- [`revu.getAnonymousId()` / `revu.regenerateAnonymousId()`](#revugetanonymousid--revuregenerateanonymousid)
- [`revu.optOut()` / `revu.optIn()` / `revu.hasOptedOut()`](#revuoptout--revuoptin--revuhasoptedout)
- [`revu.consent.set()` / `revu.consent.get()`](#revuconsentset--revuconsentget)
- [`revu.flush()`](#revuflush)
- [`revu.use(plugin)`](#revuuseplugin)
- [`revu.version`](#revuversion)
- [`RevuClient`](#revuclient)

## `revu.init(config)`

Initialize the SDK. Safe to call once per page. Subsequent calls are
ignored (the first config wins).

```js
revu.init({
  apiKey: "revu_pk_your_write_key", // required
  environment: "production", // optional
  cookieDomain: ".example.com", // share visitor across subdomains
});
```

Every other option is documented in [configuration.md](./configuration.md).

**Edge cases.**

- Missing or non-string `apiKey` is a configuration error. In production
  the SDK fails closed (no events ship). With `debug: true` the error
  is logged with a `[REVU]` prefix.
- Invalid `host` (not a string, not http or https, malformed URL) is also
  a configuration error and fails closed.
- Plugins registered via `revu.use(...)` before `init()` are queued and
  installed when `init()` runs.

## `revu.capture(eventType, properties?)`

Record an explicit event. Use this for signals autocapture cannot see:
server-confirmed completions, async results, wizard steps that do not
change the URL.

```js
revu.capture("checkout_completed", {
  plan: "pro",
  amount_cents: 4900,
  currency: "USD",
});
revu.capture("report_exported", { format: "pdf", pages: 12 });
```

**Property values.** Properties are sanitized to a JSON-safe shape at the
source before the event is queued, so a stray value can never break the
transport:

- Keep: strings, finite numbers, booleans, `null`, and nested plain
  objects / arrays of those.
- Dropped: functions, symbols, `BigInt`, `undefined`, and circular
  references (the cycle is dropped, the rest of the object is kept). A
  non-finite number (`NaN`, `Infinity`) becomes `null`, matching JSON.
- Depth: nesting is kept up to **6 levels**; anything deeper is dropped.
  Event properties are meant to be shallow, but this is worth knowing if
  you pass a deeply nested object - flatten what you need before sending.

**Edge cases.**

- An empty or non-string `eventType` is silently ignored.
- Properties you pass always win over engine-attached context on
  collision, so a host that knows better can override anything the SDK
  auto-populates.
- For interactions autocapture already names (a button click, a form
  submit, a pageview), prefer letting the server-side feature catalog
  group them. Calling `capture()` on top duplicates the signal.

## `revu.identify(userId)`

Bind the current visitor to your authoritative auth id. Call it on login
or register, with the user's real account id.

```js
revu.identify("u_4b9a2");
```

Emits a synthetic `$identify` event so the dashboard can mark the exact
moment the visitor became known.

There are two transitions, handled differently so identity stays clean on
shared and family devices:

- **Anonymous to identified** (no prior `user_id`): the current anonymous
  device is bound to the user. The pre-login activity in this session
  stitches to the now-known person.
- **One user to a DIFFERENT user** (a different known account): treated as
  an implicit logout + login. A `$reset` is emitted for the old user, the
  `anonymous_id` is rotated, and the two ids are NOT stitched together, so
  two accounts never collapse into one person just because they shared a
  device. This holds even if the host forgot to call `reset()` on logout.

**Edge cases.**

- Idempotent: calling `identify` repeatedly with the same id is a no-op
  (no duplicate `$identify` events).
- Empty string or non-string id is a no-op.
- The id is persisted, so a reload restores it without a second call.

See also: [concepts.md - anonymous_id vs user_id](./concepts.md#anonymous_id-vs-user_id).

## `revu.alias(authoritativeId)`

Join the current device's identity to a separate, authoritative identity
for the same person, without changing the local `user_id`.

The motivating flow is cross-device. A visitor signs up on desktop and
gets a magic link by email. They open the link on their phone, which has
its own separate device identity (and possibly a different local
`user_id`). After auth resolves on the phone, call:

```js
revu.alias("u_4b9a2");
```

The server records that the phone's current id and `u_4b9a2` are the
same human, and dashboards stitch both journeys. The phone's local
`user_id` stays the same so already-queued events still ship under it.

**Edge cases.**

- Idempotent: the server upserts on `(organization, alias_user_id)`,
  so repeated calls produce one mapping, not duplicates.
- Empty string or non-string id is a no-op.
- No-op when `authoritativeId` already equals the current local id.

## `revu.reset()`

Sign-out counterpart to `identify`. Emits a `$reset` event marking the
end of the identified session, then clears the user id, rotates BOTH the
session id and the `anonymous_id` (device id), and clears campaign
attribution (first and last touch).

```js
function onLogout() {
  revu.reset();
}
```

Rotating the `anonymous_id` is the logout-hygiene guarantee: the next
person on this browser (a shared, family, library, or kiosk device)
starts a clean identity and is never linked into the previous person. A
returning user re-unifies by their `user_id` on their next `identify()`,
so rotating the device id does not fragment them. Campaign attribution is
visitor-scoped and rotates with the device id for the same reason: the
next person does not inherit the previous person's acquisition campaign
(the server still derives per-event campaign from the `$pageview` URL).

**Order matters.** The `$reset` event ships with the OLD `session_id`
and `user_id`, so it sorts as the final marker of the logged-in session
on the timeline. Subsequent events use a fresh session id, a fresh
`anonymous_id`, and `user_id: null` (or a fresh auto id when
`autoIdentify` is on).

**Edge cases.**

- No-op when there is no identified user. A redundant sign-out path
  (multiple components calling reset on logout) will not accidentally
  rotate identity for an anonymous visitor.
- Calling `reset()` on logout is recommended but not strictly required to
  avoid contamination: `identify()` already rotates the device id when a
  different user logs in (see above). `reset()` additionally gives a clean
  break the moment the user logs out, before the next person acts.

## `revu.getAnonymousId()` / `revu.regenerateAnonymousId()`

Read or rotate the anonymous (device) id directly.

```js
const deviceId = revu.getAnonymousId();   // e.g. for a support ticket
revu.regenerateAnonymousId();             // mint a fresh device id on demand
```

- **`getAnonymousId()`** returns the current device id, or `null` before
  `init()`. Parity with other SDKs' `getDeviceId()`; handy for support,
  debugging, or correlating with server-side records.
- **`regenerateAnonymousId()`** mints a fresh device id, persists it, and
  returns it (or `null` before `init()`). It rotates **only** the device id
  - the user id, session, and consent are left intact. Use it for an
  explicit "reset device identity" control outside the normal logout flow;
  `reset()` already rotates the device id on sign-out, so you do not need
  this for logout.

Both catch internally and never throw into the host page.

## `revu.optOut()` / `revu.optIn()` / `revu.hasOptedOut()`

The master capture switch. A cookie banner routes its state through these
rather than wrapping every call in a consent check.

```js
revu.optOut();        // stop all capture (reject / withdraw consent)
revu.optIn();         // resume capture (accept)
revu.hasOptedOut();   // -> boolean
```

While opted out, every interaction (autocapture, pageviews, custom
`capture()` calls, identity events) is suppressed before an event is
built, so nothing leaves the browser. The choice is persisted in the
same first-party store as identity, so a reload honors it without
re-prompting.

These are aliases for the `analytics` consent category: `optOut()` is
`consent.set({ analytics: "denied" })` and `optIn()` is
`consent.set({ analytics: "granted" })`. Use them for a simple binary
banner; use [`consent.set()`](#revuconsentset--revuconsentget) when you
need per-category control.

**Behavior.**

- Opting out does **not** clear identity. Opting back in resumes the same
  visitor; call `revu.reset()` if you want a clean break instead.
- `optOut()` stops new capture but leaves events already queued under
  prior consent to flush. To also discard locally-buffered events, see
  [Privacy and data](./privacy.md#dropping-locally-buffered-events).
- `hasOptedOut()` returns `false` before `init()`.

## `revu.consent.set()` / `revu.consent.get()`

Per-category consent control. The SDK understands three categories -
`analytics`, `marketing`, and `functional` - each `"granted"` or
`"denied"`.

```js
// Map a cookie banner's result straight through (partial maps merge):
revu.consent.set({ analytics: "granted", marketing: "denied" });

revu.consent.get();
// -> { analytics: "granted", marketing: "denied", functional: "granted" }
```

Only `analytics` gates capture: denying it suppresses every event,
exactly like `optOut()`. `marketing` and `functional` are declarative -
the SDK stamps the full state on every event as `context.consent` so
the server can honor the visitor's choices on downstream destinations,
but it never acts on them itself.

**Behavior.**

- `set()` merges a partial map over the current state and persists the
  result in the same first-party store as identity. Unknown categories
  and values other than `"granted"` / `"denied"` are ignored.
- `get()` returns a copy of the current state. Before `init()`, `set()`
  is a no-op and `get()` returns the all-granted default.
- A pre-existing binary opt-out from an earlier SDK version is read on
  the first load after upgrade, so a prior reject keeps being honored.
- See [Global Privacy Control](./configuration.md#consent-and-gpc) for
  how the `honorGpc` option feeds this state.

## `revu.flush()`

Send any buffered events now. Returns a promise that resolves to `true`
when the batch is accepted, `false` if the send fails, and `undefined`
if called before `init()`.

```js
await revu.flush();
```

You rarely need to call this. Events flush automatically on a size
threshold (`flushAt`, default 20), on an interval (`flushIntervalMs`,
default 5000 ms), when connectivity returns (`online`), and on page
hide. Manual `flush()` is useful when you are about to do something
destructive (full reload, navigate away to a non-instrumented page)
and want the buffer drained first.

## `revu.use(plugin)`

Register a plugin. Equivalent to passing it via `init({ plugins: [...] })`,
but available as a separate call so plugins can be wired conditionally
(behind a feature flag, after a config fetch).

```js
import revu from "@revu-ai/core";
import { myPlugin } from "./my-plugin.js"; // your own plugin, see plugins.md

revu.use(myPlugin());
revu.init({ apiKey: "revu_pk_..." });
```

Pre-init `use()` calls are queued and drained when `init()` runs. The
same plugin name registered twice is a no-op so a redundant wiring path
does not cause double listeners.

See [plugins.md](./plugins.md) for the plugin contract.

## `revu.version`

The build string of the bundle (for example `"0.2.0"`). The same string
ships on every event as `context.sdk_version`, and it is useful for
support tickets (paste it in) and console introspection.

```js
console.log(revu.version);
```

## `RevuClient`

The named export `RevuClient` is the class behind the singleton. The
singleton is the right answer for almost every host: it removes a layer
of wiring and guarantees one source of identity per page. Construct
`RevuClient` directly only when you genuinely need multiple isolated
clients in the same page (a rare case, typically embedded analytics in
a multi-tenant editor).

```js
import { RevuClient, VERSION } from "@revu-ai/core";

const client = new RevuClient({
  apiKey: "revu_pk_...",
  host: "https://api.revu.ai",
  /* every option from configuration.md */
});
client.start();
client.capture("event_name", { foo: "bar" });
```

`RevuClient`'s public methods are `start`, `capture`, `identify`,
`alias`, `reset`, `getAnonymousId`, `regenerateAnonymousId`, `optOut`,
`optIn`, `hasOptedOut`, `setConsent`, `getConsent`, `flush`, and `use`.
The capture and identity methods
mirror the singleton (the singleton calls `start()` for you inside
`init()`); they are not wrapped with the `safe()` boundary, so a host
using the class directly is responsible for catching errors at their own
boundary.
