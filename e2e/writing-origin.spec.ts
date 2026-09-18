/**
 * 作文-试卷台整合 · 来源闭环 E2E（B/C 批验收，进入 Writing E2E 必需检查）
 *
 * 栈：与 e2e/writing.spec.ts 同款——SERVE_FRONTEND=true 单进程（SPA + API）+ 独立验收库；
 * 由 `.github/workflows/writing-e2e.yml` 与 writing.spec.ts 一并执行，validator 固定收集数
 * 7（4 + 3）fail-closed（PROCESS/global errors/收集/跳过/失败 五查，不放宽）。
 *
 * 覆盖（合成数据 seed 于库内，practice:e2e- 前缀；每测前清理本 spec 造物，retry 幂等）：
 *  ① fileKey 原题闭环：开始 → 保存 → 返回见「继续写作」+ 定位高亮 → 继续同稿 → F5 → 返回
 *     （库核：仅显式开始 +task/+sheet；返回/继续/F5 零新增）；含小屏 390×844 动线。
 *  ② 整卷（客观 + 写作）：点选项（防抖在途）→ 立即「开始写作」→ **保存屏障先行落库** →
 *     返回原题 resumeSheet 按 ID 恢复（同纸、选择保留、零新增、零判定泄漏）。
 *  ③ agent 真实 HTTP 写反馈 → 返回原题显示「已有反馈」→ 查看第一稿 → 开始修改 → 第二稿
 *     提交 → 对照（两稿反馈独立）→ 回看第一稿（不串稿）；origin 随提交/对照/换稿保留。
 */
import { expect, test } from "@playwright/test";
import pg from "pg";
import { mkdirSync } from "node:fs";
import { E2E_OWNER_ID } from "./constants";

const OWNER_TOKEN = process.env.E2E_OWNER_TOKEN ?? "test-owner-token-for-e2e-0123456789";
const AGENT_TOKEN = process.env.E2E_AGENT_TOKEN ?? "";
const ADMIN_DB_URL = process.env.E2E_SETUP_DATABASE_URL ?? process.env.DATABASE_URL ?? "";
const SHOT_DIR = process.env.WRITING_SHOT_DIR ?? "D:/tmp/ws7-acceptance";
const ENABLED = process.env.E2E_WRITING_SMOKE === "1";
const SKIP_REASON = "origin loop e2e gated behind E2E_WRITING_SMOKE=1";

test.use({ viewport: { width: 1440, height: 900 } });

// 固定合成 id（幂等：retry / 重跑复用同库；cleanup 按本集合精确清理）
const FILE_B = "practice:e2e-小作文闭环";
const Q_B1 = "00000000-0000-4000-8000-00000000e101";
const Q_B2 = "00000000-0000-4000-8000-00000000e102";
const PAPER = "00000000-0000-4000-8000-00000000e201";
const Q_OBJ = "00000000-0000-4000-8000-00000000e202";
const Q_ESSAY = "00000000-0000-4000-8000-00000000e203";
const FILE_F = "practice:e2e-反馈闭环";
const Q_F = "00000000-0000-4000-8000-00000000e301";
const ALL_QUESTIONS = [Q_B1, Q_B2, Q_OBJ, Q_ESSAY, Q_F];

async function withAdmin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: ADMIN_DB_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** UI 表单登录（#owner-token → 会话 cookie；与 e2e/fixtures.ts 同款）。 */
async function login(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/");
  await page.fill("#owner-token", OWNER_TOKEN);
  const loginWait = page.waitForResponse((response) =>
    response.url().endsWith("/api/auth/session") && response.request().method() === "POST");
  await page.click('button[type="submit"]');
  expect((await loginWait).status()).toBe(201);
  await expect(page.locator(".session-toolbar")).toBeVisible({ timeout: 10_000 });
}

