/**
 * @file Autocapture - the zero-instrumentation interactions layer. Pageviews,
 * clicks, right-clicks, scroll depth, form submits, file downloads, outbound
 * link clicks, page leave with engagement time, rage clicks, and debounced
 * viewport resizes all flow through the same `emit` hook.
 *
 * Hard rule: we capture interactions, never input values. Form-submit events
 * carry the form's structure (field names, types) but never the entered
 * values; click fingerprints already redact text when the target is sensitive
 * (input / textarea / select / contenteditable / [data-revu-mask]).
 *
 * The capture layer only detects; the client wraps each emit with the
 * envelope (identity, session, environment context, etc.) and hands the
 * full event off to the transport.
 */

import { fingerprint } from "./fingerprint.js";
import { routePath } from "./utils.js";

// ---------------------------------------------------------------------------
// Tuning constants. Conservative defaults; not exposed in config yet because
// the values are interaction-quality choices more than performance dials.
// ---------------------------------------------------------------------------
/** Depth percentages we fire scroll milestones at. */
const SCROLL_MILESTONES = [25, 50, 75, 100];
/** Min time between two scroll handler bodies (the listener is `passive`). */
const SCROLL_THROTTLE_MS = 250;
/** A burst of N clicks on the same element in this window emits $rageclick. */
const RAGE_CLICK_THRESHOLD = 3;
const RAGE_CLICK_WINDOW_MS = 1000;
/** How long after a resize stops we emit one $resize with the final size. */
const RESIZE_DEBOUNCE_MS = 500;
/**
 * Pathname extensions classified as file downloads. Allowlist over a
 * denylist: HTML / JS / CSS / SVG and other "navigation" extensions stay
 * routed as normal clicks. The `download` attribute always takes precedence.
 */
const DOWNLOAD_EXTENSIONS = /\.(pdf|csv|tsv|xlsx?|docx?|pptx?|zip|tar|gz|7z|rar|json|xml|txt|mp[34]|mov|avi|webm|webp|psd|ai|sketch|fig|exe|dmg|pkg|deb|apk|ipa|dll|iso)(\?.*)?$/i;

/**
 * @callback EmitFn
 * @param {string} eventType
 * @param {{ fingerprint?: import("./types.js").Fingerprint, properties?: Record<string, unknown> }} [data]
 */

export class Capture {
  /**
   * @param {EmitFn} emit
   * @param {import("./attention.js").Attention} attention  Engagement clock
   *   plus tab visibility / idle tracking. Owns engagement_time_ms; capture
   *   delegates rather than running a second clock.
   */
  constructor(emit, attention) {
    this.emit = emit;
    this.attention = attention;
    /** @type {string|undefined} */
    this.lastPath = undefined;
    /** @type {Set<number>} Scroll milestones already fired on the current page. */
    this._scrollFired = new Set();
    /** @type {Array<{ key: string, t: number }>} Sliding window of recent clicks. */
    this._recentClicks = [];
    /** @type {{ w: number, h: number }|null} */
    this._lastViewport = null;
    /** @type {ReturnType<typeof setTimeout>|null} */
    this._resizeTimer = null;
    /** @type {boolean} Scroll handler throttle gate. */
    this._scrollThrottled = false;
    /** @type {boolean|undefined} pagehide.persisted, ferried into the next $page_leave. */
    this._pendingPersisted = undefined;
    /** @type {boolean} True when $page_leave has been emitted for the current path. */
    this._pageLeaveEmitted = false;
  }

  /** Wire up listeners and emit the initial page view. */
  start() {
    this.capturePageview();
    this.installSpaNavigation();
    if (typeof document === "undefined") return;

    // Capture-phase listeners so we observe interactions even when the
    // host stops propagation at a lower handler. `passive` on scroll so
    // we never block the browser's scroll thread.
    document.addEventListener("click", (e) => this.onClick(e), { capture: true });
    document.addEventListener("contextmenu", (e) => this.onContextMenu(e), { capture: true });
    document.addEventListener("submit", (e) => this.onSubmit(e), { capture: true });

    if (typeof window !== "undefined") {
      window.addEventListener("scroll", () => this.onScroll(), { passive: true });
      window.addEventListener("resize", () => this.onResize());
      // Terminal signal for $page_leave. We listen on BOTH `pagehide` and
      // `visibilitychange -> hidden` and dedupe, because:
      //   - On desktop, `pagehide` fires reliably on tab close / navigation.
      //   - On mobile (especially iOS Safari), `pagehide` is often skipped
      //     when the user backgrounds the app or closes the tab; the only
      //     reliable terminal signal there is `visibilitychange` to hidden.
      // `beforeunload` is intentionally not used (blocked on iOS Safari,
      // unreliable on mobile generally). The `_pageLeaveEmitted` flag is
      // reset on `visibilitychange -> visible` so a foregrounded page that
      // navigates again later still emits the next $page_leave correctly.
      window.addEventListener("pagehide", (e) => this.onPageHide(e));
      if (typeof document !== "undefined") {
        document.addEventListener("visibilitychange", () => {
          if (document.visibilityState === "hidden") this.onPageHide();
          else if (document.visibilityState === "visible") this._pageLeaveEmitted = false;
        });
      }
      this._lastViewport = {
        w: typeof window.innerWidth === "number" ? window.innerWidth : 0,
        h: typeof window.innerHeight === "number" ? window.innerHeight : 0,
      };
    }
  }

