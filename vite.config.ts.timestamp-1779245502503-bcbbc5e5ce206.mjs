// vite.config.ts
import { defineConfig } from "file:///sessions/festive-trusting-turing/mnt/yusafcut/node_modules/vite/dist/node/index.js";
import react from "file:///sessions/festive-trusting-turing/mnt/yusafcut/node_modules/@vitejs/plugin-react/dist/index.js";
import path from "node:path";
var __vite_injected_original_dirname = "/sessions/festive-trusting-turing/mnt/yusafcut";
var host = process.env.TAURI_DEV_HOST;
var vite_config_default = defineConfig(async () => ({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__vite_injected_original_dirname, "./src")
    }
  },
  // Vite options tailored for Tauri
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : void 0,
    watch: {
      ignored: ["**/src-tauri/**"]
    }
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx", "src/**/*.test.ts", "src/**/*.test.tsx"]
  }
}));
export {
  vite_config_default as default
};
