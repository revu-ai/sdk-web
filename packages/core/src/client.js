/**
 * @file RevuClient - the core orchestrator. Wires identity + capture + transport
 * together, builds the full {@link import("./types.js").RevuEvent} for each
 * interaction, and exposes the public surface (capture / identify / flush).
 */

import { Attention } from "./attention.js";
import { Capture } from "./capture.js";
import { Context } from "./context.js";
import { Identity } from "./identity.js";
import { Transport } from "./transport.js";
import { Vitals } from "./vitals.js";
import { nowIso, routePath, uuid } from "./utils.js";

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
    this.context = new Context();
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
    this.attention = new Attention(emit, {
      idleTimeoutMs: config.idleTimeoutMs,
      captureAttention: config.captureAttention,
    });
    // Renamed from `this.capture` to free the verb for the public
     // `capture(eventName, properties)` method below. The field still
     // refers to the auto-capture engine specifically, so `autocapture`
     // reads more accurately too.
    this.autocapture = new Capture(
      emit,
      { maskAllInputs: config.maskAllInputs },
      this.attention,
    );
    this.vitals = new Vitals(emit);
    /** @type {number} */
    this.sequence = 0;
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
   * @param {import("./types.js").RevuPlugin} plugin
   */
  _installPlugin(plugin) {
    this._installed.add(plugin.name);
    plugin.install({
      record: (type, data) => this.record(type, data),
      identity: this.identity,
      context: this.context,
      config: this.config,
    });
  }

  /**
   * Build a full event from a captured interaction and enqueue it.
   * @param {string} eventType
   * @param {{ fingerprint?: import("./types.js").Fingerprint, properties?: Record<string, unknown> }} [data]
   */
  record(eventType, data = {}) {
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
      properties: { ...this.context.build(), ...(data.properties || {}) },
      device_time: nowIso(),
    };
    this.transport.enqueue(event);
    // Keep the persisted session.last_seen current so a reload inside the
    // continuation window picks the same session_id back up. The identity
    // layer throttles persistence so this is cheap on chatty pages.
    this.identity.touchSession();
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
   * @param {string} eventType
   * @param {Record<string, unknown>} [properties]
   */
  capture(eventType, properties) {
    this.record(eventType, { properties });
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
}
