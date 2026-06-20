/**
 * @file RevuClient - the core orchestrator. Wires identity + capture + transport
 * together, builds the full {@link import("./types.js").RevuEvent} for each
 * interaction, and exposes the public surface (capture / identify / flush).
 */

import { Attention } from "./attention.js";
import { Capture } from "./capture.js";
import { Consent } from "./consent.js";
import { Context } from "./context.js";
import { Identity } from "./identity.js";
import { createStorage } from "./storage.js";
import { Transport } from "./transport.js";
import { VERSION } from "./version.js";
import { Vitals } from "./vitals.js";
import { hashUint32, nowIso, routePath, sanitizeProperties, uuid } from "./utils.js";

/**
 * Event types exempt from sampling - they must always ship so person and
 * session stitching stays correct even in a dropped session. Sampling a
 * `$identify` out would orphan every event under that user id.
 */
const SAMPLING_EXEMPT = new Set(["$identify", "$reset", "$alias"]);

export class RevuClient {
  /** @param {import("./types.js").ResolvedConfig} config */
  constructor(config) {
    this.config = config;
    this.identity = new Identity({
      autoIdentify: config.autoIdentify,
      persistentStorage: config.persistentStorage,
      cookieDomain: config.cookieDomain,
      sessionTimeoutMs: config.sessionTimeoutMs,
    });
    this.context = new Context({ environment: config.environment });
    this.consent = new Consent({
      storage: createStorage({
        mode: config.persistentStorage,
        cookieDomain: config.cookieDomain,
      }),
    });
    this.transport = new Transport({
      host: config.host,
      apiKey: config.apiKey,
      flushAt: config.flushAt,
      flushIntervalMs: config.flushIntervalMs,
      maxBatch: config.maxBatch,
      maxQueue: config.maxQueue,
      debug: config.debug,
      onEvent: config.onEvent,
    });
    // One emit closure shared by every collaborator; the only thing each
    // sink does is feed the standard pipeline (identity + context + transport).
    const emit = (/** @type {string} */ type, /** @type {any} */ data) =>
      this.record(type, data);
    // Shared error reporter for the DOM-listener `safe()` wraps. Listener
    // exceptions are always swallowed (never propagate into the host), but in
    // debug they surface here so an SDK bug is not invisible while debugging.
    const reportError = (/** @type {unknown} */ err) => {
      if (this.config.debug) console.error("[REVU]", err);
    };
    this.attention = new Attention(
      emit,
      { idleTimeoutMs: config.idleTimeoutMs, captureAttention: config.captureAttention },
      reportError,
    );
    // Renamed from `this.capture` to free the verb for the public
     // `capture(eventName, properties)` method below. The field still
     // refers to the auto-capture engine specifically, so `autocapture`
     // reads more accurately too.
    this.autocapture = new Capture(emit, this.attention, reportError);
    this.vitals = new Vitals(emit, reportError);
    /** @type {number} */
    this.sequence = 0;
    /** @type {string|null} Session id the cached sampling decision was made for. */
    this._sampleSessionId = null;
    /** @type {boolean} Cached session-sticky sampling decision (keep vs drop). */
    this._sampleKeep = true;
    /** @type {import("./types.js").RevuPlugin[]} Plugins registered so far. */
    this._plugins = [];
    /** @type {Set<string>} Names of plugins already installed (dedup). */
    this._installed = new Set();
    /** @type {boolean} True after `start()` so late `use()` calls install immediately. */
    this._started = false;
  }

  /** Start transport + attention + autocapture + vitals + any registered plugins. */
  start() {
    this.transport.start();
    // Attention starts before capture so the engagement clock is already
    // ticking when the initial $pageview fires.
    this.attention.start();
    if (this.config.autocapture) this.autocapture.start();
    if (this.config.captureWebVitals !== false) this.vitals.start();
    for (const plugin of this._plugins) {
      if (!this._installed.has(plugin.name)) this._installPlugin(plugin);
    }
    // Install the terminal pagehide flush LAST so it runs after every
    // emit-on-pagehide listener registered above (autocapture's
    // `$page_leave`, vitals' CLS / INP report, any plugin doing the same).
    // pagehide listeners on the same target fire in registration order, so
    // installing this one last guarantees the transport sees those final
    // events in the queue before it flushes.
    this.transport.installPageHideFlush();
    this._started = true;
  }

  /**
   * Register a plugin. Plugins added via `revu.init({ plugins: [...] })` flow
   * through here too. Calling `use()` after `start()` installs the plugin
   * immediately; before `start()` it is queued and installed when start runs.
   * The same plugin name registered twice is a no-op so a host that wires
   * a plugin in two code paths does not get double listeners.
   * @param {import("./types.js").RevuPlugin} plugin
   */
  use(plugin) {
    if (
      !plugin ||
      typeof plugin.name !== "string" ||
      plugin.name.length === 0 ||
      typeof plugin.install !== "function"
    ) return;
    if (this._installed.has(plugin.name)) return;
    this._plugins.push(plugin);
    if (this._started) this._installPlugin(plugin);
  }