/** 精确清理本 spec 造物（写作链按任务题面归属；整卷原纸按 paper_id）。 */
async function cleanupSynthetic(): Promise<void> {
  await withAdmin(async (client) => {
    const writingSheets = `SELECT s.id FROM l3_submissions s WHERE s.writing_task_id IN (
      SELECT t.id FROM l3_writing_tasks t WHERE t.question_id = ANY($1::uuid[]))`;
    await client.query(`DELETE FROM l3_writing_feedback WHERE sheet_id IN (${writingSheets})`, [ALL_QUESTIONS]);
    await client.query(`DELETE FROM l3_question_attempts WHERE sheet_id IN (${writingSheets})`, [ALL_QUESTIONS]);
    await client.query(`DELETE FROM l3_submissions WHERE writing_task_id IN (
      SELECT t.id FROM l3_writing_tasks t WHERE t.question_id = ANY($1::uuid[]))`, [ALL_QUESTIONS]);
    await client.query("DELETE FROM l3_writing_tasks WHERE question_id = ANY($1::uuid[])", [ALL_QUESTIONS]);
    await client.query("DELETE FROM l3_question_attempts WHERE sheet_id IN (SELECT id FROM l3_submissions WHERE paper_id = $1::uuid)", [PAPER]);
    await client.query("DELETE FROM l3_submissions WHERE paper_id = $1::uuid", [PAPER]);
  });
}

async function insertEssayQuestion(id: string, fileKey: string, stem: string): Promise<void> {
  await withAdmin(async (client) => {
    await client.query(
      `INSERT INTO l3_questions (id, user_id, source_id, file_key, space, question_type, ordinal, stem, options, answer, explanation, evidence, status, created_by)
       VALUES ($1::uuid, $2::uuid, NULL, $3, '作文', 'short_essay', 0, $4, '[]'::jsonb, '{"sample":"E2E 合成范文"}'::jsonb, NULL, '[]'::jsonb, 'active', 'owner')
       ON CONFLICT (id) DO NOTHING`,
      [id, E2E_OWNER_ID, fileKey, stem],
    );
  });
}

async function seedEssays(): Promise<void> {
  await insertEssayQuestion(Q_B1, FILE_B, "47. E2E 小作文题干 A（来源闭环）");
  await insertEssayQuestion(Q_B2, FILE_B, "48. E2E 小作文题干 B（同文件第二题）");
  await insertEssayQuestion(Q_F, FILE_F, "49. E2E 小作文题干 F（反馈闭环）");
}

async function seedPaper(): Promise<void> {
  await withAdmin(async (client) => {
    await client.query(
      `INSERT INTO l3_questions (id, user_id, source_id, file_key, space, question_type, ordinal, stem, options, answer, explanation, evidence, status, created_by)
       VALUES ($1::uuid, $2::uuid, NULL, 'practice:e2e-整卷客观', '阅读', 'reading_choice', 0,
               '1. E2E 客观例题：选乙（B）。', '[{"key":"A","text":"甲"},{"key":"B","text":"乙"},{"key":"C","text":"丙"},{"key":"D","text":"丁"}]'::jsonb,
               '{"choice":"B"}'::jsonb, NULL, '[]'::jsonb, 'active', 'owner')
       ON CONFLICT (id) DO NOTHING`,
      [Q_OBJ, E2E_OWNER_ID],
    );
    await client.query(
      `INSERT INTO l3_questions (id, user_id, source_id, file_key, space, question_type, ordinal, stem, options, answer, explanation, evidence, status, created_by)
       VALUES ($1::uuid, $2::uuid, NULL, 'practice:e2e-整卷写作', '作文', 'short_essay', 0,
               '47. E2E 整卷写作题干（专项练习不计入本卷）。', '[]'::jsonb, '{"sample":"E2E 合成范文"}'::jsonb, NULL, '[]'::jsonb, 'active', 'owner')
       ON CONFLICT (id) DO NOTHING`,
      [Q_ESSAY, E2E_OWNER_ID],
    );
    await client.query(
      `INSERT INTO l3_papers (id, user_id, title, direction, metadata, payload, payload_version, status, created_by)
       VALUES ($1::uuid, $2::uuid, 'practice:e2e-合成整卷（客观 + 写作）', '考研', '{}'::jsonb,
               '{"version":1,"sections":[
                  {"key":"p1","title":"客观练习（E2E）","fileKey":null,"sourceId":null,
                   "questionIds":["${Q_OBJ}"],"questionType":"reading_choice"},
                  {"key":"p2","title":"写作（E2E）","fileKey":null,"sourceId":null,
                   "questionIds":["${Q_ESSAY}"],"questionType":"short_essay"}
                ]}'::jsonb, 1, 'active', 'owner')
       ON CONFLICT (id) DO NOTHING`,
      [PAPER, E2E_OWNER_ID],
    );
  });
}

