/**
 * @file Documentation-sync guard. The SDK's public event catalog lives in two
 * places: the README (quick table) and docs/concepts.md (canonical reference).
 * It is easy to add an emitted event in capture.js and forget to document it,
 * which is exactly the drift that shipped undetected before. This test scrapes
 * the event names straight from the capture source so it keeps no list of its
 * own to fall out of date, then asserts every emitted event is documented in
 * both surfaces.
 */

import { describe, expect, test } from "bun:test";

const SRC = await Bun.file(`${import.meta.dir}/../src/capture.js`).text();
const README = await Bun.file(`${import.meta.dir}/../README.md`).text();
const CONCEPTS = await Bun.file(`${import.meta.dir}/../docs/concepts.md`).text();

/** Every `$event` name passed as a string literal to `emit(...)` in capture.js. */
const emitted = [
  ...new Set([...SRC.matchAll(/\bemit\(\s*"(\$[a-z_]+)"/g)].map((m) => m[1])),
].sort();

describe("docs stay in sync with the events capture.js emits", () => {
  test("the scraper actually found the capture event surface", () => {
    // Guards against a future regex/refactor silently matching nothing, which
    // would turn every assertion below into a vacuous pass.
    expect(emitted.length).toBeGreaterThanOrEqual(10);
    expect(emitted).toContain("$autocapture");
    expect(emitted).toContain("$page_leave");
  });

  for (const evt of emitted) {
    test(`${evt} is documented in docs/concepts.md`, () => {
      expect(CONCEPTS).toContain(evt);
    });
    test(`${evt} is listed in the README event catalog`, () => {
      expect(README).toContain(evt);
    });
  }
});
