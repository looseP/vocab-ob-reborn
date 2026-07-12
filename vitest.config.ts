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
    exclude: ["tests/review-concurrency.test.ts", "tests/**/*.integration.test.ts", "node_modules/**"],
    setupFiles: ["./tests/setup.ts"],
    coverage: {
      provider: "v8",
      reportsDirectory: "coverage",
      reporter: ["text", "html", "json", "json-summary"],
      // Govern each core business layer independently. HTTP, DB integration,
      // scripts/workflows and E2E are represented by the functional evidence
      // matrix produced by scripts/report-layered-coverage.ts.
      include: ["src/repositories/**/*.ts", "src/services/**/*.ts", "src/domain/**/*.ts", "src/errors/**/*.ts"],
      exclude: ["src/**/types.ts"],
      // The layer-aware 85/85/75 gates run after Vitest. Keep only a low global
      // floor here so a strong layer cannot hide a weak one in one aggregate.
      thresholds: {
        lines: 75,
        functions: 70,
        branches: 65,
        statements: 75,
      },
    },
  },
});
