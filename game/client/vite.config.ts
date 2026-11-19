import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:8787",
        changeOrigin: true,
      },
      "/world-assets": {
        target: "http://localhost:8787",
        changeOrigin: true,
      },
      "/generated-assets": {
        target: "http://localhost:8787",
        changeOrigin: true,
      },
    },
  },
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 4000,
    rollupOptions: {
      input: {
        main: "index.html",
        aholoViewer: "aholo-viewer.html",
        foundation: "foundation.html",
      },
    },
  },
  assetsInclude: ["**/*.spz", "**/*.sog", "**/*.ply", "**/*.wasm"],
  // aholo-viewer 的 worker 经 new URL('./xxx-worker.js', import.meta.url) 相对引用 dist 内文件；
  // 预优化到 .vite/deps 后相对路径失效（worker 404），必须排除让其按原路径加载。
  optimizeDeps: {
    exclude: ["@manycore/aholo-viewer"],
  },
});
