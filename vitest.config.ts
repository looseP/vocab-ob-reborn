import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  test: {
    testTimeout: 30000,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/review-concurrency.test.ts", "node_modules/**"],
    setupFiles: ["./tests/setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "json"],
      // Only measure repository layer coverage — db/ is ported infrastructure
      // (pool/sql/transaction) tested by integration tests, not unit tests.
      include: ["src/repositories/**/*.ts", "src/services/**/*.ts", "src/domain/**/*.ts", "src/errors/**/*.ts"],
      exclude: ["src/db/**/*.ts", "src/**/types.ts", "src/domain/**"],
      thresholds: {
        lines: 75,
        functions: 70,
        branches: 65,
        statements: 75,
      },
    },
  },
});