  /**
   * Hand the plugin its API surface and mark it installed. The API is the
   * minimum a plugin needs to emit events through the standard pipeline
   * (identity + context + transport) while reading the current identity,
   * environment context, and resolved config.
   *
   * A throwing `install()` is contained here so one bad plugin cannot abort
   * the rest of `start()` - critically, it must not stop the terminal
   * pagehide flush (installed after the plugin loop) from being wired, which
   * would silently drop every session's final batch. The plugin is marked
   * installed only on success, so a host that re-registers it after fixing
   * the error gets a real retry rather than a permanent no-op.
   * @param {import("./types.js").RevuPlugin} plugin
   */
  _installPlugin(plugin) {
    try {
      plugin.install({
        record: (type, data) => this.record(type, data),
        identity: this.identity,
        context: this.context,
        config: this.config,
      });
      this._installed.add(plugin.name);
    } catch (err) {
      if (this.config.debug) {
        console.error(`[REVU] plugin "${plugin.name}" failed to install`, err);
      }
    }
  }

  /**
   * Build a full event from a captured interaction and enqueue it.
   * @param {string} eventType
   * @param {{ fingerprint?: import("./types.js").Fingerprint, properties?: Record<string, unknown> }} [data]
   */
  record(eventType, data = {}) {
    // Master consent gate: while opted out, capture is fully suppressed - no
    // event is built and nothing is enqueued. Persisted identity is left
    // untouched so opting back in resumes the same visitor.
    if (this.consent.optedOut()) return;
    // Session-sticky sampling: a whole session is either kept or dropped, so
    // funnels never show a hole that looks like real drop-off.
    if (!this._shouldSample(eventType)) return;
    const sampleRate = this.config.sampleRate;
    /** @type {import("./types.js").RevuEvent} */
    const event = {
      event_id: uuid(),
      anonymous_id: this.identity.anonymousId,
      user_id: this.identity.userId,
      session_id: this.identity.sessionId,
      sequence_no: this.sequence++,
      platform: "web",
      event_type: eventType,
      screen: routePath(),
      fingerprint: data.fingerprint,
      // Environment context first so caller-supplied properties
      // (capture(), capture-layer extras) win on collision: the host
      // always has the final word over what the SDK auto-populates.
      // $sdk_version stamps the build that emitted this event so the
      // server can correlate behavior with SDK versions when
      // investigating regressions or rolling out fixes.
      properties: {
        ...this.context.build(),
        $sdk_version: VERSION,
        // Stamp the sampling rate so the server can scale aggregates: a kept
        // event counts as 1/sample_rate toward volume estimates. Only on
        // events actually subject to sampling - identity events are exempt
        // (always sent), so stamping them would over-count them and, at
        // sampleRate 0, hand the server a 1/0 scaling factor.
        ...(sampleRate < 1 && !SAMPLING_EXEMPT.has(eventType)
          ? { $sample_rate: sampleRate }
          : {}),
        ...(data.properties || {}),
      },
      device_time: nowIso(),
    };
    this.transport.enqueue(event);
    // Keep the persisted session.last_seen current so a reload inside the
    // continuation window picks the same session_id back up. The identity
    // layer throttles persistence so this is cheap on chatty pages.
    this.identity.touchSession();
  }

  /**
   * Decide whether to keep an event under the configured `sampleRate`.
   *
   * The decision is session-sticky: it is derived from a deterministic hash
   * of the current `session_id`, so a single session is captured whole or
   * skipped whole rather than torn in the middle (a half-sampled session
   * looks like a real funnel drop-off, which is worse than less data). The
   * result is cached per session id and recomputed when the session rotates.
   * Identity / lifecycle events are exempt so person-stitching survives a
   * dropped session.
   * @param {string} eventType
   * @returns {boolean}
   */
  _shouldSample(eventType) {
    // `< 1` (rather than `>= 1`) so an unset / non-numeric rate keeps
    // everything: a RevuClient built from a partial config (e.g. in tests)
    // must not silently drop all events. resolveConfig() defaults this to 1.
    if (!(this.config.sampleRate < 1)) return true;
    if (SAMPLING_EXEMPT.has(eventType)) return true;
    const sid = this.identity.sessionId;
    if (sid !== this._sampleSessionId) {
      this._sampleSessionId = sid;
      // hashUint32 / 2^32 maps the session id into [0, 1); keep when it
      // falls under the rate. 2^32 is 0x100000000.
      this._sampleKeep = hashUint32(sid) / 0x100000000 < this.config.sampleRate;
    }
    return this._sampleKeep;
  }

