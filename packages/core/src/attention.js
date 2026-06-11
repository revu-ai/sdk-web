/**
 * @file Attention - is the user actually paying attention to this page?
 *
 * Owns the engagement clock and emits four lifecycle events that complete
 * the picture the basic $page_leave / engagement_time_ms can not draw on
 * its own:
 *
 *   $tab_hidden  - visibilitychange to hidden  (carries visible_ms since last visible)
 *   $tab_visible - visibilitychange to visible (carries hidden_ms since last hidden)
 *   $idle        - no mouse / keyboard / scroll / touch for idleTimeoutMs (default 30s)
 *   $active      - first activity after an idle period (carries idle_ms)
 *
 * Engagement and idle are two ORTHOGONAL signals:
 *
 *   - Engagement clock: counts time the tab is visible. Pauses on
 *     visibilitychange to hidden, resumes on visible. Powers
 *     `$page_leave.engagement_time_ms`. Engagement is visible time, period.
 *   - Idle detection: tracks whether the user has interacted recently.
 *     Emits $idle / $active as behavioral signals; does NOT subtract from
 *     engagement. A page where the user reads silently for two minutes
 *     before scrolling still has two minutes of engagement.
 *
 * Configuration:
 *   captureAttention: true   emit the four lifecycle events (default)
 *   idleTimeoutMs: 30000     ms of inactivity before $idle fires; set to 0
 *                            to disable idle detection entirely
 *
 * Engagement and visibility tracking always run because $page_leave depends
 * on the engagement clock; only the event emission and the idle detector
 * are gated by config.
 */

const ACTIVITY_EVENTS = /** @type {const} */ ([
  "mousemove",
  "keydown",
  "click",
  "scroll",
  "touchstart",
]);

/**
 * @callback EmitFn
 * @param {string} eventType
 * @param {{ properties?: Record<string, unknown> }} [data]
 */

export class Attention {
  /**
   * @param {EmitFn} emit
   * @param {object} [options]
   * @param {number} [options.idleTimeoutMs=30000]
   * @param {boolean} [options.captureAttention=true]
   */
  constructor(emit, options = {}) {
    this.emit = emit;
    this.idleTimeoutMs = typeof options.idleTimeoutMs === "number"
      ? options.idleTimeoutMs
      : 30000;
    this.captureAttention = options.captureAttention !== false;
    // Field declarations live here (not inside _initState) so TS's
    // class-field flow analysis sees a definite assignment through the
    // constructor. _initState() resets back to these baselines.
    /** @type {number|null} When the current visible span began (null while hidden). */
    this._visibleSince = null;
    /** @type {number} Total visible (engagement) ms accumulated on the current page. */
    this._accumulated = 0;
    /** @type {number|null} When the current hidden span began (null while visible). */
    this._hiddenSince = null;
    /** @type {number|null} When the current active period began. Reset on $active and on tab-visible. */
    this._activeSince = null;
    /** @type {number|null} When the current idle period began (null while active). */
    this._idleSince = null;
    /** @type {number|null} Timestamp of the most recent activity event. */
    this._lastActivity = null;
    /** @type {boolean} True when $idle has fired and we are waiting for activity to resume. */
    this._idle = false;
    /** @type {ReturnType<typeof setTimeout>|null} */
    this._idleTimer = null;
  }

  /** Reset every state field to "untracked". */
  _initState() {
    this._visibleSince = null;
    this._accumulated = 0;
    this._hiddenSince = null;
    this._activeSince = null;
    this._idleSince = null;
    this._lastActivity = null;
    this._idle = false;
    this._idleTimer = null;
  }

  /** Begin tracking. Safe to call once at SDK start. */
  start() {
    if (typeof document === "undefined") return;
    this._seedFromCurrentVisibility();
    document.addEventListener("visibilitychange", () => this.onVisibilityChange());
    if (this.idleTimeoutMs > 0) {
      const handler = () => this.onActivity();
      for (const type of ACTIVITY_EVENTS) {
        document.addEventListener(type, handler, { passive: true, capture: true });
      }
    }
  }

