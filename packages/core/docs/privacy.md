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

Until a hosted opt-out endpoint ships, the recommended pattern is to
defer `init()` based on your consent state:

```js
if (userHasConsented()) {
  revu.init({ apiKey: "revu_pk_..." });
}
```

For per-element opt-out, use `data-revu-mask` on the subtree.

If you need to drop all locally-buffered events for a user who
withdraws consent, clear the durable queue and identity stores:

```js
try {
  localStorage.removeItem("revu_event_queue");
  localStorage.removeItem("revu_anonymous_id");
  localStorage.removeItem("revu_user_id");
  localStorage.removeItem("revu_session_id");
  localStorage.removeItem("revu_session_last_seen");
} catch {}
document.cookie = "revu_anonymous_id=; Path=/; Max-Age=0; SameSite=Lax";
document.cookie = "revu_user_id=; Path=/; Max-Age=0; SameSite=Lax";
document.cookie = "revu_session_id=; Path=/; Max-Age=0; SameSite=Lax";
document.cookie = "revu_session_last_seen=; Path=/; Max-Age=0; SameSite=Lax";
```

A first-class consent and opt-out helper is planned; until then, the
patterns above fully disable capture and clear any stored ids.
