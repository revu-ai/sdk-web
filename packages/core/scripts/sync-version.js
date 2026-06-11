/**
 * @file Regenerate `src/version.js` from the `version` field in
 * `package.json`. Wired as the `prebuild` script so every build picks
 * up the current package version automatically; `src/version.js` is
 * also committed so a fresh clone runs source-mode without needing to
 * run this script first (the vanilla example imports straight from
 * `src/` in the browser, where no build step has happened).
 *
 * Source of truth is `package.json`. The committed `src/version.js`
 * is a derived artifact, and the test in `test/version.test.js` fails
 * CI if the two ever drift.
 */

const pkgUrl = new URL("../package.json", import.meta.url);
const pkg = await Bun.file(pkgUrl).json();

const out = `/**
 * @file SDK version constant.
 *
 * Auto-generated from packages/core/package.json by
 * scripts/sync-version.js. Do not edit by hand; bump package.json's
 * "version" field and rerun the script (the prebuild hook does this
 * automatically on every build).
 */
export const VERSION = ${JSON.stringify(pkg.version)};
`;

await Bun.write(new URL("../src/version.js", import.meta.url), out);
console.log(`sync-version: src/version.js -> ${pkg.version}`);