  /**
   * Engagement time accumulated on the current page so far (ms). Live read:
   * if the tab is currently visible, the open visible span is included up
   * to "now".
   * @returns {number}
   */
  engagementTimeMs() {
    let total = this._accumulated;
    if (this._visibleSince != null) total += Date.now() - this._visibleSince;
    return total;
  }

  /**
   * Bank the current page's engagement total, return it, then start fresh
   * for the next page. Called by capture on SPA route change and on
   * terminal pagehide.
   * @returns {number}
   */
  flushAndReset() {
    const ms = this.engagementTimeMs();
    this._clearIdleTimer();
    this._initState();
    this._seedFromCurrentVisibility();
    return ms;
  }

  /**
   * Initialize per-page timers from the current visibility state. On page
   * start (and after flushAndReset) the user is assumed active; the idle
   * timer is armed so 30 s of no activity does push the state to idle.
   */
  _seedFromCurrentVisibility() {
    if (typeof document === "undefined") return;
    const now = Date.now();
    if (document.visibilityState === "visible") {
      this._visibleSince = now;
      this._activeSince = now;
      this._lastActivity = now;
      this._armIdleTimer();
    } else {
      this._hiddenSince = now;
    }
  }

  onVisibilityChange() {
    if (typeof document === "undefined") return;
    const visible = document.visibilityState === "visible";
    const now = Date.now();
    if (visible) {
      const hiddenMs = this._hiddenSince != null ? now - this._hiddenSince : 0;
      this._hiddenSince = null;
      this._visibleSince = now;
      // Returning from a hidden tab counts as activity: the user took the
      // action of switching back. If we were marked idle from before the
      // hide, transition out of idle so the next $idle reflects the new
      // active period rather than the old one.
      if (this._idle) {
        const idleMs = this._idleSince != null ? now - this._idleSince : 0;
        this._idle = false;
        this._idleSince = null;
        if (this.captureAttention) {
          this.emit("$active", { properties: { idle_ms: idleMs } });
        }
      }
      this._activeSince = now;
      this._lastActivity = now;
      this._armIdleTimer();
      if (this.captureAttention) {
        this.emit("$tab_visible", { properties: { hidden_ms: hiddenMs } });
      }
    } else {
      const visibleMs = this._visibleSince != null ? now - this._visibleSince : 0;
      if (this._visibleSince != null) {
        this._accumulated += now - this._visibleSince;
        this._visibleSince = null;
      }
      this._hiddenSince = now;
      // The idle timer is meaningless while hidden - a backgrounded tab
      // not getting input events is the expected state, not a signal worth
      // emitting on top of the $tab_hidden we just sent.
      this._clearIdleTimer();
      if (this.captureAttention) {
        this.emit("$tab_hidden", { properties: { visible_ms: visibleMs } });
      }
    }
  }

  onActivity() {
    const now = Date.now();
    if (this._idle) {
      const idleMs = this._idleSince != null ? now - this._idleSince : 0;
      this._idle = false;
      this._idleSince = null;
      this._activeSince = now;
      if (this.captureAttention) {
        this.emit("$active", { properties: { idle_ms: idleMs } });
      }
    }
    this._lastActivity = now;
    this._armIdleTimer();
  }

  _armIdleTimer() {
    this._clearIdleTimer();
    if (this.idleTimeoutMs <= 0) return;
    this._idleTimer = setTimeout(() => this._fireIdle(), this.idleTimeoutMs);
  }

  _clearIdleTimer() {
    if (this._idleTimer != null) {
      clearTimeout(this._idleTimer);
      this._idleTimer = null;
    }
  }

  /**
   * Idle timer fired: no activity in idleTimeoutMs. Mark idle and emit
   * $idle with the duration of the active span that just ended. A hidden
   * tab does not fire idle: it is already in "not engaged" territory via
   * visibility, and $idle on top would be redundant.
   */
  _fireIdle() {
    this._idleTimer = null;
    if (this._idle) return;
    if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
    const now = Date.now();
    const activeMs = this._activeSince != null ? now - this._activeSince : 0;
    this._idle = true;
    this._idleSince = now;
    this._activeSince = null;
    if (this.captureAttention) {
      this.emit("$idle", { properties: { active_ms: activeMs } });
    }
  }
}