  // -------------------------------------------------------------------------
  // Pageview + SPA navigation
  // -------------------------------------------------------------------------

  /** Emit a `$pageview` for the current location. */
  capturePageview() {
    if (typeof location === "undefined") return;
    const newPath = routePath();

    // Close out the previous page before starting the new one: emit a
    // $page_leave with the engagement time accumulated for the OLD route.
    if (this.lastPath !== undefined && this.lastPath !== newPath) {
      this._emitPageLeave(this.lastPath);
    }

    this.lastPath = newPath;
    this._scrollFired = new Set();
    this._recentClicks = [];
    // Re-arm $page_leave for the new path: an SPA navigation closes out the
    // previous page (handled above) and starts a fresh one, which must be
    // eligible to emit its own $page_leave on the next terminal signal.
    this._pageLeaveEmitted = false;

    this.emit("$pageview", {
      properties: {
        url: location.href,
        path: this.lastPath,
        referrer: typeof document !== "undefined" ? document.referrer || undefined : undefined,
        title: typeof document !== "undefined" ? document.title || undefined : undefined,
      },
    });
  }

  /**
   * Detect SPA route changes by wrapping the History API and listening for
   * `popstate` and `hashchange`. Emits a page view whenever the route changes,
   * where the route is the pathname plus the hash so hash-router apps
   * (`/#/pricing` -> `/#/about`) and anchor navigation (`#section-1` ->
   * `#section-2`) are both observed.
   */
  installSpaNavigation() {
    if (typeof history === "undefined" || typeof addEventListener !== "function") return;
    const fire = () => {
      if (routePath() !== this.lastPath) this.capturePageview();
    };
    for (const method of /** @type {const} */ (["pushState", "replaceState"])) {
      const original = history[method];
      history[method] = function patched(/** @type {any[]} */ ...args) {
        const result = original.apply(this, /** @type {Parameters<typeof original>} */ (args));
        fire();
        return result;
      };
    }
    addEventListener("popstate", fire);
    addEventListener("hashchange", fire);
  }

  // -------------------------------------------------------------------------
  // Clicks (autocapture + rage + outbound / download classification)
  // -------------------------------------------------------------------------

  /**
   * Handle a click anywhere in the document (delegated).
   *
   * Resolves the actual click target via `composedPath()[0]` so a click
   * inside a Shadow DOM custom element is captured against the internal
   * element, not the retargeted shadow host. Falls back to `e.target` on
   * engines without composedPath.
   * @param {MouseEvent} e
   */
  onClick(e) {
    const el = composedElement(e);
    if (!el) return;
    const fp = fingerprint(el);

    this.emit("$autocapture", {
      fingerprint: fp,
      properties: { path: routePath() },
    });

    this._trackForRageClick(fp);
    this._classifyLinkClick(el);
  }

  /**
   * Right-click / context menu interactions. Useful for "save link as", power
   * users opening a tab via middle-click-equivalent, copy menu, etc.
   * @param {MouseEvent} e
   */
  onContextMenu(e) {
    const el = composedElement(e);
    if (!el) return;
    this.emit("$rightclick", {
      fingerprint: fingerprint(el),
      properties: { path: routePath() },
    });
  }

  /**
   * Detect rage clicks: N clicks on the same element-ish in a short window.
   * Match by (tag, selector) instead of by node identity so a re-rendered
   * button (same selector, different DOM node) still counts.
   * @param {import("./types.js").Fingerprint} fp
   */
  _trackForRageClick(fp) {
    const now = Date.now();
    const key = (fp.tag || "") + "|" + (fp.selector || "");
    // Trim the sliding window.
    this._recentClicks = this._recentClicks.filter((c) => now - c.t < RAGE_CLICK_WINDOW_MS);
    this._recentClicks.push({ key, t: now });
    const onSame = this._recentClicks.filter((c) => c.key === key).length;
    // Emit exactly once at the threshold so a 5-click rage doesn't emit
    // three $rageclick events; the dashboard cares about the burst, not
    // the count growing past 3.
    if (onSame === RAGE_CLICK_THRESHOLD) {
      this.emit("$rageclick", {
        fingerprint: fp,
        properties: {
          click_count: onSame,
          window_ms: RAGE_CLICK_WINDOW_MS,
          path: routePath(),
        },
      });
    }
  }

