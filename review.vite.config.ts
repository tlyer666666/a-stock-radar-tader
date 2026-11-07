import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import packageJson from "./package.json";
import { createBuildProvenancePlugin } from "./qa/build-provenance.cjs";
import { readFileSync } from 'node:fs';
import { injectCspConnectSources } from './src/contentSecurityPolicy';

export default defineConfig({
  plugins: [react(), {
    name: 'review-standalone-entry',
    transformIndexHtml(html) { return injectCspConnectSources(html, 'serve'); },
    generateBundle() {
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
