/**
 * @file Element fingerprinting for the web - turns a DOM element into a
 * semantic-weighted {@link import("./types.js").Fingerprint} the server can
 * later name and self-heal against.
 *
 * Masking-at-source. The SDK captures interactions, never input values:
 *
 * - Form fields (`input`, `textarea`, `select`) and `[contenteditable]`
 *   regions are treated as **sensitive**. We never read their value or text
 *   content. A click whose target IS a sensitive element gets a redacted
 *   fingerprint (tag / role / selector only, no text).
 * - When fingerprinting a non-sensitive container, the visible-text extractor
 *   walks children and skips any sensitive subtree so a container's
 *   `innerText` cannot leak a child input's value.
 * - App authors can mark arbitrary regions sensitive with `[data-revu-mask]`
 *   (e.g. PII summary cards, masked balances). Honored everywhere a sensitive
 *   element would be.
 */

import { truncate } from "./utils.js";

/**
 * Build a fingerprint from a clicked element.
 * Sensitive targets get a redacted fingerprint (no text); see {@link isSensitive}.
 * @param {Element} el
 * @returns {import("./types.js").Fingerprint}
 */
export function fingerprint(el) {
  const tag = el.tagName.toLowerCase();
  const sensitive = isSensitive(el);
  return {
    tag,
    text: sensitive ? undefined : truncate(safeTextOf(el), 120),
    role: el.getAttribute("role") || undefined,
    id: el.id || undefined,
    classes: el.classList.length ? Array.from(el.classList) : undefined,
    selector: selectorOf(el),
    ordinal: ordinalOf(el),
  };
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
  // Ancestor walk for the opt-in marker; keeps the per-element check cheap.
  /** @type {Element|null} */
  let node = el;
  while (node && node.nodeType === 1) {
    if (node.hasAttribute("data-revu-mask")) return true;
    node = node.parentElement;
  }
  return false;
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
    node = node.parentElement;
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
