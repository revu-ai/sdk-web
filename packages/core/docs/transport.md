# Transport and offline

[Docs index](./index.md) - [package README](../README.md)

Events do not get lost when the network is hostile or the page is
closing. Three layers cooperate to make that true: a durable queue, a
retrying transport, and two terminal flush paths for unload.

## What the transport sends

- **Endpoint.** `POST ${host}/v1/behavior/events`. One endpoint, one
  path; a single `connect-src` entry covers every request the SDK
  makes. `host` defaults to `https://api.revu.ai`; point it at your own
  domain for [first-party ingest](./first-party-ingest.md).
- **Body.** JSON with `{ api_key, batch }`, content type
  `application/json`.
- **Method.** `fetch` with `keepalive: true` while the page is live;
  `sendBeacon` (with an explicit `application/json` Blob) on
  `pagehide` and `visibilitychange -> hidden`.

## When the transport flushes

The transport flushes on any of:

- **Size threshold.** The queue size reaches `flushAt` (default 20).
- **Time interval.** Every `flushIntervalMs` (default 5000 ms) a
  background timer drains whatever is in the queue.
- **Connectivity returns.** On the `online` event, the failure counter
  and backoff reset and a flush attempts immediately.
- **Terminal lifecycle.** `pagehide` and `visibilitychange -> hidden`
  both trigger a `sendBeacon` flush so the final batch survives unload.
- **Manual.** [`revu.flush()`](./api.md#revuflush) drains the buffer
  immediately and resolves to `true` on success.

Each flush sends at most `maxBatch` events per request (default 50). If
the queue holds more, it drains across several requests rather than one
oversized body.

## The durable queue

Events are appended to a localStorage-backed FIFO queue on every
`record()` call, before any send is attempted. That means:

- An offline period buffers locally and ships on the next `online`.
- A crash, a hard reload, or a closed laptop lid does not lose events;
  the next page load drains what was left.
- The queue is bounded by `maxQueue` (default 1000). When the cap is
  hit, the oldest events are pruned first (recent behavior is more
  valuable than stale backlog).
- A successful send only commits the batch (removes it from the queue)
  after the server acknowledges. A failed send leaves events queued
  for the next attempt.

When localStorage is unavailable (private mode in some engines, strict
quotas, storage disabled), the queue transparently falls back to an
in-memory array. The SDK keeps capturing; it just loses durability
across reloads. With `debug: true` the fallback is logged.

## Retries and backoff

Transient failures (network error, 429, 503, any non-2xx) keep the
batch in the queue and schedule a retry with capped exponential
backoff:

- Base delay: 1 s.
- Doubles per consecutive failure.
- Capped at 60 s.

The first success resets the counter, so a flapping network does not
ratchet the delay indefinitely.

The ingest endpoint dedupes on `event_id` (every event carries a
client-generated UUID and that UUID is the idempotency key), so a retry
that overlaps a send that actually landed is safe.

## Terminal flush ordering

The terminal flush is installed last in the SDK boot sequence, on
purpose. `pagehide` and `visibilitychange` listeners on the same
target fire in registration order during the bubble phase, so the
transport's terminal handler runs after every emit-on-terminal module
(autocapture's `$page_leave`, vitals' LCP / INP / CLS report, any
plugin doing the same). That ordering guarantees the final batch
already contains those last events when `sendBeacon` ships it.

iOS Safari is the reason two terminal events are wired instead of one.
On desktop, `pagehide` covers tab close, navigation, and bfcache
eviction. On mobile (especially iOS Safari), `pagehide` is often
skipped when the user backgrounds the app or closes the tab; the only
reliable terminal signal there is `visibilitychange -> hidden`. The
transport listens on both and dedupes so each real terminal close
emits one batch.
