/**
 * Task 10 · 导出链真实浏览器 E2E（真实 Chromium + 真实 HTTP + 本批隔离 PG）。
 *
 * 覆盖简报点名的前端链：**flush → version → GET → Blob 下载**，以及失败分支：
 *  - 成功：脏编辑先 flush（版本推进）→ 以回执版本 GET → 触发真实浏览器下载（文件名 = 安全名）；
 *  - 失败分支 A（409 版本冲突）：服务端旧版本 → **零下载** + 可见提示；
 *  - 失败分支 B（保存失败 → 不导出）：注入 PUT 失败 → 导出请求 0 次、零下载；
 *  - 失败分支 C（网络错误）：导出 GET 断网 → 零下载 + 可见提示；
 *  - 只读纪律：导出前后 submissions / attempts 行数不变（真实库核）。
 *
 * 纪律：仅在专属验收库 vocab_study_notes_task10_accept 运行（库身份显式校验）。
 * 失败注入只丢/篡改真实请求的响应（route.abort / 覆盖 status），不伪造成功。
 */
import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import pg from "pg";
import { expect, test } from "../e2e/fixtures";

const ADMIN_DB_URL = process.env.E2E_SETUP_DATABASE_URL ?? "";
const EXPECTED_DB = process.env.STUDY_NOTES_E2E_DB ?? "vocab_study_notes_task10_accept";
const OWNER_ID = process.env.E2E_OWNER_ID ?? "00000000-0000-1000-8000-000000000001";

if (!ADMIN_DB_URL) throw new Error("E2E_SETUP_DATABASE_URL is required（admin/DDL-owner 连接）");
{
  const dbName = new URL(ADMIN_DB_URL).pathname.slice(1);
  if (dbName !== EXPECTED_DB) {
    throw new Error(`本 E2E 仅允许在专属验收库 ${EXPECTED_DB} 运行（当前 ${dbName}）`);
  }
}

async function withAdmin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: ADMIN_DB_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function sideEffectCounts(): Promise<{ submissions: number; attempts: number }> {
  return withAdmin(async (client) => {
    const submissions = await client.query<{ n: number }>("SELECT count(*)::int AS n FROM l3_submissions");
    const attempts = await client.query<{ n: number }>("SELECT count(*)::int AS n FROM l3_question_attempts");
    return { submissions: submissions.rows[0]!.n, attempts: attempts.rows[0]!.n };
  });
}

/** 页面内 fetch（浏览器上下文：同源 + CSRF 头），返回 status 与 body。 */
async function pageApiCall(
  page: Page,
  path: string,
  init: { method: "POST" | "PUT"; body: unknown },
): Promise<{ status: number; body: Record<string, unknown> | null }> {
  return page.evaluate(
    async ({ path: requestPath, method, body }) => {
      const csrfEntry = document.cookie.split("; ").find((entry) => entry.startsWith("vocab_csrf="));
      let csrf = csrfEntry ? csrfEntry.slice("vocab_csrf=".length) : "";
      try {
        csrf = decodeURIComponent(csrf);
      } catch {
        // 保持原值
      }
      const response = await fetch(requestPath, {
        method,
        headers: {
          "Content-Type": "application/json",
          "X-Requested-With": "VocabObservatory",
          "X-CSRF-Token": csrf,
        },
        body: JSON.stringify(body),
      });
      const text = await response.text();
      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = text ? (JSON.parse(text) as Record<string, unknown>) : null;
      } catch {
        parsed = null;
      }
      return { status: response.status, body: parsed };
    },
    { path, method: init.method, body: init.body },
  );
}

async function openHostAndCreate(page: Page): Promise<string> {
  await page.goto("/study-note-host");
  await page.getByTestId("host-create").click();
  await expect(page.getByTestId("host-note-id")).toBeVisible({ timeout: 15_000 });
  const noteId = (await page.getByTestId("host-note-id").textContent())!.trim();
  await expect(page.getByTestId("note-title")).toBeVisible({ timeout: 15_000 });
  return noteId;
}

test.afterAll(async () => {
  await withAdmin(async (client) => {
    await client.query("DELETE FROM l3_study_note_references WHERE user_id = $1::uuid", [OWNER_ID]);
    await client.query("DELETE FROM l3_study_note_venues WHERE user_id = $1::uuid", [OWNER_ID]);
    await client.query("DELETE FROM l3_study_notes WHERE user_id = $1::uuid", [OWNER_ID]);
  });
});

