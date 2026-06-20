#!/usr/bin/env bun
/**
 * @file Build the @revu-ai/core package with Bun's native bundler.
 *
 * Produces two outputs from one source tree:
 *
 *   dist/index.js              ESM, for npm consumers (bundlers tree-shake
 *                              against the package's `"sideEffects": false`).
 *   dist/iife/index.js         IIFE, for the cdn.revu.ai <script> snippet.
 *                              Staged in its own directory so the CDN
 *                              publish flow (`publish-asset behavior <ver>
 *                              .../dist/iife`) picks up only the IIFE
 *                              bytes plus their sourcemap, with no ESM
 *                              file leaking into the published payload.
 *                              The file is named `index.js` so the CDN's
 *                              shortest URL forms (`cdn.revu.ai/behavior`,
 *                              `cdn.revu.ai/behavior/latest`) resolve to
 *                              the IIFE bundle by default.
 *
 * Each output ships with a linked `.map` sourcemap (a `//# sourceMappingURL=`
 * comment on the bundle plus a sibling `.map` file). Pre-compression
 * (`.gz`, `.br`) is the CDN's responsibility at publish time, not the
 * SDK build's; the publish script writes both variants on copy.
 *
 * ES target is `browser`, Bun's default for the web (modern evergreen).
 * No transpilation pass: our source is hand-written modern ESM and
 * targeting older syntax would inflate the bundle for marginal coverage
 * gain and blow the size gate.
 *
 * @module scripts/build
 */

import { rm } from "node:fs/promises";

await rm("dist", { recursive: true, force: true });

/**
 * Options shared by every output. Kept here so a future fourth flag is a
 * one-line change instead of two.
 */
const common = {
  target: /** @type {const} */ ("browser"),
  minify: true,
  sourcemap: /** @type {const} */ ("linked"),
};

/**
 * Run a single Bun.build() and exit non-zero with a useful log if it
 * fails. Bun.build resolves on every outcome (including errors) and
 * surfaces issues through `result.success` plus `result.logs`, so the
 * caller has to opt into the failure path explicitly.
 *
 * @param {string} label
 * @param {Parameters<typeof Bun.build>[0]} config
 */
async function buildOne(label, config) {
  const result = await Bun.build(config);
  if (!result.success) {
    console.error(`build: ${label} failed`);
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
  const out = result.outputs[0];
  console.log(`build: ${label} -> ${out.path} (${out.size} bytes)`);
}

await buildOne("esm", {
  entrypoints: ["src/index.js"],
  outdir: "dist",
  format: "esm",
  ...common,
});

await buildOne("iife", {
  entrypoints: ["src/iife.js"],
  outdir: "dist/iife",
  // The entry is `src/iife.js` so the source file name signals what the
  // bundle is. The OUTPUT file must be `index.js` because the CDN serves
  // the bare-product (`cdn.revu.ai/behavior`) and `latest` URL forms by
  // resolving to `index.js`. Bun defaults to the entry basename, so we
  // override naming to land at `dist/iife/index.js`.
  naming: "index.[ext]",
  format: "iife",
  ...common,
});
