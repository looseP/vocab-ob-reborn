/**
 * 作文子空间 v1 · 真环境闭环冒烟（W7/W8/W9 联合验收）
 *
 * 栈：SERVE_FRONTEND=true 单进程（SPA + API）+ 独立验收库 vocab_writing_test。
 * 覆盖：开始→保存→提交→（agent 真实 HTTP 评阅）→刷新反馈→定位→第二稿→对照→
 * 关闭→URL 重开第一稿→F5（库核：零新增 draft）→导出（真实下载）；含手机 390×844
 * 与暗色截图（产物在 WRITING_SHOT_DIR，默认 D:/tmp/ws7-acceptance）。
 *
 * 默认跳过（不阻塞 CI 的既有 Browser E2E）；本机验收：
 *   E2E_WRITING_SMOKE=1 npx playwright test e2e/writing.spec.ts
 * 需要：运行中的 3099 服务（AGENT_API_TOKENS 含 agent-a）+ E2E_SETUP_DATABASE_URL。
 */
import { expect, test } from "@playwright/test";
import pg from "pg";
import { mkdirSync, readFileSync } from "node:fs";

const OWNER_TOKEN = process.env.E2E_OWNER_TOKEN ?? "test-owner-token-for-e2e-0123456789";
const AGENT_TOKEN = process.env.E2E_AGENT_TOKEN ?? "";
const ADMIN_DB_URL = process.env.E2E_SETUP_DATABASE_URL ?? process.env.DATABASE_URL ?? "";
const SHOT_DIR = process.env.WRITING_SHOT_DIR ?? "D:/tmp/ws7-acceptance";
const ENABLED = process.env.E2E_WRITING_SMOKE === "1";

// 桌面关键截图按 S§8 基线（1440×900）；手机尺寸在用例内单独开 context（390×844）。
test.use({ viewport: { width: 1440, height: 900 } });

async function withAdmin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: ADMIN_DB_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function writingRowCounts(taskId: string): Promise<{ sheets: number; drafts: number; attempts: number; feedback: number }> {
  return withAdmin(async (client) => {
    const sheets = await client.query("SELECT count(*)::int AS c FROM l3_submissions WHERE writing_task_id = $1", [taskId]);
    const drafts = await client.query("SELECT count(*)::int AS c FROM l3_submissions WHERE writing_task_id = $1 AND status = 'draft'", [taskId]);
    const attempts = await client.query("SELECT count(*)::int AS c FROM l3_question_attempts WHERE sheet_id IN (SELECT id FROM l3_submissions WHERE writing_task_id = $1)", [taskId]);
    const feedback = await client.query("SELECT count(*)::int AS c FROM l3_writing_feedback WHERE sheet_id IN (SELECT id FROM l3_submissions WHERE writing_task_id = $1)", [taskId]);
    return {
      sheets: sheets.rows[0].c as number,
      drafts: drafts.rows[0].c as number,
      attempts: attempts.rows[0].c as number,
      feedback: feedback.rows[0].c as number,
    };
  });
}

