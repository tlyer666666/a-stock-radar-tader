import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { injectCspConnectSources } from "./src/contentSecurityPolicy";
import packageJson from "./package.json";

export default defineConfig(({ command }) => ({
  define: {
    __APP_VERSION__: JSON.stringify(packageJson.version)
  },
  plugins: [
    react(),
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
    strictPort: true,
    watch: {
      ignored: [
        "**/tmp/**",
        "**/release/**",
        "**/release-builder/**",
        "**/程序/**"
      ]
    }
  },
  build: {
    outDir: "dist",
    emptyOutDir: true
  }
}));