/** 写作链计数（严格限定本 spec 的题面集合）。 */
async function originCounts(): Promise<{ tasks: number; sheets: number }> {
  return withAdmin(async (client) => {
    const tasks = await client.query(
      "SELECT count(*)::int AS c FROM l3_writing_tasks WHERE question_id = ANY($1::uuid[])", [ALL_QUESTIONS]);
    const sheets = await client.query(
      `SELECT count(*)::int AS c FROM l3_submissions WHERE writing_task_id IN (
         SELECT t.id FROM l3_writing_tasks t WHERE t.question_id = ANY($1::uuid[]))`, [ALL_QUESTIONS]);
    return { tasks: tasks.rows[0].c as number, sheets: sheets.rows[0].c as number };
  });
}

/** 整卷原纸状态（paper 作用域）。 */
async function venueState(): Promise<{ sheets: number; sheetId: string | null; pick: string; attempts: number }> {
  return withAdmin(async (client) => {
    const sheets = await client.query(
      "SELECT id, coalesce(answers->$2->>'choice','-') AS pick FROM l3_submissions WHERE paper_id = $1::uuid ORDER BY created_at", [PAPER, Q_OBJ]);
    const attempts = await client.query(
      "SELECT count(*)::int AS c FROM l3_question_attempts WHERE question_id = ANY($1::uuid[])", [[Q_OBJ, Q_ESSAY]]);
    const first = sheets.rows[0] as { id: string; pick: string } | undefined;
    return { sheets: sheets.rowCount ?? 0, sheetId: first?.id ?? null, pick: first?.pick ?? "-", attempts: attempts.rows[0].c as number };
  });
}

async function sha256InPage(page: import("@playwright/test").Page, text: string): Promise<string> {
  return page.evaluate(async (hashInput: string) => {
    const data = new TextEncoder().encode(hashInput);
    const digest = await crypto.subtle.digest("SHA-256", data);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }, text);
}

/** agent 真实 HTTP 写反馈（写域唯一入口；不写「AI 已评阅」话术，内容全部可核）。 */
async function putFeedback(
  request: import("@playwright/test").APIRequestContext,
  taskId: string,
  sheetId: string,
  sha: string,
  input: { summary: string; quote: string; text: string },
): Promise<number> {
  const start = input.text.indexOf(input.quote);
  expect(start).toBeGreaterThanOrEqual(0);
  const res = await request.put(`/api/l3/writing/tasks/${taskId}/sheets/${sheetId}/feedback`, {
    headers: { Authorization: `Bearer ${AGENT_TOKEN}`, "Content-Type": "application/json" },
    data: {
      expectedVersion: 0,
      textSha256: sha,
      requestId: crypto.randomUUID(),
      feedback: {
        schemaVersion: 1,
        summary: input.summary,
        strengths: ["E2E 强度项"],
        dimensions: {
          task_response: { applicable: true, comment: "回应了题目。" },
          organization: { applicable: true, comment: "结构可辨。" },
          language: { applicable: true, comment: "基本通顺。" },
          expression: { applicable: false, comment: "本稿不评表达风格。" },
        },
        priorities: [{
          id: "p1",
          dimension: "task_response",
          observation: "E2E 观察项。",
          action: "E2E 行动项。",
          anchor: { start, end: start + input.quote.length, quote: input.quote },
        }],
      },
    },
  });
  return res.status();
}