test("开始→保存→提交→评阅→刷新→第二稿→对照→回看→F5（真实浏览器+HTTP+PG）", async ({ page, context, request }) => {
  test.skip(!ENABLED, "writing smoke gated behind E2E_WRITING_SMOKE=1 (W10 will wire CI)");
  mkdirSync(SHOT_DIR, { recursive: true });

  // ── 登录（UI 表单 → 会话 cookie）──────────────────────────────────────
  await page.goto("/");
  await page.fill("#owner-token", OWNER_TOKEN);
  const loginWait = page.waitForResponse((response) =>
    response.url().endsWith("/api/auth/session") && response.request().method() === "POST");
  await page.click('button[type="submit"]');
  expect((await loginWait).status()).toBe(201);
  await expect(page.locator(".session-toolbar")).toBeVisible({ timeout: 10_000 });

  // ── 入口：Home 卡片 → 作文（1 次点击）──────────────────────────────────
  await page.click('a[href="/l3?section=writing"]');
  await expect(page.getByRole("heading", { name: "作文" })).toBeVisible();
  await page.screenshot({ path: `${SHOT_DIR}/01-writing-list-desktop.png` });

  // ── 开始写作（弹层=第 2 次主要点击；创建后光标进入正文）────────────────
  await page.getByRole("button", { name: "开始写作" }).first().click();
  await page.getByLabel("题目说明").fill("真环境冒烟：谈谈技术如何改变学习。");
  await page.getByRole("button", { name: "开始写作" }).last().click();
  const textarea = page.getByRole("textbox", { name: "作文正文" });
  await expect(textarea).toBeVisible();
  expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe("作文正文");

  // ── 输入 → 自动保存 ────────────────────────────────────────────────────
  const firstText = "第一段：技术让学习更便利。\n\n第二段：但也会带来分心，需要自律。";
  await textarea.fill(firstText);
  await expect(page.getByText(/保存状态：已保存/)).toBeVisible({ timeout: 10_000 });
  const url1 = new URL(page.url());
  const sheet1 = url1.searchParams.get("sheet")!;
  const taskId = url1.searchParams.get("writingTaskId")!;
  expect(sheet1).toBeTruthy();
  await page.screenshot({ path: `${SHOT_DIR}/02-editor-saved-desktop.png` });

  // ── 提交（进入只读）────────────────────────────────────────────────────
  await page.getByRole("button", { name: "提交本稿" }).click();
  await expect(page.getByText(/已提交（只读）/)).toBeVisible({ timeout: 10_000 });
  await expect(textarea).toHaveAttribute("readonly", "");
  await page.screenshot({ path: `${SHOT_DIR}/03-sealed-awaiting-feedback-desktop.png` });

  // ── agent 步骤：真实 HTTP（context 读 + feedback 写；确定性 payload）───
  const sha = await page.evaluate(async (hashInput: string) => {
    const data = new TextEncoder().encode(hashInput);
    const digest = await crypto.subtle.digest("SHA-256", data);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }, firstText);
  const ctxRes = await request.get(`/api/l3/writing/tasks/${taskId}/sheets/${sheet1}/feedback-context`, {
    headers: { Authorization: `Bearer ${AGENT_TOKEN}` },
  });
  expect(ctxRes.status()).toBe(200);
  const ctx = await ctxRes.json();
  expect(ctx.text).toBe(firstText);
  expect(ctx.textSha256).toBe(sha);
  expect(ctx.revisionNo).toBe(1);
  expect(ctx.feedbackVersion).toBe(0);

  const anchorQuote = "但也会带来分心";
  const anchorStart = firstText.indexOf(anchorQuote);
  const putRes = await request.put(`/api/l3/writing/tasks/${taskId}/sheets/${sheet1}/feedback`, {
    headers: { Authorization: `Bearer ${AGENT_TOKEN}`, "Content-Type": "application/json" },
    data: {
      expectedVersion: 0,
      textSha256: sha,
      requestId: crypto.randomUUID(),
      feedback: {
        schemaVersion: 1,
        summary: "结构清楚；第二段可补一个具体例子。",
        strengths: ["立场明确"],
        dimensions: {
          task_response: { applicable: true, comment: "回应了题目。" },
          organization: { applicable: true, comment: "两段结构可辨。" },
          language: { applicable: true, comment: "基本通顺。" },
          expression: { applicable: false, comment: "本稿不评表达风格。" },
        },
        priorities: [{
          id: "p1",
          dimension: "task_response",
          observation: "第二段只下结论，没有具体例子。",
          action: "补充一个自己亲历的例子。",
          anchor: { start: anchorStart, end: anchorStart + anchorQuote.length, quote: anchorQuote },
        }],
      },
    },
  });
  expect(putRes.status()).toBe(200);
  expect((await putRes.json()).version).toBe(1);

  // ── 手动刷新 → 反馈可见 → 定位跳转（UTF-16）────────────────────────────
  await page.getByRole("button", { name: "刷新反馈" }).click();
  await expect(page.getByText(/结构清楚；第二段可补一个具体例子/)).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: "跳至原句" }).click();
  const selection = await page.evaluate(() => {
    const el = document.getElementById("writing-draft-textarea") as HTMLTextAreaElement;
    return { start: el.selectionStart, end: el.selectionEnd, text: el.value.slice(el.selectionStart, el.selectionEnd) };
  });
  expect(selection.text).toBe(anchorQuote);
  await page.screenshot({ path: `${SHOT_DIR}/04-feedback-visible-desktop.png` });

  // ── 第二稿：默认复制父稿 → 修改 → 提交 ─────────────────────────────────
  await page.getByRole("button", { name: "开始修改（第二稿）" }).click();
  const textarea2 = page.getByRole("textbox", { name: "作文正文" });
  await expect(textarea2).toBeVisible();
  await expect(textarea2).toHaveValue(firstText); // 默认拷贝父稿正文
  const secondText = `${firstText}\n\n第三段：例如复习时用间隔重复，效果明显。`;
  await textarea2.fill(secondText);
  await expect(page.getByText(/保存状态：已保存/)).toBeVisible({ timeout: 10_000 });
  const sheet2 = new URL(page.url()).searchParams.get("sheet")!;
  expect(sheet2).not.toBe(sheet1);
  await page.getByRole("button", { name: "提交本稿" }).click();
  await expect(page.getByText(/已提交（只读）/)).toBeVisible({ timeout: 10_000 });

  // ── 对照：当前（第二稿）对第一稿；两稿反馈独立 ─────────────────────────
  await page.getByRole("button", { name: "与当前稿对照" }).first().click();
  await expect(page.getByRole("heading", { name: "双稿对照" })).toBeVisible();
  await expect(page.getByText(/反馈（v1）：/)).toBeVisible();
  await expect(page.getByText(/本稿尚无反馈。/)).toBeVisible(); // 第二稿未评，未借用
  await page.screenshot({ path: `${SHOT_DIR}/05-compare-desktop.png` });

  // ── 关闭 → URL 重开第一稿 → F5：同 sheet、反馈随稿、库零新增 draft ─────
  const before = await writingRowCounts(taskId);
  expect(before).toMatchObject({ drafts: 0, attempts: 2, feedback: 1 });
  await page.goto(`/l3?section=writing&writingTaskId=${taskId}&sheet=${sheet1}`);
  const reTextarea = page.getByRole("textbox", { name: "作文正文" });
  await expect(reTextarea).toHaveValue(firstText);
  await expect(page.getByText(/结构清楚；第二段可补一个具体例子/)).toBeVisible();
  await page.reload();
  expect(page.url()).toContain(`sheet=${sheet1}`);
  await expect(page.getByRole("textbox", { name: "作文正文" })).toHaveValue(firstText);
  const after = await writingRowCounts(taskId);
  expect(after).toEqual(before); // F5 零新增（sheets/drafts/attempts/feedback 全等）
  await page.screenshot({ path: `${SHOT_DIR}/06-reentry-first-revision-desktop.png` });

  // ── 导出：真实下载 + JSON 可提取 + 反引号安全 ──────────────────────────
  const downloadWait = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出本稿" }).click();
  const download = await downloadWait;
  expect(download.suggestedFilename()).toBe(`writing-${sheet1}.md`);
  const markdown = readFileSync((await download.path())!, "utf8");
  expect(markdown).toContain('"exportSchemaVersion": 1');
  expect(markdown).toContain("但也会带来分心");

  // ── 手机 390×844（页签切换不丢内容）+ 暗色 ─────────────────────────────
  const mobileContext = await context.browser()!.newContext({
    viewport: { width: 390, height: 844 },
    storageState: await context.storageState(),
  });
  const mobile = await mobileContext.newPage();
  await mobile.goto(`/l3?section=writing&writingTaskId=${taskId}&sheet=${sheet1}`);
  await expect(mobile.getByRole("textbox", { name: "作文正文" })).toHaveValue(firstText);
  await mobile.screenshot({ path: `${SHOT_DIR}/07-first-revision-mobile-390x844.png` });
  await mobile.getByRole("tab", { name: "反馈" }).click();
  await expect(mobile.getByText(/结构清楚；第二段可补一个具体例子/)).toBeVisible();
  await mobile.screenshot({ path: `${SHOT_DIR}/08-feedback-mobile-light.png` });
  await mobileContext.close();

  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  await page.screenshot({ path: `${SHOT_DIR}/09-reentry-dark-desktop.png` });

  // ── 清理（保留可复核的库断言结果；删除本次冒烟数据）────────────────────
  const cleanup = await withAdmin(async (client) => {
    await client.query("DELETE FROM l3_writing_feedback WHERE user_id = $1::uuid", ["00000000-0000-1000-8000-000000000001"]);
    await client.query("DELETE FROM l3_question_attempts WHERE user_id = $1::uuid", ["00000000-0000-1000-8000-000000000001"]);
    await client.query("DELETE FROM l3_submissions WHERE user_id = $1::uuid", ["00000000-0000-1000-8000-000000000001"]);
    await client.query("DELETE FROM l3_writing_tasks WHERE user_id = $1::uuid", ["00000000-0000-1000-8000-000000000001"]);
    await client.query("DELETE FROM l3_questions WHERE user_id = $1::uuid AND file_key LIKE 'writing:%'", ["00000000-0000-1000-8000-000000000001"]);
    return true;
  });
  expect(cleanup).toBe(true);
});