  /**
   * If the clicked element resolves to a real anchor, classify it as a file
   * download (download attribute or known file extension) or an outbound link
   * (hostname differs from the current location). Anchors are walked up the
   * tree so a click on the inner text/icon of an `<a>` still counts.
   * @param {Element} el
   */
  _classifyLinkClick(el) {
    const link = /** @type {HTMLAnchorElement|null} */ (
      el.closest && el.closest("a[href]")
    );
    if (!link) return;
    /** @type {URL} */
    let url;
    try {
      url = new URL(link.href, typeof location !== "undefined" ? location.href : undefined);
    } catch {
      return;
    }

    const isDownload =
      link.hasAttribute("download") || DOWNLOAD_EXTENSIONS.test(url.pathname);
    if (isDownload) {
      const filename =
        link.getAttribute("download") || url.pathname.split("/").pop() || "";
      const extMatch = url.pathname.match(/\.([a-z0-9]{2,5})(?:\?.*)?$/i);
      this.emit("$file_download", {
        properties: {
          url: url.href,
          filename: filename || undefined,
          extension: extMatch && extMatch[1] ? extMatch[1].toLowerCase() : undefined,
          path: routePath(),
        },
      });
      return;
    }

    // Outbound: real cross-origin navigation. Skip same-host links and
    // pseudo-protocols (mailto, tel, javascript:) where hostname is empty.
    if (
      url.hostname &&
      typeof location !== "undefined" &&
      url.hostname !== location.hostname
    ) {
      this.emit("$outbound_link", {
        properties: {
          url: url.href,
          target_host: url.hostname,
          path: routePath(),
        },
      });
    }
  }

  // -------------------------------------------------------------------------
  // Form submission
  // -------------------------------------------------------------------------

  /**
   * Capture form structure (field names and types) but NEVER values. Mask-at-
   * source extends here: a form (or any ancestor) marked `data-revu-mask`
   * skips field-name capture entirely so a customer can opt sensitive forms
   * out of all structural reporting.
   * @param {Event} e
   */
  onSubmit(e) {
    const form = /** @type {HTMLFormElement|null} */ (e.target);
    if (!form || form.tagName !== "FORM") return;
    const masked = !!(form.closest && form.closest("[data-revu-mask]"));
    /** @type {Record<string, unknown>} */
    const props = {
      path: routePath(),
      form_id: form.id || undefined,
      form_name: form.getAttribute("name") || undefined,
      action: form.getAttribute("action") || undefined,
      method: (form.getAttribute("method") || "get").toUpperCase(),
    };
    if (!masked) {
      const names = [];
      const types = [];
      const elements = form.elements;
      for (let i = 0; i < elements.length; i++) {
        const el = /** @type {HTMLInputElement} */ (elements[i]);
        if (!el || !el.name) continue;
        names.push(el.name);
        types.push(el.type || (el.tagName ? el.tagName.toLowerCase() : ""));
      }
      props.field_names = names;
      props.field_types = types;
      props.field_count = names.length;
    }
    this.emit("$form_submit", { properties: props });
  }

  // -------------------------------------------------------------------------
  // Scroll depth (25 / 50 / 75 / 100% milestones, one per milestone per page)
  // -------------------------------------------------------------------------

