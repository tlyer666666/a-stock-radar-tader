const { defineConfig } = require("vite");
const reactPlugin = require("@vitejs/plugin-react");
const { resolve } = require("node:path");
const packageJson = require("./package.json");
const { createBuildProvenancePlugin } = require("./qa/build-provenance.cjs");
const { readFileSync } = require("node:fs");
const { injectCspConnectSources } = require("./qa/vite-csp.cjs");

const react = reactPlugin.default || reactPlugin;

module.exports = defineConfig({
  plugins: [react(), {
    name: 'review-standalone-entry',
    transformIndexHtml(html: string) { return injectCspConnectSources(html, 'serve'); },
    generateBundle(this: { emitFile: (file: { type: "asset"; fileName: string; source: string }) => void }) {
      const html = injectCspConnectSources(readFileSync(resolve(__dirname, 'review.html'), 'utf8'), 'build')
        .replace('src="/src/review-entry.tsx"', 'src="./review-module.js"')
        .replace('</head>', '<link rel="stylesheet" href="./review-style.css" /></head>');
      this.emitFile({ type: 'asset', fileName: 'review.html', source: html });
    }
  }, createBuildProvenancePlugin({ root: __dirname, kind: "review" })],
  base: "./",
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
    __APP_VERSION__: JSON.stringify(packageJson.version)
  },
  build: {
    outDir: "dist/review",
    emptyOutDir: true,
    // Vite 8 dropped the bundled esbuild, so `minify: "esbuild"` no longer resolves.
    // Use the built-in default minifier (oxc) instead.
    lib: {
      entry: resolve(__dirname, "src/review-entry.tsx"),
      name: "AStockProfessionalReview",
      formats: ["es"],
      fileName: () => "review-module.js",
      cssFileName: "review-style"
    }
  }
});
