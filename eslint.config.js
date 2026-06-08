/**
 * @file ESLint v9 flat config for the REVU Web SDK.
 *
 * Vanilla JS (ESM) targeting the browser. Tests run under `bun:test` and only
 * use the imported `describe`/`test`/`expect` helpers, no globals to allowlist.
 * We deliberately do not depend on `@eslint/js` to keep the dev-tooling
 * footprint minimal (AGENTS.md: zero runtime deps, dev tooling stays minimal).
 */

/** @type {import("eslint").Linter.Config[]} */
export default [
  {
    ignores: ["**/dist/**", "**/node_modules/**", "examples/**"],
  },
  {
    files: ["packages/**/src/**/*.js", "packages/**/test/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        // Standard browser surfaces used by the capture/transport layers.
        window: "readonly",
        document: "readonly",
        navigator: "readonly",
        localStorage: "readonly",
        location: "readonly",
        history: "readonly",
        addEventListener: "readonly",
        removeEventListener: "readonly",
        fetch: "readonly",
        console: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        crypto: "readonly",
        URL: "readonly",
        Response: "readonly",
        Event: "readonly",
        PopStateEvent: "readonly",
        // DOM types used in JSDoc casts.
        Element: "readonly",
        MouseEvent: "readonly",
        Storage: "readonly",
        Navigator: "readonly",
      },
    },
    rules: {
      "no-undef": "error",
      "no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-var": "error",
      "prefer-const": "warn",
      eqeqeq: ["error", "smart"],
      "no-implicit-globals": "error",
      "no-throw-literal": "error",
    },
  },
];
