import { defineConfig } from "vitest/config";
import path from "node:path";

// Separate config for integration tests — does NOT exclude
// review-concurrency.test.ts like the default config does.
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  test: {
    testTimeout: 30000,
    environment: "node",
    include: ["tests/review-concurrency.test.ts"],
    exclude: ["node_modules/**"],
    setupFiles: ["./tests/setup.ts"],
  },
});
