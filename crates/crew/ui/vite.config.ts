import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ command }) => ({
  plugins: [react()],
  // Production uses relative URLs for Tauri's custom protocol.
  // Dev uses `/` so Vite HMR (port 1420, started by cargo run) can resolve modules.
  base: command === "build" ? "./" : "/",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2021",
  },
  clearScreen: false,
  server: {
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/target/**", "**/*.rs"],
    },
  },
}));
