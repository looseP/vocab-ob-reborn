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
    // Integration files share one PostgreSQL database and several suites
    // intentionally TRUNCATE/seed the same contract tables. Serializing files
    // prevents cross-suite fixture pollution while each suite still exercises
    // database concurrency explicitly within its own tests.
    fileParallelism: false,
    include: ["tests/**/*.integration.test.ts"],
    exclude: ["node_modules/**"],
    setupFiles: ["./tests/setup.ts"],
  },
});
