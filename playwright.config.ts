import { defineConfig, devices } from "@playwright/test";
import { E2E_DATABASE_URL, E2E_OWNER_ID, E2E_OWNER_TOKEN } from "./e2e/constants";

const PORT = parseInt(process.env.E2E_PORT ?? "3099", 10);
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI
    ? [["html", { open: "never" }], ["list"]]
    : "list",
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: `cross-env NODE_ENV=test PORT=${PORT} SERVE_FRONTEND=true DATABASE_URL=${E2E_DATABASE_URL} OWNER_API_TOKEN=${E2E_OWNER_TOKEN} LOCAL_OWNER_ID=${E2E_OWNER_ID} APP_ORIGIN=${BASE_URL} npx tsx src/server.ts`,
    url: `${BASE_URL}/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
  },
});
