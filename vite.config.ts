import { defineConfig } from "vite";
import { resolve } from "path";
import { copyFileSync, mkdirSync, existsSync } from "fs";

// Plugin: copy manifest.json + icons into dist after build
function copyExtensionAssets() {
  return {
    name: "copy-extension-assets",
    closeBundle() {
      // manifest
      copyFileSync("manifest.json", "dist/manifest.json");

      // icons
      const iconDir = "dist/icons";
      if (!existsSync(iconDir)) mkdirSync(iconDir, { recursive: true });

      const srcIcon = "src/assets/icon128.png";
      if (existsSync(srcIcon)) {
        copyFileSync(srcIcon, "dist/icons/icon128.png");
        copyFileSync(srcIcon, "dist/icons/icon48.png");
        copyFileSync(srcIcon, "dist/icons/icon16.png");
      } else {
        console.warn("[LocalLens] icons not found at src/assets/icon128.png — skipping icon copy.");
      }
    },
  };
}

export default defineConfig({
  root: ".",
  base: "./",
  plugins: [copyExtensionAssets()],
  server: {
    port: 5173,
  },
  resolve: {
    extensions: [".ts", ".js"],
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        // Extension entry points
        popup:      resolve(__dirname, "src/popup/popup.html"),
        background: resolve(__dirname, "src/background/background.ts"),
        content:    resolve(__dirname, "src/content/content.ts"),
        // Debug UI (optional, not loaded by Chrome but handy for dev)
        ui:         resolve(__dirname, "src/ui/index.html"),
      },
      output: {
        // Keep each entry in its own sub-folder so manifest paths are clean
        entryFileNames: (chunk) => {
          const dirs: Record<string, string> = {
            popup:      "popup/popup.js",
            background: "background/background.js",
            content:    "content/content.js",
            ui:         "ui/main.js",
          };
          return dirs[chunk.name] ?? `[name]/[name].js`;
        },
        // Chunks go into a shared _chunks folder so CSP is easier
        chunkFileNames: "_chunks/[name]-[hash].js",
        assetFileNames: (info) => {
          // Keep popup.css next to popup.html
          if (info.name?.endsWith(".css")) {
            return "popup/[name][extname]";
          }
          return "assets/[name][extname]";
        },
      },
    },
  },
});
