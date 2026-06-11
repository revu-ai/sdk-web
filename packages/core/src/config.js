/**
 * @file Configuration resolution - applies defaults to user-supplied config.
 */

/** @type {Omit<import("./types.js").ResolvedConfig, "apiKey">} */
const DEFAULTS = {
  host: "https://api.revu.ai",
  environment: "production",
  autocapture: true,
  autoIdentify: true,
  persistentStorage: "both",
  cookieDomain: null,
  maskAllInputs: true,
  flushIntervalMs: 5000,
  flushAt: 20,
  maxBatch: 50,
  maxQueue: 1000,
  debug: false,
  onEvent: () => {},
  captureWebVitals: true,
  captureAttention: true,
  idleTimeoutMs: 30000,
  sessionTimeoutMs: 30 * 60 * 1000,
  plugins: [],
};

const VALID_ENVIRONMENTS = new Set(["production", "staging", "development"]);

/**
 * Merge user config over defaults and validate the required fields.
 *
 * The `safe()` wrapper on the public `init()` swallows anything thrown
 * here, so a misconfigured init never crashes the host page. In debug
 * mode the error surfaces via `onError`; otherwise the SDK fails closed
 * by simply not initializing. We throw with a `[REVU] init() ...` prefix
 * so developers see a clear, scoped message when they do look at the
 * console.
 *
 * @param {import("./types.js").RevuConfig} config
 * @returns {import("./types.js").ResolvedConfig}
 */
export function resolveConfig(config) {
  if (!config || typeof config.apiKey !== "string" || config.apiKey.length === 0) {
    throw new Error("[REVU] init() requires an `apiKey` string.");
  }
  const merged = { ...DEFAULTS, ...config };
  validateHost(merged.host);
  validateEnvironment(merged.environment);
  return merged;
}

/**
 * Validate `environment` against the three accepted values. Anything else
 * (custom strings, numbers, undefined) is a config typo; throw with a clear
 * message so the developer sees it in the console. The dashboard reads
 * default to `environment = "production"` so stamping an arbitrary string
 * would silently make the events invisible to the default view.
 *
 * @param {unknown} environment
 */
function validateEnvironment(environment) {
  if (!VALID_ENVIRONMENTS.has(/** @type {string} */ (environment))) {
    throw new Error(
      `[REVU] init() environment must be "production", "staging", or "development", got ${JSON.stringify(environment)}`,
    );
  }
}

/**
 * Validate that the configured `host` is a syntactically valid URL whose
 * scheme is `http:` or `https:`. We do not allow file:, ws:, javascript:,
 * etc. - the SDK only ever issues fetch/sendBeacon to this base, and any
 * non-HTTP scheme is either a configuration typo or an exploitation
 * attempt. Throws a `[REVU] init() ...` error on failure.
 *
 * @param {unknown} host
 */
function validateHost(host) {
  if (typeof host !== "string" || host.length === 0) {
    throw new Error(`[REVU] init() host must be a non-empty string.`);
  }
  let url;
  try {
    url = new URL(host);
  } catch {
    throw new Error(`[REVU] init() host must be a valid URL: ${host}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`[REVU] init() host must use http: or https:, got ${url.protocol}`);
  }
}
