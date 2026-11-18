const { defineConfig } = require("vite");
const reactPlugin = require("@vitejs/plugin-react");
const { injectCspConnectSources } = require("./qa/vite-csp.cjs");
const packageJson = require("./package.json");
const { createBuildProvenancePlugin } = require("./qa/build-provenance.cjs");

const react = reactPlugin.default || reactPlugin;

module.exports = defineConfig(({ command }: { command: "serve" | "build" }) => ({
  define: {
    __APP_VERSION__: JSON.stringify(packageJson.version)
  },
  plugins: [
    react(),
    createBuildProvenancePlugin({ root: __dirname, kind: "web" }),
    {
      name: "environment-csp",
      transformIndexHtml(html: string) {
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
    emptyOutDir: true,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: "vendor-react",
              test: /[\\/]node_modules[\\/](?:react|react-dom|scheduler)[\\/]/,
              priority: 20
            },
            {
              name: "vendor-icons",
              test: /[\\/]node_modules[\\/]lucide-react[\\/]/,
              priority: 15
            }
          ]
        }
      }
    }
  }
}));
