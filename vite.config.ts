import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Relative base so the build can be hosted from any sub-path (or opened from a
// static file server) without rewriting asset URLs.
const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

export default defineConfig({
  base: "./",
  define: { __APP_VERSION__: JSON.stringify(version) },
  plugins: [react()],
  resolve: {
    alias: {
      // pdf-lib's password algorithms aren't exported from its package entry.
      "pdf-lib-crypto": fileURLToPath(new URL("./node_modules/@cantoo/pdf-lib/es/core/crypto.js", import.meta.url)),
    },
  },
  worker: { format: "es" },
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 4000,
    sourcemap: false,
    rolldownOptions: {
      output: {
        // pdf.js's worker is a .mjs file; as .js it's served as JavaScript everywhere, including
        // by the iPhone app, which doesn't know .mjs (and won't start a worker that isn't JavaScript).
        assetFileNames: ({ names }) => (names[0]?.endsWith(".mjs") ? "assets/[name]-[hash].js" : "assets/[name]-[hash][extname]"),
      },
    },
  },
  optimizeDeps: {
    exclude: ["pdfjs-dist"],
    // Pre-bundled together so both share one copy of pdf-lib's object classes.
    include: ["@cantoo/pdf-lib", "pdf-lib-crypto"],
  },
  server: { host: "127.0.0.1", port: 5173 },
  preview: { host: "127.0.0.1", port: 4173 },
});
