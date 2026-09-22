import { defineConfig, devices } from "@playwright/test";

/**
 * Task 07 联调宿主 E2E（独立运行，不进 CI 默认收集）：
 * - testDir=./e2e-study-notes —— 仓库默认 `npx playwright test`（playwright.config.ts）
 *   不收集本目录；本批以显式 `--config` 运行；
 * - 前置（RUNBOOK，均在 D:/Temp/vocab-ob-n1-editor 下执行）：
 *   1) 显式构建（含宿主，生产默认构建不含）：
 *        VITE_N1_STUDY_NOTE_HOST=1 npm run frontend:build
 *   2) 手动启动服务（本批验证对象 = 真实 session/CSRF + 真实 PG）：
 *        NODE_ENV=test PORT=3097 SERVE_FRONTEND=true DB_SSLMODE=disable \
 *        DATABASE_URL=postgresql://vocab_app:LocalRlsApp_7rN3zM4c@127.0.0.1:5433/vocab_study_notes_task07_accept \
 *        OWNER_API_TOKEN=test-owner-token-for-e2e-0123456789 \
 *        LOCAL_OWNER_ID=00000000-0000-1000-8000-000000000001 \
 *        APP_ORIGIN=http://127.0.0.1:3097 \
 *        node node_modules/tsx/dist/cli.mjs src/server.ts
 *   3) 运行本套件（admin 连接用于种子与库核断言）：
 *        DATABASE_URL=<app-url> E2E_SETUP_DATABASE_URL=<migration-url> \
 *        npx playwright test --config playwright.study-notes.config.ts
 * - 库：本批独立空验收库 vocab_study_notes_task07_accept@5433（spec 内显式校验库身份）。
 */
const PORT = parseInt(process.env.E2E_PORT ?? "3097", 10);
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./e2e-study-notes",
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  reporter: "list",
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
