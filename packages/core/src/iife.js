/**
 * @file IIFE bundle entry for @revu-ai/core.
 *
 * Bundled to `dist/iife/index.js` and loaded by customers with a plain
 * `<script>` tag (no `type="module"`). The same artifact is served via
 * `cdn.revu.ai/behavior`, but the file is named after what it is (an
 * IIFE entry) rather than where it ships from, so the source still
 * makes sense if we ever serve it from a different channel.
 *
 * The entry has two responsibilities that distinguish it from the npm
 * entry (`src/index.js`):
 *
 *   1. It installs the SDK singleton as `globalThis.revu`. The npm entry
 *      uses `export default revu` which a bundler converts to a clean
 *      `import revu from "@revu-ai/core"` for ESM consumers; an IIFE
 *      wrapper around that same module would produce a global of shape
 *      `{ default: ..., RevuClient: ..., VERSION: ... }`, forcing
 *      `<script>`-tag customers to write `revu.default.init(...)`. Having
 *      a separate entry whose only export is a side effect lets us put
 *      the singleton itself at `window.revu`.
 *
 *   2. It drains the fire-before-load stub queue documented in
 *      `docs/install.md` against the real singleton. The drain logic is
 *      implemented in `./iife-boot.js` so this module can stay
 *      export-free, which keeps the Rollup IIFE wrapper at its minimal
 *      `!function(){...}()` form (no `output.name`, no throwaway
 *      export-emit line) and shaves bytes off the customer download.
 */

import revu from "./index.js";
import { bootIife } from "./iife-boot.js";

// Entry-point side effect. Runs once when this bundle is evaluated.
bootIife(revu, /** @type {Record<string, unknown>} */ (globalThis).revu);
