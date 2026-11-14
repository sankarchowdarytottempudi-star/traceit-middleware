import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import svgr from "vite-plugin-svgr";
export default defineConfig({
  plugins: [react(), svgr()],
  server: { proxy: { "^/api/": { target: "http://localhost:8787", changeOrigin: true } } },
  test: { environment: "jsdom", globals: true, setupFiles: ["./test/setup.ts"], include: ["test/**/*.test.{ts,tsx}"] },
} as any);
