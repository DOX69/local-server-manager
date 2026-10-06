import path from "node:path"
import { fileURLToPath } from "node:url"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

const root = fileURLToPath(new URL(".", import.meta.url))

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": path.resolve(root, "src") },
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": { target: "http://127.0.0.1:4780", changeOrigin: false },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    cssCodeSplit: false,
    assetsInlineLimit: 100_000,
    rollupOptions: {
      output: {
        entryFileNames: "assets/app.js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: (asset) =>
          asset.name?.endsWith(".css") ? "assets/style.css" : "assets/[name][extname]",
      },
    },
  },
})
