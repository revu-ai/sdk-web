/**
 * @file RevuClient - the core orchestrator. Wires identity + capture + transport
 * together, builds the full {@link import("./types.js").RevuEvent} for each
 * interaction, and exposes the public surface (capture / identify / flush).
 */

import { Capture } from "./capture.js";
import { Identity } from "./identity.js";
import { Transport } from "./transport.js";
import { nowIso, routePath, uuid } from "./utils.js";

export class RevuClient {
  /** @param {import("./types.js").ResolvedConfig} config */
  constructor(config) {
    this.config = config;
    this.identity = new Identity({
      autoIdentify: config.autoIdentify,
      persistentStorage: config.persistentStorage,
      cookieDomain: config.cookieDomain,
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
    this.capture = new Capture((type, data) => this.record(type, data), {
      maskAllInputs: config.maskAllInputs,
    });
    /** @type {number} */
    this.sequence = 0;
  }

  /** Start transport + autocapture (if enabled). */
  start() {
    this.transport.start();
    if (this.config.autocapture) this.capture.start();
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
      properties: data.properties || {},
      device_time: nowIso(),
    };
    this.transport.enqueue(event);
  }

  /**
   * Capture a custom (explicit) event.
   * @param {string} eventType
   * @param {Record<string, unknown>} [properties]
   */
  track(eventType, properties) {
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
