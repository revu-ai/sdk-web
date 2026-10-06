/**
 * @file Element fingerprinting for the web - turns a DOM element into a
 * semantic-weighted {@link import("./types.js").Fingerprint} the server can
 * later name and self-heal against.
 *
 * Masking-at-source. The SDK captures interactions, never input values:
 *
 * - Form fields (`input`, `textarea`, `select`) and `[contenteditable]`
 *   regions are treated as **sensitive**. We never read their value or text
 *   content. A click on a sensitive element gets a fingerprint with no
 *   text; its author-written labels (accessible name, `title`) are kept so
 *   the field can be named.
 * - When fingerprinting a non-sensitive container, the visible-text extractor
 *   walks children and skips any sensitive subtree so a container's
 *   `innerText` cannot leak a child input's value.
 * - App authors can mark arbitrary regions sensitive with `[data-revu-mask]`
 *   (e.g. PII summary cards, masked balances). Honored everywhere a sensitive
 *   element would be, and inside such a region the labels are removed too.
 */

import { truncate } from "./utils.js";

/**
 * Walk one level up the DOM, crossing Shadow DOM boundaries by jumping from
 * a ShadowRoot to its host. Without this, every parent walk silently stops
 * at the shadow boundary: a click inside a custom element sees only its
 * shadow tree and loses every ancestor on the light side, including any
 * `data-revu-mask` opt-in on the host.
 *
 * @param {Node|null} node
 * @returns {Element|null}
 */
function parentAcrossShadow(node) {
  if (!node) return null;
  if (/** @type {Element} */ (node).parentElement) {
    return /** @type {Element} */ (node).parentElement;
  }
  const parent = node.parentNode;
  // nodeType 11 is DocumentFragment; ShadowRoot is a DocumentFragment with a
  // `.host` property. Light-DOM DocumentFragments do not have a host.
  if (
    parent &&
    parent.nodeType === 11 &&
    /** @type {ShadowRoot} */ (parent).host
  ) {
    return /** @type {ShadowRoot} */ (parent).host;
  }
  return null;
}

/**
 * What makes an element something a person acts on, by its markup: native
 * controls, ARIA widget roles, anything made focusable on purpose, and
 * inline handlers. A click anywhere inside one of these acts on it, so it is
 * the element the fingerprint describes. Handlers attached in script leave
 * no trace in the markup; {@link interactiveTarget} catches those by the
 * pointer cursor instead.
 */
const INTERACTIVE =
  'a[href],button,input,select,textarea,label,summary,[contenteditable]:not([contenteditable="false"]),' +
  "[role=button],[role=link],[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio],[role=tab]," +
  "[role=checkbox],[role=radio],[role=switch],[role=option],[role=combobox],[role=treeitem],[role=slider]," +
  "[role=spinbutton],[role=searchbox]," +
  '[tabindex]:not([tabindex="-1"]),[onclick]';

/**
 * The nearest element (including `el` itself) a click on `el` acts on, or
 * null when nothing interactive encloses it. Crosses Shadow DOM boundaries.
 *
 * Besides the markup signals in {@link INTERACTIVE}, an element counts when
 * it sets a pointer cursor its parent does not have. That is how a control
 * whose click handler is attached in script (a card or a styled span in a
 * component framework) shows the visitor it can be clicked, and the cursor
 * inherits, so the element that sets it is the control. Costs one computed
 * style read per ancestor walked, only on an interaction.
 * @param {Element} el
 * @returns {Element|null}
 */
export function interactiveTarget(el) {
  /** @type {Element|null} */
  let node = el;
  let pointer = isPointer(el);
  while (node && node.nodeType === 1) {
    if (node.matches(INTERACTIVE)) return node;
    const parent = parentAcrossShadow(node);
    const parentPointer = !!parent && isPointer(parent);
    if (pointer && !parentPointer) return node;
    node = parent;
    pointer = parentPointer;
  }
  return null;
}

/**
 * @param {Element} el
 * @returns {boolean}
 */
function isPointer(el) {
  return window.getComputedStyle(el).cursor === "pointer";
}

/**
 * Build a fingerprint for an interaction on `clicked`.
 *
 * The fingerprint describes the element the interaction acts on, which is
 * the nearest interactive ancestor (see {@link interactiveTarget}): a tap on
 * the icon inside a link is a tap on the link, so it carries the link's text
 * and selector. The node actually hit is kept as `target_part` when it
 * differs. When nothing interactive encloses the node, the fingerprint
 * describes the node itself and `interactive` is false: the tap did nothing
 * the page declared, so it is a sign of confusion rather than feature use.
 *
 * Besides visible text it captures the accessible name (`aria_label`) and
 * `title`, so the server can name controls without visible text: icon-only
 * buttons, and form fields, which never yield text (see {@link nameOf}).
 *
 * Sensitive elements never yield text or value; a `data-revu-mask` region
 * yields no labels either. See {@link isSensitive}.
 * @param {Element} clicked
 * @returns {import("./types.js").Fingerprint}
 */
export function fingerprint(clicked) {
  const target = interactiveTarget(clicked);
  const el = target || clicked;
  /** @type {import("./types.js").Fingerprint} */
  const fp = {
    tag: el.tagName.toLowerCase(),
    text: truncate(safeTextOf(el), 120),
    role: el.getAttribute("role") || undefined,
    id: el.id || undefined,
    classes: el.classList.length ? Array.from(el.classList) : undefined,
    selector: selectorOf(el),
    ordinal: ordinalOf(el),
    interactive: !!target,
  };
  if (el !== clicked) fp.target_part = partOf(clicked);
  if (!closestMask(el)) {
    const name = nameOf(el);
    if (name) fp.aria_label = truncate(name, 120);
    const title = el.getAttribute("title");
    if (title) fp.title = truncate(title, 120);
  }
  return fp;
}