  onScroll() {
    if (this._scrollThrottled) return;
    this._scrollThrottled = true;
    setTimeout(() => {
      this._scrollThrottled = false;
    }, SCROLL_THROTTLE_MS);

    const depth = computeScrollDepthPercent();
    if (depth == null) return;
    for (const milestone of SCROLL_MILESTONES) {
      if (depth >= milestone && !this._scrollFired.has(milestone)) {
        this._scrollFired.add(milestone);
        this.emit("$scroll", {
          properties: { depth_percent: milestone, path: routePath() },
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Viewport resize (debounced so we emit once per "resize gesture")
  // -------------------------------------------------------------------------

  onResize() {
    if (typeof window === "undefined") return;
    if (this._resizeTimer != null) clearTimeout(this._resizeTimer);
    this._resizeTimer = setTimeout(() => {
      this._resizeTimer = null;
      const w = typeof window.innerWidth === "number" ? window.innerWidth : 0;
      const h = typeof window.innerHeight === "number" ? window.innerHeight : 0;
      const from = this._lastViewport;
      if (!from || (from.w === w && from.h === h)) return;
      this.emit("$resize", {
        properties: {
          from_width: from.w,
          from_height: from.h,
          to_width: w,
          to_height: h,
          path: routePath(),
        },
      });
      this._lastViewport = { w, h };
    }, RESIZE_DEBOUNCE_MS);
  }

  // -------------------------------------------------------------------------
  // Page leave (engagement time comes from the attention layer)
  // -------------------------------------------------------------------------

  /**
   * Terminal signal for the current page. Emits `$page_leave` so the
   * dashboard records engagement time even when the user closes the tab
   * or backgrounds the mobile browser.
   *
   * Wired to two browser events for cross-platform reliability: `pagehide`
   * (desktop, navigation, bfcache) and `visibilitychange -> hidden` (the
   * only reliable terminal signal on iOS Safari). Idempotent so the two
   * events firing in sequence on the same close do not emit two
   * `$page_leave` events. `_pageLeaveEmitted` is reset on
   * `visibilitychange -> visible` (page returns to foreground) and on SPA
   * navigation, so subsequent terminal events fire correctly.
   *
   * `pagehide.persisted` is forwarded so the dashboard can distinguish a
   * terminal close ("user is gone") from a bfcache-eligible navigation
   * ("user might Back-button to this exact state"). The two have very
   * different product meanings.
   *
   * @param {PageTransitionEvent} [event]
   */
  onPageHide(event) {
    if (this._pageLeaveEmitted) return;
    this._pendingPersisted =
      event && typeof event.persisted === "boolean" ? event.persisted : false;
    this._emitPageLeave(this.lastPath);
    this._pageLeaveEmitted = true;
  }

  /**
   * Emit a $page_leave for the page identified by `path` and bank the
   * engagement time for the next page. Called on SPA route change and on
   * pagehide. Engagement_time_ms is the attention layer's accumulated
   * visible-and-active time, paused for both tab-hidden and idle.
   * @param {string|undefined} path
   */
  _emitPageLeave(path) {
    if (path === undefined) return;
    /** @type {Record<string, unknown>} */
    const properties = {
      path,
      engagement_time_ms: this.attention.flushAndReset(),
    };
    if (this._pendingPersisted !== undefined) {
      properties.persisted = this._pendingPersisted;
    }
    this._pendingPersisted = undefined;
    this.emit("$page_leave", { properties });
  }
}

/**
 * Resolve the actual element the user interacted with, even when the click
 * originated inside a Shadow DOM tree. Engines retarget `event.target` to
 * the shadow host when an event composes across the boundary, so a click on
 * a button inside `<my-card>` arrives at the document-level listener as
 * `target = <my-card>`. `composedPath()[0]` returns the true element clicked
 * through the boundary. Falls back to `event.target` on engines without
 * composedPath (older browsers, some test runners).
 *
 * @param {Event} e
 * @returns {EventTarget|null}
 */
function composedTarget(e) {
  if (typeof e.composedPath === "function") {
    const path = e.composedPath();
    if (path && path.length > 0 && path[0]) return path[0];
  }
  return e.target;
}

/**
 * Resolve an event to the {@link Element} the user interacted with, or null
 * when the target is not an element node (text node, document, detached).
 * Wraps {@link composedTarget} with the element-node guard shared by every
 * delegated handler (click, contextmenu, change) so the "what counts as an
 * interactable target" rule lives in one place.
 *
 * @param {Event} e
 * @returns {Element|null}
 */
function composedElement(e) {
  const t = composedTarget(e);
  return t && /** @type {Node} */ (t).nodeType === 1 ? /** @type {Element} */ (t) : null;
}

/**
 * Returns the user's current scroll progress through the document as a
 * percentage [0, 100], or null when no useful measurement can be made
 * (no document or zero-height layout). For documents shorter than the
 * viewport the answer is 100 (everything is already visible).
 * @returns {number|null}
 */
function computeScrollDepthPercent() {
  if (typeof document === "undefined" || typeof window === "undefined") return null;
  const doc = document.documentElement;
  const body = document.body;
  if (!doc || !body) return null;
  const scrollTop =
    typeof window.scrollY === "number" ? window.scrollY : doc.scrollTop || 0;
  const viewportHeight =
    typeof window.innerHeight === "number" ? window.innerHeight : doc.clientHeight || 0;
  const scrollHeight = Math.max(doc.scrollHeight || 0, body.scrollHeight || 0);
  if (scrollHeight <= 0) return null;
  if (scrollHeight <= viewportHeight) return 100;
  const pct = ((scrollTop + viewportHeight) / scrollHeight) * 100;
  if (pct < 0) return 0;
  if (pct > 100) return 100;
  return pct;
}
