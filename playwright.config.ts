import { defineConfig, devices } from "@playwright/test";

const PORT = parseInt(process.env.E2E_PORT ?? "3099", 10);
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
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
    command: `cross-env NODE_ENV=test PORT=${PORT} SERVE_FRONTEND=true DATABASE_URL=postgresql://vocab:vocab@127.0.0.1:5432/vocab OWNER_API_TOKEN=test-owner-token-for-e2e-0123456789 LOCAL_OWNER_ID=00000000-0000-1000-8000-000000000001 APP_ORIGIN=${BASE_URL} npx tsx src/server.ts`,
    url: `${BASE_URL}/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    gracefulShutdown: true,
  },
});
