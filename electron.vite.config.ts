import { resolve } from "node:path";
import { defineConfig } from "electron-vite";

export default defineConfig({
  main: {
    build: {
      outDir: "dist/main",
      rollupOptions: {
        input: {
          main: resolve(__dirname, "src/main/main.ts")
        }
      }
    }
  },
  preload: {
    build: {
      outDir: "dist/preload",
      rollupOptions: {
        input: {
          preload: resolve(__dirname, "src/preload/preload.ts")
        }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, "src/renderer"),
    publicDir: resolve(__dirname, "build"),
    build: {
      outDir: resolve(__dirname, "dist/renderer"),
      emptyOutDir: true
    }
  }
});
