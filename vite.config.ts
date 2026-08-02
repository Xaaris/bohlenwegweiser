import { defineConfig } from "vite";
export default defineConfig({
  // Relative asset paths, so the build works from any URL or subfolder.
  base: "./",
  build: { outDir: "dist" },
});
