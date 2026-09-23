/**
 * @file Unit tests for the link classifier. These exist because the rules are
 * now reachable without a synthetic click: an element in, a verdict out.
 */

import { describe, expect, test } from "bun:test";
import { classifyLink } from "../src/capture/link-classifier.js";

/** Build a detached anchor and return the element a user would have clicked. */
function anchor(href, attrs = {}, innerHTML = "") {
  const a = document.createElement("a");
  a.setAttribute("href", href);
  for (const [k, v] of Object.entries(attrs)) a.setAttribute(k, String(v));
  a.innerHTML = innerHTML;
  document.body.appendChild(a);
  return a;
}

describe("classifyLink", () => {
  test("returns null when the click resolved to no anchor", () => {
    const div = document.createElement("div");
    document.body.appendChild(div);
    expect(classifyLink(div)).toBeNull();
  });

  test("classifies a known file extension as a download", () => {
    const hit = classifyLink(anchor("/files/report.pdf"));
    expect(hit?.eventType).toBe("$file_download");
    expect(hit?.properties.filename).toBe("report.pdf");
    expect(hit?.properties.extension).toBe("pdf");
  });

  test("honors the download attribute over the extension", () => {
    const hit = classifyLink(anchor("/generate", { download: "invoice.csv" }));
    expect(hit?.eventType).toBe("$file_download");
    expect(hit?.properties.filename).toBe("invoice.csv");
  });

  test("tolerates a query string after the extension", () => {
    const hit = classifyLink(anchor("/files/report.pdf?token=abc"));
    expect(hit?.eventType).toBe("$file_download");
  });

  test("classifies a cross-host link as outbound", () => {
    const hit = classifyLink(anchor("https://example.org/pricing"));
    expect(hit?.eventType).toBe("$outbound_link");
    expect(hit?.properties.target_host).toBe("example.org");
  });

  test("leaves a same-host link unclassified", () => {
    expect(classifyLink(anchor(`${location.origin}/pricing`))).toBeNull();
  });

  test("leaves pseudo-protocols unclassified", () => {
    for (const href of ["mailto:a@b.com", "tel:+123", "javascript:void(0)"]) {
      expect(classifyLink(anchor(href))).toBeNull();
    }
  });

  test("walks up from the element actually clicked inside the anchor", () => {
    const a = anchor("https://example.org/x", {}, "<span><b>go</b></span>");
    const inner = a.querySelector("b");
    expect(classifyLink(/** @type {Element} */ (inner))?.eventType).toBe("$outbound_link");
  });

  test("scrubs credentials out of the reported url", () => {
    const hit = classifyLink(anchor("https://example.org/x?token=secret123&a=1"));
    expect(JSON.stringify(hit?.properties.url)).not.toContain("secret123");
  });

  test("never throws on a malformed href", () => {
    expect(() => classifyLink(anchor("ht!tp://%%%"))).not.toThrow();
  });
});
