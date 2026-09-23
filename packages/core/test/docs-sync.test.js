/**
 * @file Documentation-sync guard. The SDK's public event catalog lives in two
 * places: the README (quick table) and docs/concepts.md (canonical reference).
 * It is easy to add an emitted event in the capture layer and forget to
 * document it, which is exactly the drift that shipped undetected before. This
 * test scrapes the event names straight from the capture source so it keeps no
 * list of its own to fall out of date, then asserts every emitted event is
 * documented in both surfaces.
 *
 * It reads `capture.js` AND everything under `src/capture/`, so moving an
 * event out of the main file into a helper cannot quietly shrink what this
 * guards. The count assertion below is the backstop for that.
 */

import { describe, expect, test } from "bun:test";

const CAPTURE_DIR = `${import.meta.dir}/../src/capture`;
const SRC = (
  await Promise.all([
    Bun.file(`${import.meta.dir}/../src/capture.js`).text(),
    ...[...new Bun.Glob("*.js").scanSync(CAPTURE_DIR)].map((f) =>
      Bun.file(`${CAPTURE_DIR}/${f}`).text(),
    ),
  ])
).join("\n");
const README = await Bun.file(`${import.meta.dir}/../README.md`).text();
const CONCEPTS = await Bun.file(`${import.meta.dir}/../docs/concepts.md`).text();

/**
 * Every `$event` name the capture layer names as a string literal, whether it
 * reaches `emit(...)` directly or is returned as an `eventType` for the
 * capture layer to emit.
 */
const emitted = [
  ...new Set([
    ...[...SRC.matchAll(/\bemit\(\s*"(\$[a-z_]+)"/g)].map((m) => m[1]),
    ...[...SRC.matchAll(/\beventType:\s*"(\$[a-z_]+)"/g)].map((m) => m[1]),
  ]),
].sort();

describe("docs stay in sync with the events capture.js emits", () => {
  test("the scraper actually found the capture event surface", () => {
    // Guards against a future regex/refactor silently matching nothing, which
    // would turn every assertion below into a vacuous pass.
    expect(emitted.length).toBeGreaterThanOrEqual(12);
    expect(emitted).toContain("$autocapture");
    expect(emitted).toContain("$page_leave");
    // Emitted from src/capture/, not capture.js: proves the scan reaches the
    // whole capture layer and not just its entry file.
    expect(emitted).toContain("$file_download");
    expect(emitted).toContain("$outbound_link");
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
