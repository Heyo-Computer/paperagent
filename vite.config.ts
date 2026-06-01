import { defineConfig } from "vite";
import preact from "@preact/preset-vite";
import { fileURLToPath } from "node:url";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// preact/compat lacks React 19's `use` hook that Mantine v8 (via BlockNote)
// imports; route `react` through a shim that adds it.
const reactShim = fileURLToPath(new URL("./src/shims/react-compat.js", import.meta.url));
const reactDomClientShim = fileURLToPath(new URL("./src/shims/react-dom-client.js", import.meta.url));

// https://vite.dev/config/
export default defineConfig(async () => ({
  // Disable the preset's built-in react->preact/compat aliases so ours win; the
  // preset's bare `react: preact/compat` would otherwise shadow our shim and
  // re-break the missing React 19 `use` / `createRoot` exports.
  plugins: [preact({ reactAliasesEnabled: false })],

  resolve: {
    alias: {
      // order matters: deep imports before the bare `react` entry
      "react-dom/test-utils": "preact/test-utils",
      "react/jsx-runtime": "preact/jsx-runtime",
      "react-dom/client": reactDomClientShim,
      "react-dom": "preact/compat",
      react: reactShim,
    },
  },

  optimizeDeps: {
    include: ["@blocknote/core", "@blocknote/react", "@blocknote/mantine"],
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
