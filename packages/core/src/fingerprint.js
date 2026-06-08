/**
 * @file Element fingerprinting for the web - turns a DOM element into a
 * semantic-weighted {@link import("./types.js").Fingerprint} the server can
 * later name and self-heal against. See corpus Canonical-Behavior-Schemas §2.
 */

import { truncate } from "./utils.js";

/**
 * Build a fingerprint from a clicked element.
 * @param {Element} el
 * @returns {import("./types.js").Fingerprint}
 */
export function fingerprint(el) {
  return {
    tag: el.tagName.toLowerCase(),
    text: truncate(textOf(el), 120),
    role: el.getAttribute("role") || undefined,
    id: el.id || undefined,
    classes: el.classList.length ? Array.from(el.classList) : undefined,
    selector: selectorOf(el),
    ordinal: ordinalOf(el),
  };
}

/**
 * Visible text of an element (short, trimmed). Buttons/links carry their label here.
 * @param {Element} el
 * @returns {string|undefined}
 */
function textOf(el) {
  const t = /** @type {HTMLElement} */ (el).innerText || el.textContent || "";
  const trimmed = t.replace(/\s+/g, " ").trim();
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
