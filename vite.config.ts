import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { injectCspConnectSources } from "./src/contentSecurityPolicy";
import packageJson from "./package.json";
import { createBuildProvenancePlugin } from "./qa/build-provenance.cjs";

export default defineConfig(({ command }) => ({
  define: {
    __APP_VERSION__: JSON.stringify(packageJson.version)
  },
  plugins: [
    react(),
    createBuildProvenancePlugin({ root: __dirname, kind: "web" }),
    {
      name: "environment-csp",
      transformIndexHtml(html) {
        return injectCspConnectSources(html, command);
      }
    }
  ],
  base: "./",
  server: {
    port: 5173,
    strictPort: true
  },
  build: {
    outDir: "dist",
    emptyOutDir: true
  }
}));