/**
 * The accessible name an element declares, in the order assistive
 * technology reads it: `aria-labelledby`, then `aria-label`, then, for an
 * element that takes a `<label>` (form fields and buttons), its `<label>`,
 * `placeholder` and `name`. Every source is
 * text the page author wrote; a field's value is never read, and a
 * referenced label inside a sensitive subtree yields nothing.
 * @param {Element} el
 * @returns {string|undefined}
 */
function nameOf(el) {
  const ids = el.getAttribute("aria-labelledby");
  if (ids) {
    const root = /** @type {Document|ShadowRoot} */ (el.getRootNode());
    let text = "";
    for (const id of ids.split(" ")) {
      const ref = root.getElementById(id);
      if (ref) text += ` ${safeTextOf(ref) || ""}`;
    }
    if ((text = text.trim())) return text;
  }
  const aria = el.getAttribute("aria-label");
  if (aria) return aria;
  const field = /** @type {HTMLInputElement} */ (el);
  if (!field.labels) return undefined;
  const label = field.labels[0];
  return (
    (label && safeTextOf(label)) ||
    el.getAttribute("placeholder") ||
    el.getAttribute("name") ||
    undefined
  );
}

/**
 * Short description of the node a click actually hit, inside the element
 * the fingerprint describes: its tag and first class (e.g. `svg.spark`).
 * @param {Element} el
 * @returns {string}
 */
function partOf(el) {
  const first = el.classList.length ? `.${el.classList[0]}` : "";
  return el.tagName.toLowerCase() + first;
}

/**
 * Whether an element is considered sensitive and must not have its text or
 * value read. The set is intentionally broad: any form-entry element, any
 * `contenteditable` region, and any element (or ancestor) opted-in via
 * `data-revu-mask`. The check is cheap (no traversal beyond ancestors when
 * looking at the opt-in attribute).
 * @param {Element|null} el
 * @returns {boolean}
 */
export function isSensitive(el) {
  if (!el || el.nodeType !== 1) return false;
  const tag = el.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  const ce = el.getAttribute("contenteditable");
  if (ce !== null && ce !== "false") return true;
  return closestMask(el) !== null;
}

/**
 * The nearest ancestor (including `el` itself) opted into masking via
 * `data-revu-mask`, or null when none. Crosses Shadow DOM boundaries so a
 * `data-revu-mask` on a custom-element host masks its entire shadow tree,
 * matching {@link isSensitive}.
 *
 * This is the single source of truth for mask-at-source: every layer that
 * has to honor the marker (fingerprint redaction here, form-submit and
 * form-control capture in capture.js) shares it so the opt-in behaves
 * identically everywhere, including across shadow boundaries.
 * @param {Element|null} el
 * @returns {Element|null}
 */
export function closestMask(el) {
  /** @type {Element|null} */
  let node = el;
  while (node && node.nodeType === 1) {
    if (node.hasAttribute("data-revu-mask")) return node;
    node = parentAcrossShadow(node);
  }
  return null;
}

/**
 * Visible text of an element, with any sensitive descendant subtrees stripped
 * so a container's text never includes a child input's value or a masked
 * region's contents. Returns undefined when the result is empty or the element
 * itself is sensitive.
 * @param {Element} el
 * @returns {string|undefined}
 */
function safeTextOf(el) {
  if (isSensitive(el)) return undefined;
  let acc = "";
  /** @param {Node} node */
  function walk(node) {
    // Text node: take its content verbatim.
    if (node.nodeType === 3) {
      acc += node.nodeValue || "";
      return;
    }
    if (node.nodeType !== 1) return;
    const elNode = /** @type {Element} */ (node);
    // Skip sensitive subtrees entirely so we never read their visible text.
    if (isSensitive(elNode)) return;
    for (const child of elNode.childNodes) walk(child);
  }
  walk(el);
  const trimmed = acc.replace(/\s+/g, " ").trim();
  return trimmed || undefined;
}

/**
 * Best-effort, reasonably stable CSS selector. Prefers id; falls back to a
 * short tag+class path. Fragile by nature - a tiebreaker, not the identity.
 * @param {Element} el
 * @returns {string}
 */
function selectorOf(el) {
  if (el.id) return `#${el.id}`;
  const parts = [];
  /** @type {Element|null} */
  let node = el;
  let depth = 0;
  while (node && node.nodeType === 1 && depth < 4) {
    let part = node.tagName.toLowerCase();
    if (node.classList.length) part += `.${Array.from(node.classList).slice(0, 2).join(".")}`;
    parts.unshift(part);
    if (node.id) {
      parts[0] = `#${node.id}`;
      break;
    }
    // Cross Shadow DOM boundaries so a button inside a custom element still
    // gets the host in its selector path. Without this the selector
    // truncates at the shadow root and unrelated buttons across components
    // can collide on `button.primary`.
    node = parentAcrossShadow(node);
    depth += 1;
  }
  return parts.join(" > ");
}

/**
 * Index of the element among its same-tag siblings (positional signal).
 * @param {Element} el
 * @returns {number}
 */
function ordinalOf(el) {
  if (!el.parentElement) return 0;
  const siblings = Array.from(el.parentElement.children).filter((s) => s.tagName === el.tagName);
  return siblings.indexOf(el);
}
