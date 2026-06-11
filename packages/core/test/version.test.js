/**
 * @file Version constant invariants.
 *
 * `src/version.js` is auto-generated from `package.json` by
 * `scripts/sync-version.js` (wired as the `prebuild` hook), so the
 * committed file and the manifest carry the same string by construction.
 * The drift test here is a safety net: if someone bumps `package.json`
 * but pushes without running `bun run build` (or `bun run sync-version`),
 * CI fails immediately because `src/version.js` still carries the old
 * literal. Bun reads `package.json` natively as a JSON module without
 * an import attribute, so this test does not pull ES2025 syntax into
 * source-mode parsing.
 */

import { describe, expect, test } from "bun:test";
import pkg from "../package.json";
import { VERSION } from "../src/version.js";

describe("SDK version", () => {
  test("VERSION matches package.json (run `bun run sync-version` if this fails)", () => {
    expect(VERSION).toBe(pkg.version);
  });

  test("VERSION is a non-empty semver-looking string", () => {
    expect(typeof VERSION).toBe("string");
    expect(VERSION.length).toBeGreaterThan(0);
    // Loose semver shape: digits.digits.digits with optional pre-release.
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+(-[a-z0-9.-]+)?$/i);
  });
});
