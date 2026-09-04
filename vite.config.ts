import { defineConfig } from "vite";

export default defineConfig({
  // Serve from project root so both src/ui and src/popup are reachable
  root: ".",
  base: "./",
  server: {
    port: 5173,
  },
  resolve: {
    extensions: [".ts", ".js"],
  },
  build: {
    // Multi-page app: both HTML files become separate entry points
    rollupOptions: {
      input: {
        ui:    `${import.meta.dirname}/src/ui/index.html`,
        popup: `${import.meta.dirname}/src/popup/popup.html`,
      },
    },
    outDir: "dist",
  },
});
