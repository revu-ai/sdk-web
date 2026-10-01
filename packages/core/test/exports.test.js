/**
 * @file Packaging test: every target in the `exports` map exists.
 *
 * A subpath that points at a file the build does not emit installs fine and
 * fails only when a consumer resolves it. Skips when `dist` is missing; CI
 * builds first, so it always runs there.
 */

import { describe, expect, test } from "bun:test";
import pkg from "../package.json";

const root = new URL("../", import.meta.url);
const built = await Bun.file(new URL("dist/index.js", root)).exists();

/** @param {unknown} target @returns {string[]} */
const paths = (target) =>
  typeof target === "string" ? [target] : Object.values(target ?? {}).flatMap(paths);

describe.skipIf(!built)("package exports", () => {
  for (const [subpath, target] of Object.entries(pkg.exports)) {
    test(`${subpath} resolves to built files`, async () => {
      for (const path of paths(target)) {
        expect(await Bun.file(new URL(path, root)).exists()).toBe(true);
      }
    });
  }

  test("./iife is the <script> build", () => {
    expect(pkg.exports["./iife"]).toBe(pkg.unpkg);
  });
});