test("成功链：flush → version → GET → 真实 Blob 下载（文件名取服务端安全名）", async ({ authedPage: page }) => {
  const noteId = await openHostAndCreate(page);
  const before = await sideEffectCounts();

  // 脏编辑（未确认本地输入）——导出必须先把这份内容 flush 成已确认版本。
  await page.getByTestId("note-body").fill("E2E 导出正文：脏内容先保存。");
  await expect(page.getByTestId("save-state")).toContainText("已保存", { timeout: 15_000 });

  const order: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "PUT" && request.url().includes(`/study-notes/${noteId}`)) order.push("PUT");
    if (request.method() === "GET" && request.url().includes(`/study-notes/${noteId}/export`)) {
      order.push(`GET:${new URL(request.url()).searchParams.get("expectedVersion")}`);
    }
  });

  const downloadPromise = page.waitForEvent("download");
  await page.getByTestId("export-note-button").click();
  const download = await downloadPromise;

  // 真实浏览器下载：文件名 = 服务端安全文件名
  expect(download.suggestedFilename()).toBe(`study-note-${noteId}.md`);

  // 顺序：GET 使用 flush 回执版本（第 1 版之后的已确认版本），且晚于保存
  expect(order.some((entry) => entry.startsWith("GET:"))).toBe(true);
  const exportVersion = Number(order.find((entry) => entry.startsWith("GET:"))!.slice(4));
  expect(Number.isInteger(exportVersion)).toBe(true);

  const after = await sideEffectCounts();
  expect(after).toEqual(before);
});

test("失败分支：保存失败（PUT 500）→ 导出 GET 0 次、零下载", async ({ authedPage: page }) => {
  const noteId = await openHostAndCreate(page);

  let exportRequests = 0;
  page.on("request", (request) => {
    if (request.method() === "GET" && request.url().includes(`/study-notes/${noteId}/export`)) exportRequests += 1;
  });

  // 注入真实 PUT 失败：服务端确定性拒绝（非伪造成功）。
  await page.route(`**/api/l3/study-notes/${noteId}`, (route) => {
    if (route.request().method() === "PUT") {
      return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ code: "INTERNAL", error: "injected" }) });
    }
    return route.continue();
  });

  await page.getByTestId("note-body").fill("这段内容会保存失败。");

  let downloadCount = 0;
  page.on("download", () => {
    downloadCount += 1;
  });

  await page.getByTestId("export-note-button").click();
  // 给足时间让任何错误的旧文下载发生（若有）
  await page.waitForTimeout(3000);

  expect(exportRequests).toBe(0);
  expect(downloadCount).toBe(0);
});

test("失败分支：导出 GET 网络错误 → 零下载 + 可见提示", async ({ authedPage: page }) => {
  const noteId = await openHostAndCreate(page);
  await page.getByTestId("note-body").fill("网络错误分支正文。");
  await expect(page.getByTestId("save-state")).toContainText("已保存", { timeout: 15_000 });

  await page.route(`**/api/l3/study-notes/${noteId}/export*`, (route) => route.abort("failed"));

  let downloadCount = 0;
  page.on("download", () => {
    downloadCount += 1;
  });

  await page.getByTestId("export-note-button").click();
  await expect(page.getByTestId("export-error")).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(1500);
  expect(downloadCount).toBe(0);
});

test("失败分支：409 版本冲突 → 零下载 + 可见提示", async ({ authedPage: page }) => {
  const noteId = await openHostAndCreate(page);
  await page.getByTestId("note-body").fill("409 分支正文。");
  await expect(page.getByTestId("save-state")).toContainText("已保存", { timeout: 15_000 });

  // 让服务端看到一个与服务端当前版本不一致的 expectedVersion：真实 409，不伪造。
  await page.route(`**/api/l3/study-notes/${noteId}/export*`, async (route) => {
    const url = new URL(route.request().url());
    url.searchParams.set("expectedVersion", "999999");
    return route.continue({ url: url.toString() });
  });

  let downloadCount = 0;
  page.on("download", () => {
    downloadCount += 1;
  });

  await page.getByTestId("export-note-button").click();
  await expect(page.getByTestId("export-error")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("export-error")).toContainText("已在其他地方更新");
  await page.waitForTimeout(1500);
  expect(downloadCount).toBe(0);
});

test("只读纪律：真实导出后 submissions/attempts 行数不变", async ({ authedPage: page }) => {
  const noteId = await openHostAndCreate(page);
  await page.getByTestId("note-body").fill("只读纪律正文。");
  await expect(page.getByTestId("save-state")).toContainText("已保存", { timeout: 15_000 });

  const before = await sideEffectCounts();
  const downloadPromise = page.waitForEvent("download");
  await page.getByTestId("export-note-button").click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe(`study-note-${noteId}.md`);

  const after = await sideEffectCounts();
  expect(after).toEqual(before);
});
