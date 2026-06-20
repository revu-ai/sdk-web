# First-party ingest

[Docs index](./index.md) - [package README](../README.md)

By default the SDK sends events to `https://api.revu.ai`. You can instead
route them through your own domain so the requests are first-party. This
is a data-completeness measure: some browser extensions and network-level
filters block requests to third-party analytics domains by domain name,
so a portion of your traffic never reaches a third-party endpoint.
Serving ingest from your own origin keeps that data first-party and
intact.

This is purely a routing change. It collects nothing extra and changes
nothing about what is captured: events stay consent-gated, redacted at
source, and value-free exactly as before. The SDK does not obfuscate or
rotate its request path - the goal is first-party data, not hiding
network calls from the person using the browser.

## How it works

Point the SDK's [`host`](./configuration.md#options) at a path on your
own domain:

```js
revu.init({
  apiKey: "revu_pk_...",
  host: "https://yourapp.com/ingest",
});
```

The SDK then posts to `https://yourapp.com/ingest/v1/behavior/events`.
You run a thin reverse proxy at `/ingest/*` that forwards to
`https://api.revu.ai/*`. Two things fall out of this for free:

- **The browser request is same-origin** (`yourapp.com` to
  `yourapp.com`), so there is no CORS preflight to worry about.
- **The proxy-to-api hop is server-to-server**, so it is unaffected by
  anything in the browser.

No SDK changes beyond `host`, and no REVU api changes: the ingest
endpoint already accepts requests from any origin (per-key origin
allowlists are enforced server-side) and authenticates on the public key
in the request body, not on the request host.

Both transport paths - the live `fetch` (with `keepalive`) and the
`sendBeacon` terminal flush on page hide - target `host`, so both are
proxied identically. The durable queue is scoped to the page origin and
is unaffected.

## Proxy recipes

Each recipe forwards `/ingest/*` on your domain to
`https://api.revu.ai/*`, preserving the rest of the path
(`/v1/behavior/events`). Use any path prefix you like; just keep it
stable and match it to the `host` you pass to `init()`.

**Restrict the forward to the behavior path** (`/v1/behavior/`) rather
than proxying everything, so the rule is not an open relay.

### Cloudflare Worker

Route `yourapp.com/ingest/*` to this Worker:

```js
export default {
  async fetch(request) {
    const url = new URL(request.url);
    // Strip the "/ingest" prefix, keep the rest (/v1/behavior/events).
    const path = url.pathname.replace(/^\/ingest/, "");
    if (!path.startsWith("/v1/behavior/")) {
      return new Response("Not found", { status: 404 });
    }
    const upstream = new URL("https://api.revu.ai" + path + url.search);
    return fetch(upstream, {
      method: request.method,
      headers: request.headers,
      body: request.body,
    });
  },
};
```

### nginx

Trailing slashes on both sides strip the `/ingest/` prefix:

```nginx
location /ingest/ {
  proxy_pass https://api.revu.ai/;
  proxy_set_header Host api.revu.ai;
  proxy_ssl_server_name on;
}
```

### Caddy

`handle_path` strips the matched prefix before proxying:

```caddy
handle_path /ingest/* {
  reverse_proxy https://api.revu.ai {
    header_up Host api.revu.ai
  }
}
```

### Vercel / Next.js

In `next.config.js`, a rewrite keeps the request first-party from the
browser's point of view:

```js
module.exports = {
  async rewrites() {
    return [
      {
        source: "/ingest/:path*",
        destination: "https://api.revu.ai/:path*",
      },
    ];
  },
};
```

## Self-hosting the SDK script

The same domain-based filtering can apply to the SDK file itself. The
build is a static asset, so you can serve it from your own domain (or
keep loading it from `cdn.revu.ai`). If you self-host, pin a version and
update deliberately rather than tracking latest, so a capture change
never ships to your users without your say-so. See
[Install](./install.md) for version pinning and SRI.

## Notes

- Keep the proxy path **stable**. The SDK does not rotate or randomize
  it, and a stable path is what keeps your own caching, logging, and SRI
  predictable.
- This does not change consent. A visitor who has denied the `analytics`
  category still produces no events; first-party routing only affects
  where the events that *do* ship are sent. See
  [Consent](./privacy.md#consent).
- Point your monitoring at the proxy: a misconfigured rewrite shows up as
  events disappearing, the same symptom as a wrong `host`. See
  [Troubleshooting](./troubleshooting.md#events-do-not-appear-in-the-dashboard).