test("B｜fileKey 原题 → 开始 → 保存 → 返回见继续 → 继续同稿 → F5（库核零新增）+ 小屏动线", async ({ page }) => {
  test.skip(!ENABLED, SKIP_REASON);
  mkdirSync(SHOT_DIR, { recursive: true });
  await cleanupSynthetic();
  await seedEssays();
  await login(page);

  const before = await originCounts();
  const originUrl = `/l3?venue=short_essay&file=${encodeURIComponent(FILE_B)}&question=${Q_B1}`;
  await page.goto(originUrl);
  const q1 = page.locator(`[data-question-id="${Q_B1}"]`);
  const q2 = page.locator(`[data-question-id="${Q_B2}"]`);
  await expect(q1.getByRole("button", { name: "开始写作" })).toBeVisible({ timeout: 15_000 });
  await expect(q2.getByRole("button", { name: "开始写作" })).toBeVisible();
  await page.screenshot({ path: `${SHOT_DIR}/origin-01-file-entries.png` });

  // 开始（唯一显式创建路径）
  await q1.getByRole("button", { name: "开始写作" }).click();
  const textarea = page.getByRole("textbox", { name: "作文正文" });
  await expect(textarea).toBeVisible({ timeout: 15_000 });
  const url1 = new URL(page.url());
  const taskId = url1.searchParams.get("writingTaskId")!;
  const sheet1 = url1.searchParams.get("sheet")!;
  expect(url1.searchParams.get("origin")).toBeTruthy();

  const text1 = "第一段：E2E 来源闭环正文。\n\n第二段：返回原题、继续同稿、刷新保留。";
  await textarea.fill(text1);
  await expect(page.getByText(/保存状态：已保存/)).toBeVisible({ timeout: 15_000 });
  const afterStart = await originCounts();
  expect(afterStart).toEqual({ tasks: before.tasks + 1, sheets: before.sheets + 1 });
  await page.screenshot({ path: `${SHOT_DIR}/origin-02-workspace-saved.png` });

  // 返回原题：见「继续写作」+ ?question= 定位高亮；零新增
  await page.getByRole("button", { name: "返回原题" }).click();
  await expect(q1.getByRole("button", { name: "继续写作" })).toBeVisible({ timeout: 15_000 });
  const backUrl = new URL(page.url());
  expect(backUrl.searchParams.get("file")).toBe(FILE_B);
  expect(backUrl.searchParams.get("question")).toBe(Q_B1);
  expect(backUrl.searchParams.get("section")).toBeNull();
  await expect(page.locator(`[data-question-id="${Q_B1}"][data-focused="true"]`)).toHaveCount(1);
  expect(await originCounts()).toEqual(afterStart);
  await page.screenshot({ path: `${SHOT_DIR}/origin-03-back-continue.png` });

  // 继续同稿（同 sheet；零新增）
  await q1.getByRole("button", { name: "继续写作" }).click();
  await expect(textarea).toHaveValue(text1);
  expect(new URL(page.url()).searchParams.get("sheet")).toBe(sheet1);
  expect(await originCounts()).toEqual(afterStart);

  // F5 同稿（正文保留；零新增）
  await page.reload();
  await expect(textarea).toHaveValue(text1);
  expect(new URL(page.url()).searchParams.get("sheet")).toBe(sheet1);
  expect(await originCounts()).toEqual(afterStart);

  // 小屏 390×844：原题入口 + 来源条 + 返回 + 稿次操作
  const mobileContext = await page.context().browser()!.newContext({
    viewport: { width: 390, height: 844 },
    storageState: await page.context().storageState(),
  });
  const mp = await mobileContext.newPage();
  await mp.goto(originUrl);
  const mq1 = mp.locator(`[data-question-id="${Q_B1}"]`);
  await expect(mq1.getByRole("button", { name: "继续写作" })).toBeVisible({ timeout: 15_000 });
  await mq1.getByRole("button", { name: "继续写作" }).click();
  await expect(mp.getByText(/专项写作 · 来自小作文/)).toBeVisible({ timeout: 15_000 });
  await expect(mp.getByRole("button", { name: "返回原题" })).toBeVisible();
  await mp.getByRole("tab", { name: "反馈" }).click();
  await expect(mp.getByRole("heading", { name: "稿次" })).toBeVisible();
  await mp.screenshot({ path: `${SHOT_DIR}/origin-04-mobile-390x844.png` });
  await mobileContext.close();

  void taskId; // 已用于断言链；保留变量以便排障时对照
});

