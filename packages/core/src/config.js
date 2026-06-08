/**
 * @file Configuration resolution - applies defaults to user-supplied config.
 */

/** @type {Omit<import("./types.js").ResolvedConfig, "apiKey">} */
const DEFAULTS = {
  host: "https://api.revu.ai",
  autocapture: true,
  maskAllInputs: true,
  flushIntervalMs: 5000,
  flushAt: 20,
  maxBatch: 50,
  maxQueue: 1000,
  debug: false,
  onEvent: () => {},
};

/**
 * Merge user config over defaults and validate the required fields.
 * @param {import("./types.js").RevuConfig} config
 * @returns {import("./types.js").ResolvedConfig}
 */
export function resolveConfig(config) {
  if (!config || typeof config.apiKey !== "string" || config.apiKey.length === 0) {
    throw new Error("[REVU] init() requires an `apiKey` string.");
  }
  return { ...DEFAULTS, ...config };
}
