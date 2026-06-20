# Privacy and data

[Docs index](./index.md) - [package README](../README.md)

The SDK captures interactions, not values. The boundary is deliberately
broad and enforced at the source of capture, not at the ingest endpoint.

## What is masked by default

- **Inputs are never read.** Form fields (`<input>`, `<textarea>`,
  `<select>`) and any `contenteditable` region are sensitive; their
  values do not leave the browser.
- **Form submits carry metadata only.** Structure (`form_id`,
  `form_name`, `action`, `method`, `field_names[]`, `field_types[]`,
  `field_count`), never values.
- **Every form-entry element is sensitive by tag, not by type.** Every
  `<input>` (regardless of its `type`), `<textarea>`, and `<select>` is
  treated as sensitive, so no text or value is read from it. There is no
  type allowlist: a plain `text` or `number` field is masked exactly
  like a `password` field. As an extra layer, the `$change` interaction
  event skips `password`, `file`, and `hidden` inputs entirely.
- **Click fingerprints on sensitive targets are redacted.** Tag, role,
  and a fragile selector survive; `text`, `aria_label`, and `title` do
  not.
- **Container text never leaks child input values.** When fingerprinting
  a non-sensitive container, the visible-text walker skips any
  sensitive descendant, so a card's `innerText` cannot include a child
  input's value.

## `data-revu-mask`

Add the attribute to any element (or any ancestor) to mark its subtree
sensitive. The SDK honors it everywhere a sensitive element would be
honored:

- Click fingerprints inside the subtree redact text, `aria-label`, and
  `title`.
- Form submits inside the subtree skip field-name capture entirely.
- Container text extraction skips the subtree.

```html
<!-- Mask a PII summary card -->
<aside data-revu-mask>
  <h3>Account balance</h3>
  <p>$1,234.56</p>
</aside>

<!-- Mask one field on a form (or the whole form) -->
<form data-revu-mask>
  <input name="ssn" type="text" />
</form>
```

The attribute also crosses Shadow DOM boundaries: a `data-revu-mask` on
a custom element's host applies to every element in its shadow tree.

## URLs and query strings

Captured URLs (the `$pageview` `url`, the referrer, and `$outbound_link` /
`$file_download` targets) routinely carry secrets in their query string:
a password-reset token, an OAuth code, an email address in `?email=`. The
SDK redacts the **values** of sensitive query parameters at the source,
replacing them with `[redacted]` before the event is built.

The redaction is by parameter name, not wholesale, because the server
derives campaign attribution (UTM, click ids) from the captured URL. So
`utm_source`, `utm_medium`, `gclid`, `fbclid`, and other attribution and
benign params are preserved, while `token`, `password`, `secret`, `auth`,
`api_key`, `session`, `email`, and similar credential / PII keys (matched
case-insensitively, including `_`/`-`-delimited variants like
`access_token` and `user_email`) have their values stripped.

This is redaction at source, not a toggle: there is no option to capture
raw query values. The page identity (`screen` / `path`) is the pathname
plus hash and never includes the query string at all.

## What the SDK does not parse client-side

By design, several categories of work live server-side:

- **URL query parsing.** Campaign attribution (UTM, click ids) is
  derived server-side from the `$pageview` URL on the first event of
  each session. The SDK does not ship a parser for these.
- **User agent parsing.** The SDK ships the raw `navigator.userAgent`
  string; the server parses it into os, browser, and device. UA strings
  drift; the server can iterate on the parser without a customer
  redeploy.
- **IP-based geo.** The SDK never reads or sends client geolocation.
  The server enriches based on the request's IP, which is also more
  durable than client APIs and never requires a permission prompt.

This is a hard boundary, not a temporary state. Anything that would
require shipping a dictionary, an algorithm, or a model to the browser
stays server-side. That is what keeps the bundle in single-digit
kilobytes.

## Opt-out

Capture is a master switch the host controls at runtime, so a cookie
banner routes its state through the SDK rather than wrapping every call
in a check:

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

Opting out does not clear identity: opting back in resumes the same
visitor. That is the right default for a consent toggle (a user who
re-accepts is the same person). Call `revu.reset()` if you instead want
a clean break to a new anonymous visitor.

For per-element opt-out, use `data-revu-mask` on the subtree.

### Dropping locally-buffered events

`optOut()` stops new capture but leaves events already queued under prior
consent to flush. To also discard any locally-buffered events and stored
ids for a user who withdraws consent, clear the durable queue and
identity stores:

```js
revu.optOut();
try {
  localStorage.removeItem("revu_event_queue");
  localStorage.removeItem("revu_anonymous_id");
  localStorage.removeItem("revu_user_id");
  localStorage.removeItem("revu_session_id");
  localStorage.removeItem("revu_session_last_seen");
} catch {}
for (const id of ["revu_anonymous_id", "revu_user_id", "revu_session_id", "revu_session_last_seen"]) {
  document.cookie = `${id}=; Path=/; Max-Age=0; SameSite=Lax`;
}
```

A server-side right-to-be-forgotten helper that also purges already-ingested
events is planned; until then, the above fully disables capture and clears
local state.