test("C｜整卷：保存屏障先行落库 → 返回原题 resumeSheet 按 ID 恢复（同纸、选择保留、零新增）", async ({ page }) => {
  test.skip(!ENABLED, SKIP_REASON);
  mkdirSync(SHOT_DIR, { recursive: true });
  await cleanupSynthetic();
  await seedEssays();
  await seedPaper();
  await login(page);

  await page.goto(`/l3?paper=${PAPER}`);
  await expect(page.getByText("题纸", { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("专项练习（不计入本次试卷作答）")).toBeVisible();
  const v0 = await venueState();
  expect(v0).toMatchObject({ sheets: 1, pick: "-", attempts: 0 });
  await page.screenshot({ path: `${SHOT_DIR}/origin-05-paper-entry.png` });

  // 点选项乙（防抖在途）→ 立即「开始写作」：屏障必须先行完成落库
  const patchWait = page.waitForResponse((r) => r.url().includes("/l3/sheets/") && r.request().method() === "PATCH");
  await page.getByRole("button", { name: /乙/ }).click();
  await page.getByRole("button", { name: "开始写作" }).click();
  expect((await patchWait).status()).toBe(200);
  const textarea = page.getByRole("textbox", { name: "作文正文" });
  await expect(textarea).toBeVisible({ timeout: 15_000 });
  const v1 = await venueState();
  expect(v1).toMatchObject({ sheets: 1, pick: "B", attempts: 0 }); // 离开前已落库；未另开新纸

  await textarea.fill("C 批 E2E：屏障先行 + 返回同纸恢复。");
  await expect(page.getByText(/保存状态：已保存/)).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "返回原题" }).click();
  await expect(page.getByText("题纸", { exact: true })).toBeVisible({ timeout: 15_000 });
  const backUrl = new URL(page.url());
  expect(backUrl.searchParams.get("paper")).toBe(PAPER);
  expect(backUrl.searchParams.get("question")).toBe(Q_ESSAY);
  expect(backUrl.searchParams.get("resumeSheet")).toBe(v1.sheetId);
  await expect(page.locator('[data-selected="true"]').first()).toBeVisible();
  const v2 = await venueState();
  expect(v2).toEqual(v1); // 同纸恢复、专项操作零改变原卷（无新纸、选择未动、零判定）
  await page.screenshot({ path: `${SHOT_DIR}/origin-06-paper-resume.png` });
});

