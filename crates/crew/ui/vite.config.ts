import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Relative URLs so Tauri's custom protocol can load JS/CSS from dist/.
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2021",
  },
  clearScreen: false,
});
