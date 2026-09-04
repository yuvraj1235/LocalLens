import { defineConfig } from "vite";
import { resolve } from "path";
export default defineConfig({
    build: {
        emptyOutDir: false, // Don't wipe the dist folder created by the main build
        outDir: "dist",
        lib: {
            entry: resolve(__dirname, "src/content/content.ts"),
            name: "LocalLensContent",
            formats: ["iife"], // Force IIFE format (no imports/exports in the output)
            fileName: () => "content/content.js",
        },
    },
});
