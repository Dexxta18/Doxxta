import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Relative base so the build can be hosted from any sub-path (or opened from a
// static file server) without rewriting asset URLs.
export default defineConfig({
  base: "./",
  plugins: [react()],
  worker: { format: "es" },
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 4000,
    sourcemap: false,
  },
  optimizeDeps: {
    exclude: ["pdfjs-dist"],
  },
  server: { host: "127.0.0.1", port: 5173 },
  preview: { host: "127.0.0.1", port: 4173 },
});
