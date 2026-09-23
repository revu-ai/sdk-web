/**
 * @file Link taxonomy: deciding what a click on an anchor actually was.
 *
 * Split out of the capture layer because it answers a different kind of
 * question. Everything else in `capture.js` is DOM plumbing - which element
 * was really clicked, is it masked, is it blocked by a selector - whereas this
 * is a classification with rules of its own: what counts as a download, what
 * counts as leaving the site, and which pseudo-protocols are neither.
 *
 * It returns a descriptor instead of emitting, so the rules can be tested
 * directly against an element rather than through a synthetic click and an
 * emit spy, and so the capture layer keeps a single place where events are
 * emitted.
 */

import { routePath, scrubUrl } from "../utils.js";

/**
 * Pathname extensions classified as file downloads. Allowlist over a
 * denylist: HTML / JS / CSS / SVG and other "navigation" extensions stay
 * routed as normal clicks. The `download` attribute always takes precedence.
 */
const DOWNLOAD_EXTENSIONS = /\.(pdf|csv|tsv|xlsx?|docx?|pptx?|zip|tar|gz|7z|rar|json|xml|txt|mp[34]|mov|avi|webm|webp|psd|ai|sketch|fig|exe|dmg|pkg|deb|apk|ipa|dll|iso)(\?.*)?$/i;

/**
 * @typedef {object} LinkClassification
 * @property {"$file_download"|"$outbound_link"} eventType  Event to emit.
 * @property {Record<string, unknown>} properties           Its payload.
 */

/**
 * Classify a click target as a file download or an outbound link.
 *
 * The element is walked up to the nearest `a[href]`, so a click on the text or
 * icon inside an anchor still counts. Returns `null` for anything that is
 * neither: a same-host link, a pseudo-protocol (`mailto:`, `tel:`,
 * `javascript:`, which have no hostname), a malformed href, or a click that
 * resolved to no anchor at all.
 *
 * @param {Element} el  The element the user actually clicked.
 * @returns {LinkClassification|null}
 */
export function classifyLink(el) {
  const link = /** @type {HTMLAnchorElement|null} */ (
    el.closest && el.closest("a[href]")
  );
  if (!link) return null;

  /** @type {URL} */
  let url;
  try {
    url = new URL(link.href, typeof location !== "undefined" ? location.href : undefined);
  } catch {
    return null;
  }

  if (link.hasAttribute("download") || DOWNLOAD_EXTENSIONS.test(url.pathname)) {
    const filename = link.getAttribute("download") || url.pathname.split("/").pop() || "";
    const extMatch = url.pathname.match(/\.([a-z0-9]{2,5})(?:\?.*)?$/i);
    return {
      eventType: "$file_download",
      properties: {
        url: scrubUrl(url.href),
        filename: filename || undefined,
        extension: extMatch && extMatch[1] ? extMatch[1].toLowerCase() : undefined,
        path: routePath(),
      },
    };
  }

  // Outbound: a real cross-origin navigation. A pseudo-protocol has an empty
  // hostname and is neither a download nor a departure.
  if (url.hostname && typeof location !== "undefined" && url.hostname !== location.hostname) {
    return {
      eventType: "$outbound_link",
      properties: {
        url: scrubUrl(url.href),
        target_host: url.hostname,
        path: routePath(),
      },
    };
  }

  return null;
}
