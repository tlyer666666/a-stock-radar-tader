// Static analysis baseline for both source shapes in this repo:
//   - src/**            ESM + React + TypeScript (bundled by Vite)
//   - electron|qa/**    CommonJS, executed directly by Node / Electron
//
// Rule selection is deliberately conservative: every rule enabled here must pass on
// the current tree, so the gate stays meaningful instead of being switched off.
// Tighten module by module; never add a rule together with a blanket `eslint-disable`.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

// Node >=18 exposes these Web APIs natively; production main-process code relies on them.
// `crypto` is deliberately absent: every module that needs it does `require("node:crypto")`,
// and pre-declaring the global would make that explicit import look like a redeclaration.
const NODE_GLOBALS = {
  require: "readonly", module: "readonly", exports: "writable", __dirname: "readonly", __filename: "readonly",
  process: "readonly", console: "readonly", Buffer: "readonly", URL: "readonly", URLSearchParams: "readonly",
  setTimeout: "readonly", clearTimeout: "readonly", setInterval: "readonly", clearInterval: "readonly",
  setImmediate: "readonly", queueMicrotask: "readonly", structuredClone: "readonly", performance: "readonly",
  fetch: "readonly", atob: "readonly", btoa: "readonly",
  AbortController: "readonly", AbortSignal: "readonly", TextEncoder: "readonly", TextDecoder: "readonly",
  DOMException: "readonly", Response: "readonly", Request: "readonly", Headers: "readonly",
  ReadableStream: "readonly", WritableStream: "readonly", TransformStream: "readonly",
  Blob: "readonly", File: "readonly", FormData: "readonly", WebSocket: "readonly", EventSource: "readonly",
  globalThis: "readonly"
};

// The QA drivers and the browser-side halves of the test suites run inside a real page,
// so they legitimately reference DOM globals. Production renderer code is covered by the
// TypeScript DOM lib instead (no-undef is disabled there). Keeping this list scoped to
// qa/** and *.test.cjs means a DOM reference leaking into electron/** still fails.
// `history` is absent because those suites shadow it with their own fixture data.
const BROWSER_GLOBALS = {
  window: "readonly", document: "readonly", navigator: "readonly", location: "readonly",
  localStorage: "readonly", sessionStorage: "readonly", Storage: "readonly", StorageEvent: "readonly",
  requestAnimationFrame: "readonly", cancelAnimationFrame: "readonly", getComputedStyle: "readonly",
  innerWidth: "readonly", innerHeight: "readonly", devicePixelRatio: "readonly", matchMedia: "readonly",
  HTMLElement: "readonly", HTMLInputElement: "readonly", Element: "readonly", Node: "readonly",
  Image: "readonly", Event: "readonly", MouseEvent: "readonly", KeyboardEvent: "readonly",
  CustomEvent: "readonly", ResizeObserver: "readonly", IntersectionObserver: "readonly",
  MutationObserver: "readonly", getSelection: "readonly", alert: "readonly"
};

export default [
  { ignores: ["dist/**", "release-builder/**", "release/**", "artifacts/**", "node_modules/**", "**/*.min.js"] },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    // Unused code is the defect class this gate exists to catch: it accumulated in .cjs
    // because nothing checked it. TypeScript already enforces this for src/ via
    // noUnusedLocals/noUnusedParameters, so the rule mainly covers the CommonJS side.
    files: ["**/*.{js,cjs,ts,tsx}"],
    rules: {
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": ["error", {
        args: "after-used", argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none"
      }],
      "no-empty": ["error", { allowEmptyCatch: true }],
      // Files that need `performance`/`crypto` import them explicitly from node: perf_hooks
      // and node:crypto. Reporting that as a redeclaration of a declared global is noise,
      // so only same-scope duplicates are reported.
      "no-redeclare": ["error", { builtinGlobals: false }],
      // All eight flagged sites are defensive initializers (`let rows = []` before a
      // try/catch that assigns on every path, `let retryDelay = 0` before a conditional
      // assignment). Removing them changes no behaviour but drops the safety net for the
      // next edit in network/persistence code, so the rule is parked rather than churned.
      "no-useless-assignment": "off",
      // The rule targets the obsolete `const self = this` React workaround. The single
      // site is a test fixture's Worker subclass capturing itself, which is legitimate.
      "@typescript-eslint/no-this-alias": ["error", { allowedNames: ["worker"] }],
      // Deferred to the IPC-contract phase: 224 `any` sites exist today, all in the
      // renderer. Enabling this now would produce noise, not signal.
      "@typescript-eslint/no-explicit-any": "off",
      // CommonJS modules legitimately use require().
      "@typescript-eslint/no-require-imports": "off"
    }
  },

  {
    files: ["**/*.cjs"],
    languageOptions: { ecmaVersion: 2022, sourceType: "commonjs", globals: NODE_GLOBALS }
  },

  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: { ecmaVersion: 2022, sourceType: "module" },
    // TypeScript resolves identifiers itself; no-undef only produces false positives.
    rules: { "no-undef": "off" }
  },

  {
    files: ["qa/**/*.cjs", "**/*.test.cjs"],
    languageOptions: { globals: { ...NODE_GLOBALS, ...BROWSER_GLOBALS } }
  }
];
