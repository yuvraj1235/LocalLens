{
  // vite.config.ts – minimal configuration for the UI prototype
  // Serves the `src/ui` folder as the project root and enables TypeScript module handling.
  // No special plugins needed because Vite natively supports ES modules.

  import { defineConfig } from "vite";

  export default defineConfig({
    root: "src/ui",
    base: "./",
    server: {
      // Use a convenient port; can be overridden via env.
      port: 5173,
    },
    // Resolve .ts files directly (Vite does this automatically)
    resolve: {
      extensions: [".ts", ".js"],
    },
  });
}
