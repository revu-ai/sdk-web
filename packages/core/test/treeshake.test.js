/**
 * @file Downstream-consumer tree-shake test.
 *
 * The size-limit check (`bun run size`) protects the SHIPPED bundle. This
 * test protects the bundle a real host application's bundler produces when
 * it imports the SDK and tree-shakes what it does not use. Catches two
 * failure modes:
 *
 *   1. A new module sneaks in a top-level side effect that defeats
 *      `sideEffects: false`, so consumer bundlers can no longer drop
 *      unused code.
 *   2. (Future) A subpath plugin like `@revu-ai/core/exceptions` gets
 *      transitively pulled in by the core entry through an inadvertent
 *      cross-import, so a consumer that never registered the plugin still
 *      pays its bytes.
 *
 * We bundle a minimal consumer through Bun.build (the same bundler the
 * shipped artifact uses) with minify + tree-shake enabled, then assert the
 * output stays inside a generous envelope. The threshold here is a
 * regression alarm, not a hard budget - the hard budget is the size-limit
 * check on dist/index.js.
 */

import { describe, expect, test } from "bun:test";
import path from "node:path";

const FIXTURE_DIR = path.join(import.meta.dir, "fixtures");

/** Bundle a consumer fixture the way a downstream bundler would. */
async function bundleConsumer(/** @type {string} */ entrypoint) {
  const result = await Bun.build({
    entrypoints: [path.join(FIXTURE_DIR, entrypoint)],
    target: "browser",
    format: "esm",
    minify: true,
  });
  if (!result.success) {
    const messages = result.logs.map((l) => l.message || String(l)).join("\n");
    throw new Error(`bundle failed: ${messages}`);
  }
  const code = await result.outputs[0].text();
  return { code, byteSize: new TextEncoder().encode(code).length };
}

describe("downstream tree-shake", () => {
  test("a minimal consumer (init + identify + track + reset) bundles within envelope", async () => {
    const { byteSize } = await bundleConsumer("consumer-minimal.js");
    // Generous ceiling: the shipped artifact is ~3 kB gzip, ~15 kB raw.
    // A minified-but-uncompressed consumer bundle of this fixture should
    // land well below 25 kB; if it climbs above, something has pulled in
    // unexpected dependencies and warrants investigation.
    expect(byteSize).toBeLessThan(25_000);
  });

  test("the minimal consumer bundle contains the public surface (sanity check)", async () => {
    const { code } = await bundleConsumer("consumer-minimal.js");
    // After minification identifiers are shortened, but stringified event
    // type literals survive. Confirm a few characteristic strings the
    // bundle should carry as evidence the consumer's code paths reached
    // the SDK and were not themselves stripped by tree-shaking.
    expect(code).toContain("$identify");
    expect(code).toContain("$reset");
    expect(code).toContain("test_event");
  });
});
