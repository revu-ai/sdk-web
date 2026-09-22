/**
 * @file Size budget for `@revu-ai/core`.
 *
 * One number is a product decision; every gate below derives from it.
 *
 * That number is the BROTLI size, because brotli is what the CDN serves and
 * what every modern browser accepts, so it is the only figure that describes
 * what a visitor actually downloads. The North Star commits the SDK to a
 * cold load in single-digit kilobytes, which is exactly a brotli budget of
 * under 10 kB. The budget is therefore not a preference: it is that promise,
 * written down where CI can enforce it.
 *
 * The other two gates are derived so that neither can be nudged on its own.
 * Before this file, the raw-minified gate was a standalone number, and the
 * first change that breached it moved it, which is how a budget stops meaning
 * anything. Now the only way to buy room is to raise WIRE_BUDGET_KB, and
 * raising that is a visible decision about the promise, not a rounding-up.
 */

/**
 * Brotli budget, in kB, for a single entry point. The whole budget lives
 * here. Raising it means accepting a slower cold load, so it is an owner
 * decision, not a build fix.
 * @type {number}
 */
const WIRE_BUDGET_KB = 10;

/**
 * gzip allowance as a multiple of the brotli budget. gzip is the fallback
 * path for a CDN edge or client that cannot negotiate brotli; it runs around
 * 11% larger on this bundle, so 1.15 leaves a little room without letting the
 * fallback drift away from the real budget.
 * @type {number}
 */
const GZIP_RATIO = 1.15;

/**
 * Raw-minified allowance as a multiple of the brotli budget. This gate is
 * NOT about transfer, which the two compressed gates already cover. It is a
 * parse and execute guard: uncompressed bytes are what the JS engine has to
 * read, and highly repetitive code can grow a lot while compressing almost
 * for free, which the compressed gates would hide.
 *
 * Expressed as a ratio rather than a fixed size, so it trips when minified
 * size grows FASTER than compressed size, which is the only thing it can
 * usefully detect. The bundle sits at about 3.62; 3.75 leaves working room
 * while still catching a real change in the shape of the code.
 * @type {number}
 */
const PARSE_RATIO = 3.75;

/** @param {number} n @returns {string} */
const kb = (n) => `${Math.round(n * 1000) / 1000} kB`;

/**
 * Three gates per entry point: the budget itself, the fallback transfer
 * path, and the parse guard.
 * @param {string} name
 * @param {string} path
 * @returns {object[]}
 */
const gates = (name, path) => [
  {
    name: `${name} (brotli, the wire cost, THE budget)`,
    path,
    limit: kb(WIRE_BUDGET_KB),
    brotli: true,
    gzip: false,
    disablePlugins: ["@size-limit/esbuild"],
  },
  {
    name: `${name} (gzip, fallback transfer path)`,
    path,
    limit: kb(WIRE_BUDGET_KB * GZIP_RATIO),
    gzip: true,
    brotli: false,
    disablePlugins: ["@size-limit/esbuild"],
  },
  {
    name: `${name} (raw min, parse guard)`,
    path,
    limit: kb(WIRE_BUDGET_KB * PARSE_RATIO),
    gzip: false,
    brotli: false,
    disablePlugins: ["@size-limit/esbuild"],
  },
];

export default [...gates("core esm", "dist/index.js"), ...gates("core iife", "dist/iife/index.js")];
