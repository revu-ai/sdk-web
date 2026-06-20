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
- [`revu.optOut()` / `revu.optIn()` / `revu.hasOptedOut()`](#revuoptout--revuoptin--revuhasoptedout)
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

Replace the current `user_id` with your authoritative auth id (call on
login or register).

```js
revu.identify("u_4b9a2");
```

Emits a synthetic `$identify` event so the dashboard can mark the exact
moment the visitor became known. If a prior `user_id` existed, the event
carries `properties.previous_user_id` so the transition is visible on
the timeline.

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
gets a magic link by email. They open the link on their phone, which
has its own auto-assigned `user_id`. After auth resolves on the phone,
call:

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
end of the identified session, then clears the user id and rotates the
session id. The anonymous device id is preserved.

```js
function onLogout() {
  revu.reset();
}
```

**Order matters.** The `$reset` event ships with the OLD `session_id`
and `user_id`, so it sorts as the final marker of the logged-in session
on the timeline. Subsequent events use a fresh session id with
`user_id: null` (or a fresh auto id when `autoIdentify` is on).

**Edge cases.**

- No-op when there is no identified user. A redundant sign-out path
  (multiple components calling reset on logout) will not accidentally
  rotate the session for an anonymous visitor.
- The `anonymous_id` is never rotated by `reset()`. The browser remains
  a known device.

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

**Behavior.**

- Opting out does **not** clear identity. Opting back in resumes the same
  visitor; call `revu.reset()` if you want a clean break instead.
- `optOut()` stops new capture but leaves events already queued under
  prior consent to flush. To also discard locally-buffered events, see
  [Privacy and data](./privacy.md#dropping-locally-buffered-events).
- `hasOptedOut()` returns `false` before `init()`.

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

The build string of the bundle (for example `"0.1.0"`). The same string
ships on every event as `properties.$sdk_version`, and it is useful for
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
`alias`, `reset`, `optOut`, `optIn`, `hasOptedOut`, `flush`, and `use`.
The capture and identity methods
mirror the singleton (the singleton calls `start()` for you inside
`init()`); they are not wrapped with the `safe()` boundary, so a host
using the class directly is responsible for catching errors at their own
boundary.
