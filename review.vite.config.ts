import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [react()],
  base: "./",
  define: {
    "process.env.NODE_ENV": JSON.stringify("production")
  },
  build: {
    outDir: "dist/review",
    emptyOutDir: true,
    minify: "esbuild",
    lib: {
      entry: resolve(__dirname, "src/review-entry.tsx"),
      name: "AStockProfessionalReview",
      formats: ["es"],
      fileName: () => "review-module.js",
      cssFileName: "review-style"
    }
  }
});