  /**
   * Capture a custom (explicit) event.
   *
   * Public verb of the SDK, on purpose. REVU's wedge is autocapture - the
   * dashboard auto-derives a feature catalog from every click, form submit,
   * download, and pageview with zero code. When a host needs to send a
   * signal autocapture cannot see (a server-side payment completing, a
   * websocket message, a wizard step that does not change the URL), this
   * is the same verb extended: "we capture everything automatically, AND
   * here is how to also capture this".
   *
   * Non-string or empty event names are ignored (a no-op), mirroring
   * `identify()` and `alias()`. Caller-supplied properties are sanitized to a
   * JSON-safe shape before they enter the pipeline so a stray value (a
   * circular object, a BigInt, a DOM node) can never poison the durable
   * queue; unsupported values are dropped.
   *
   * @param {string} eventType
   * @param {Record<string, unknown>} [properties]
   */
  capture(eventType, properties) {
    if (typeof eventType !== "string" || eventType.length === 0) return;
    this.record(eventType, { properties: sanitizeProperties(properties) });
  }

  /**
   * Associate the current anonymous id with a known user id, and emit a
   * synthetic `$identify` event so a dashboard can pinpoint the exact
   * moment in the session timeline when identification happened.
   *
   * Idempotent: calling identify() repeatedly with the same userId is a
   * no-op (no duplicate $identify events). Non-string or empty userIds
   * are also no-ops. When identification transitions from one userId to
   * another, the emitted event's `properties.previous_user_id` carries
   * the prior value so the dashboard can render the change.
   *
   * @param {string} userId
   */
  identify(userId) {
    if (typeof userId !== "string" || userId.length === 0) return;
    if (this.identity.userId === userId) return;
    const previousUserId = this.identity.userId;
    this.identity.identify(userId);
    this.record("$identify", {
      properties: previousUserId ? { previous_user_id: previousUserId } : {},
    });
  }

  /**
   * Join the current device's identity to a separate, authoritative
   * identity for the same person without changing the local user id.
   *
   * Distinct from {@link identify}:
   *   - `identify()` means "this device now knows the user's id". The
   *     local user_id changes and subsequent events ship under it.
   *   - `alias()` means "the current id is the same person as
   *     `authoritativeId`". The local user_id does NOT change; the server
   *     records a mapping so prior and future events under either id
   *     resolve to the canonical person.
   *
   * The motivating flow is cross-device: a user signs up on desktop, the
   * server emails them a link, they click on their phone. The phone has
   * its own auto-assigned user id. Calling `alias(authoritativeId)` on
   * the phone after auth resolves tells the server the two devices
   * belong to the same human, so dashboards stitch the journey.
   *
   * Idempotent: the server upserts on `(organization, alias_user_id)`,
   * so calling `alias()` twice with the same id produces one mapping,
   * not two. No-op when `authoritativeId` is empty / non-string or
   * already equals the current user id.
   *
   * @param {string} authoritativeId
   */
  alias(authoritativeId) {
    if (typeof authoritativeId !== "string" || authoritativeId.length === 0) return;
    const currentUserId = this.identity.userId;
    if (currentUserId === authoritativeId) return;
    this.record("$alias", {
      properties: {
        authoritative_id: authoritativeId,
        current_user_id: currentUserId,
        current_anonymous_id: this.identity.anonymousId,
      },
    });
  }

  /**
   * Sign-out counterpart to {@link identify}: emit a synthetic `$reset`
   * event marking the close of the identified session, then clear the
   * user id and regenerate the session id. The anonymous id is
   * preserved - the same browser/device remains tracked as an
   * anonymous visitor.
   *
   * Order matters: the `$reset` event is emitted BEFORE the identity
   * reset so the event carries the OLD `session_id` and `user_id` and
   * sorts as the final marker of the logged-in session in the dashboard
   * timeline. Subsequent events use the fresh session id with
   * `user_id: null`.
   *
   * Idempotent: calling `reset()` when there is no identified user is
   * a no-op (no event, no identity change). That keeps a redundant
   * sign-out path in the host app from accidentally breaking sessions.
   */
  reset() {
    const previousUserId = this.identity.userId;
    if (previousUserId === null) return;
    this.record("$reset", {
      properties: { previous_user_id: previousUserId },
    });
    this.identity.reset();
  }

  /** Send any buffered events now. @returns {Promise<boolean>} */
  flush() {
    return this.transport.flush();
  }

  /**
   * Stop all capture for this visitor and persist the choice so reloads
   * honor it. While opted out every interaction (autocapture, pageviews,
   * custom events, identity events) is suppressed at {@link record}. The
   * route a cookie banner's "reject" path should call.
   */
  optOut() {
    this.consent.optOut();
  }

  /**
   * Resume capture after a prior {@link optOut} and persist the choice. The
   * "accept" path's counterpart. Capture stays anonymous-or-identified
   * exactly as it was before the opt-out, since identity is never cleared by
   * consent changes.
   */
  optIn() {
    this.consent.optIn();
  }

  /** @returns {boolean} Whether capture is currently suppressed. */
  hasOptedOut() {
    return this.consent.optedOut();
  }
}
