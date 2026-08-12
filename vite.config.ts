import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { injectCspConnectSources } from "./src/contentSecurityPolicy";

export default defineConfig(({ command }) => ({
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
    strictPort: true
  },
  build: {
    outDir: "dist",
    emptyOutDir: true
  }
}));
