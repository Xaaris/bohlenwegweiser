import { defineConfig } from "vitest/config";

export default defineConfig({
  // live.test.ts is excluded because it needs network access.
  // Run it with `npm run test:live`.
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/live.test.ts", "node_modules/**"],
  },
});