test("D｜agent 写反馈 → 返回见已有反馈 → 查看 → 第二稿 → 对照 → 回看（每稿反馈独立）", async ({ page, request }) => {
  test.skip(!ENABLED, SKIP_REASON);
  mkdirSync(SHOT_DIR, { recursive: true });
  await cleanupSynthetic();
  await seedEssays();
  await login(page);

  // 第一稿：开始 → 写 → 提交
  await page.goto(`/l3?venue=short_essay&file=${encodeURIComponent(FILE_F)}&question=${Q_F}`);
  const entry = page.locator(`[data-question-id="${Q_F}"]`);
  await entry.getByRole("button", { name: "开始写作" }).click();
  const textarea = page.getByRole("textbox", { name: "作文正文" });
  await expect(textarea).toBeVisible({ timeout: 15_000 });
  const u1 = new URL(page.url());
  const taskId = u1.searchParams.get("writingTaskId")!;
  const sheet1 = u1.searchParams.get("sheet")!;
  const text1 = "第一段：反馈闭环正文。\n\n第二段：每稿反馈互相独立。";
  await textarea.fill(text1);
  await expect(page.getByText(/保存状态：已保存/)).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "提交本稿" }).click();
  await expect(page.getByText(/已提交（只读）/)).toBeVisible({ timeout: 15_000 });
  expect(new URL(page.url()).searchParams.get("origin")).toBeTruthy(); // 提交后 origin 保留

  // agent 真实 HTTP 写反馈（第一稿）
  const sha1 = await sha256InPage(page, text1);
  expect(await putFeedback(request, taskId, sheet1, sha1, {
    summary: "E2E 第一稿反馈：结构清楚。", quote: "反馈闭环正文", text: text1,
  })).toBe(200);

  // 返回原题：显示「已提交 1 稿 · 已有反馈」→ 查看本稿
  await page.getByRole("button", { name: "返回原题" }).click();
  await expect(entry.getByRole("button", { name: "查看本稿" })).toBeVisible({ timeout: 15_000 });
  await expect(entry.getByText(/已有反馈/)).toBeVisible();
  await page.screenshot({ path: `${SHOT_DIR}/origin-07-feedback-ready.png` });
  await entry.getByRole("button", { name: "查看本稿" }).click();
  await expect(textarea).toBeVisible({ timeout: 15_000 });
  await expect(textarea).toHaveAttribute("readonly", "");
  await expect(page.getByText(/E2E 第一稿反馈：结构清楚/)).toBeVisible({ timeout: 15_000 });
  expect(new URL(page.url()).searchParams.get("sheet")).toBe(sheet1);

  // 第二稿：开始修改（复制父稿）→ 提交 → agent 反馈2
  await page.getByRole("button", { name: "开始修改" }).click();
  const textarea2 = page.getByRole("textbox", { name: "作文正文" });
  await expect(textarea2).toHaveValue(text1);
  const text2 = `${text1}\n\n第三段：第二稿补充例子。`;
  await textarea2.fill(text2);
  await expect(page.getByText(/保存状态：已保存/)).toBeVisible({ timeout: 15_000 });
  const sheet2 = new URL(page.url()).searchParams.get("sheet")!;
  expect(sheet2).not.toBe(sheet1);
  await page.getByRole("button", { name: "提交本稿" }).click();
  await expect(page.getByText(/已提交（只读）/)).toBeVisible({ timeout: 15_000 });
  const sha2 = await sha256InPage(page, text2);
  expect(await putFeedback(request, taskId, sheet2, sha2, {
    summary: "E2E 第二稿反馈：例子到位。", quote: "补充例子", text: text2,
  })).toBe(200);

  // 对照：两稿反馈独立呈现；origin 保留
  await page.getByRole("button", { name: "与当前稿对照" }).first().click();
  await expect(page.getByRole("heading", { name: "双稿对照" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/E2E 第一稿反馈/)).toBeVisible();
  await expect(page.getByText(/E2E 第二稿反馈/)).toBeVisible();
  expect(new URL(page.url()).searchParams.get("origin")).toBeTruthy();
  await page.screenshot({ path: `${SHOT_DIR}/origin-08-compare.png` });

  // 回看第一稿（稿次列表「查看」）：只显示第一稿反馈（不串稿）；origin 保留
  await page.getByRole("button", { name: "返回稿件" }).click();
  await expect(textarea2).toBeVisible({ timeout: 10_000 });
  const rev1Row = page.locator("li", { hasText: "第 1 稿" });
  await rev1Row.getByRole("button", { name: "查看" }).click();
  await expect(textarea).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(/E2E 第一稿反馈：结构清楚/)).toBeVisible({ timeout: 15_000 });
  expect(await page.getByText(/E2E 第二稿反馈/).count()).toBe(0);
  expect(new URL(page.url()).searchParams.get("origin")).toBeTruthy();

  // 库核：两稿、两次判定、两条反馈各绑其稿
  const dbState = await withAdmin(async (client) => {
    const sheets = await client.query("SELECT count(*)::int AS c FROM l3_submissions WHERE writing_task_id = $1", [taskId]);
    const attempts = await client.query(
      "SELECT count(*)::int AS c FROM l3_question_attempts WHERE sheet_id IN (SELECT id FROM l3_submissions WHERE writing_task_id = $1)", [taskId]);
    const fb = await client.query(
      `SELECT sheet_id, feedback->>'summary' AS summary FROM l3_writing_feedback
        WHERE sheet_id IN (SELECT id FROM l3_submissions WHERE writing_task_id = $1) ORDER BY sheet_id`, [taskId]);
    return {
      sheets: sheets.rows[0].c as number,
      attempts: attempts.rows[0].c as number,
      feedback: fb.rows as Array<{ sheet_id: string; summary: string }>,
    };
  });
  expect(dbState.sheets).toBe(2);
  expect(dbState.attempts).toBe(2);
  expect(dbState.feedback).toHaveLength(2);
  const bySheet = new Map(dbState.feedback.map((row) => [row.sheet_id, row.summary]));
  expect(bySheet.get(sheet1)).toContain("第一稿");
  expect(bySheet.get(sheet2)).toContain("第二稿");
});
