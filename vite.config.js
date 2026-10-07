import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cacheBust } from "./scripts/cache-bust.mjs";
export default defineConfig({
  // Every build stamps the assets its pages ask for: scripts/cache-bust.mjs.
  plugins: [react(), cacheBust()],
  server: { proxy: { "/api": "http://127.0.0.1:3000" } },
  build: { sourcemap: false },
});
