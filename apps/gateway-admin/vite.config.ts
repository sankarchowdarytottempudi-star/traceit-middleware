import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import svgr from "vite-plugin-svgr";
import { weaveEdition } from "@traceit/weave-brand/vite";
export default defineConfig({
  plugins: [react(), svgr(), weaveEdition()],
  server: { proxy: { "^/api/": { target: "http://localhost:8787", changeOrigin: true } } },
  test: { environment: "jsdom", globals: true, setupFiles: ["./test/setup.ts"], include: ["test/**/*.test.{ts,tsx}"] },
} as any);
