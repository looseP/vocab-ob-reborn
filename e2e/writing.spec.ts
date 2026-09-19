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

/** 经真实 API 建任务（owner bearer），返回任务与首稿 id。 */
async function createTaskViaApi(request: import("@playwright/test").APIRequestContext): Promise<{ taskId: string; sheetId: string }> {
  const res = await request.post("/api/l3/writing/tasks", {
    headers: { Authorization: `Bearer ${OWNER_TOKEN}`, "Content-Type": "application/json" },
    data: { requestId: crypto.randomUUID(), kind: "free", direction: "通用" },
  });
  expect(res.status()).toBe(201);
  const body = await res.json();
  return { taskId: body.task.id as string, sheetId: body.draft.id as string };
}

async function writingText(taskId: string, sheetId: string): Promise<string> {
  return withAdmin(async (client) => {
    const row = await client.query<{ answers: Record<string, { text?: string }> }>(
      "SELECT answers FROM l3_submissions WHERE id = $1 AND writing_task_id = $2",
      [sheetId, taskId],
    );
    const answers = row.rows[0]?.answers ?? {};
    const first = Object.values(answers)[0] as { text?: string } | undefined;
    return first?.text ?? "";
  });
}

async function attemptCount(sheetId: string): Promise<number> {
  return withAdmin(async (client) => {
    const row = await client.query<{ c: number }>(
      "SELECT count(*)::int AS c FROM l3_question_attempts WHERE sheet_id = $1",
      [sheetId],
    );
    return row.rows[0].c as number;
  });
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
  await page.getByRole("button", { name: "开始修改" }).click();
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

test("故障与并发（浏览器+真实HTTP+库核）：失败阻止提交/导出并诚实恢复；延迟不丢输入；IME不存半截；双标签页不覆盖", async ({ page, context, request }) => {
  test.skip(!ENABLED, "writing fault matrix gated behind E2E_WRITING_SMOKE=1");
  test.setTimeout(120_000); // 含 ⑥ 恢复误确认回归（真实退避 1/2/4s）后总时长超默认 30s
  await login(page);
  const writingUrl = (taskId: string, sheetId: string) =>
    `/l3?section=writing&writingTaskId=${taskId}&sheet=${sheetId}`;

  // ── ① 网络中断一次 → 自动退避重试可恢复（诚实"重试中"→"已保存"）──────
  {
    const a = await createTaskViaApi(request);
    await page.goto(writingUrl(a.taskId, a.sheetId));
    const textarea = page.getByRole("textbox", { name: "作文正文" });
    await expect(textarea).toBeVisible();
    let failPatches = true;
    const routeHandler = async (route: import("@playwright/test").Route) => {
      if (route.request().method() === "PATCH" && failPatches) return route.abort("failed");
      return route.continue();
    };
    await page.route("**/api/l3/writing/**", routeHandler);
    await textarea.fill("退避恢复正文");
    await expect(page.getByText(/保存状态：保存中…（自动重试）/)).toBeVisible({ timeout: 10_000 });
    failPatches = false; // 放行：自动退避重试应成功
    await expect(page.getByText(/保存状态：已保存/)).toBeVisible({ timeout: 10_000 });
    expect(await writingText(a.taskId, a.sheetId)).toBe("退避恢复正文");
    await page.unroute("**/api/l3/writing/**");
  }

  // ── ② 保存持续失败（非可重试 422）：阻止提交与导出 → 手动重试恢复 → 提交 ─
  {
    const b = await createTaskViaApi(request);
    await page.goto(writingUrl(b.taskId, b.sheetId));
    const textarea = page.getByRole("textbox", { name: "作文正文" });
    await expect(textarea).toBeVisible();
    let failPatches = true;
    await page.route("**/api/l3/writing/**", (route) => {
      if (route.request().method() === "PATCH" && failPatches) {
        return route.fulfill({ status: 422, contentType: "application/json", body: JSON.stringify({ error: "rejected", code: "VALIDATION_ERROR" }) });
      }
      return route.continue();
    });
    await textarea.fill("失败阻止正文");
    await expect(page.getByText(/保存状态：保存失败/)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/尚未保存，请保持页面打开/)).toBeVisible();
    // 提交被 flush 阻止（快速失败路径；不发 submit）。
    await page.getByRole("button", { name: "提交本稿" }).click();
    await expect(page.getByText(/保存未完成，未能提交/)).toBeVisible({ timeout: 10_000 });
    expect(await attemptCount(b.sheetId)).toBe(0);
    // 导出被阻止：不生成文件、不假成功。
    await page.getByRole("button", { name: "导出本稿" }).click();
    await expect(page.getByText(/导出失败，未生成文件/)).toBeVisible({ timeout: 10_000 });
    await page.screenshot({ path: `${SHOT_DIR}/10-save-failure-blocks-submit-export.png` });
    // 手动重试恢复 → 提交成功（一稿一 attempt）。
    failPatches = false;
    await page.getByRole("button", { name: "重试保存" }).click();
    await expect(page.getByText(/保存状态：已保存/)).toBeVisible({ timeout: 10_000 });
    await page.getByRole("button", { name: "提交本稿" }).click();
    await expect(page.getByText(/已提交（只读）/)).toBeVisible({ timeout: 10_000 });
    expect(await attemptCount(b.sheetId)).toBe(1);
    await page.unroute("**/api/l3/writing/**");
  }

  // ── ③ 延迟 PATCH 期间继续输入：最终正文正确（不丢新输入）────────────────
  {
    const c = await createTaskViaApi(request);
    await page.goto(writingUrl(c.taskId, c.sheetId));
    const textarea = page.getByRole("textbox", { name: "作文正文" });
    await expect(textarea).toBeVisible();
    await page.route("**/api/l3/writing/**", async (route) => {
      if (route.request().method() === "PATCH") {
        await new Promise((resolve) => setTimeout(resolve, 1500)); // 延迟实际请求
      }
      return route.continue();
    });
    await textarea.fill("第一版");
    await page.waitForTimeout(300);
    await textarea.fill("第一版加料");
    await expect(page.getByText(/保存状态：已保存/)).toBeVisible({ timeout: 15_000 });
    expect(await writingText(c.taskId, c.sheetId)).toBe("第一版加料");
    await page.unroute("**/api/l3/writing/**");
  }

  // ── ④ IME 合成中不保存半截内容 ──────────────────────────────────────────
  {
    const d = await createTaskViaApi(request);
    await page.goto(writingUrl(d.taskId, d.sheetId));
    await expect(page.getByRole("textbox", { name: "作文正文" })).toBeVisible();
    await page.evaluate(() => {
      const el = document.getElementById("writing-draft-textarea") as HTMLTextAreaElement;
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      el.focus();
      el.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      setter.call(el, "拼");
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.waitForTimeout(1400); // 越过 800ms 防抖
    expect(await writingText(d.taskId, d.sheetId)).toBe(""); // 合成中：未写入半截
    await page.evaluate(() => {
      const el = document.getElementById("writing-draft-textarea") as HTMLTextAreaElement;
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(el, "拼写完成");
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    });
    await expect(page.getByText(/保存状态：已保存/)).toBeVisible({ timeout: 10_000 });
    expect(await writingText(d.taskId, d.sheetId)).toBe("拼写完成");
  }

  // ── ⑤ 双标签页冲突：陈旧版本保存 409 → 冲突提示、不静默覆盖 ─────────────
  {
    const e = await createTaskViaApi(request);
    const second = await context.newPage();
    await page.goto(writingUrl(e.taskId, e.sheetId));
    await second.goto(writingUrl(e.taskId, e.sheetId)); // 第二标签页先加载（拿旧版本基线）
    const p1 = page.getByRole("textbox", { name: "作文正文" });
    const p2 = second.getByRole("textbox", { name: "作文正文" });
    await expect(p1).toBeVisible();
    await expect(p2).toBeVisible();
    await p1.fill("甲版内容");
    await expect(page.getByText(/保存状态：已保存/)).toBeVisible({ timeout: 10_000 });
    await p2.fill("乙版内容"); // 陈旧 version → 409 → 冲突态
    await expect(second.getByText(/另一处更新了这份草稿/)).toBeVisible({ timeout: 10_000 });
    expect(await writingText(e.taskId, e.sheetId)).toBe("甲版内容"); // 不被乙版静默覆盖
    expect(await p2.inputValue()).toBe("乙版内容"); // 本地保留 + 冲突处理入口
    await second.screenshot({ path: `${SHOT_DIR}/11-two-tab-conflict.png` });
    await second.close();
  }

  // ── ⑥ 恢复误确认（reconcile 交错）：恢复确认不得吞掉期间的新输入 ──────────
  {
    const f = await createTaskViaApi(request);
    await page.goto(writingUrl(f.taskId, f.sheetId));
    const textarea = page.getByRole("textbox", { name: "作文正文" });
    await expect(textarea).toBeVisible();

    // 前三次纯网络失败（abort）；第四次真实发到服务端后丢弃响应；期间输入新正文。
    let patchCount = 0;
    let failPatches = true;
    let markLostResponseStarted!: () => void;
    const lostResponseStarted = new Promise<void>((resolve) => { markLostResponseStarted = resolve; });
    let releaseLostResponse!: () => void;
    const lostResponseGate = new Promise<void>((resolve) => { releaseLostResponse = resolve; });
    await page.route("**/api/l3/writing/**", async (route) => {
      if (route.request().method() === "PATCH" && failPatches) {
        patchCount += 1;
        if (patchCount <= 3) return route.abort("failed");
        if (patchCount === 4) {
          await route.fetch().catch(() => undefined); // 服务端实际已落库（响应将被丢弃）
          markLostResponseStarted();
          await lostResponseGate; // 等待「第 4 次在途期间输入新正文」
          failPatches = false; // 恢复后的补发放行（应真实成功）
          return route.abort("failed"); // 丢弃响应：客户端视为网络失败
        }
      }
      return route.continue();
    });

    await textarea.fill("恢复基线稿"); // seq1：三次失败 + 第四次丢响应
    await lostResponseStarted; // 第 4 次已在途且服务端已落库
    await textarea.fill("恢复基线稿·续写"); // seq2：恢复期间的新输入

    // 诚实性（未确认窗口）：不得显示「已保存」；离开提示处于拦截态（beforeunload）。
    await expect(page.getByText(/保存状态：已保存/)).not.toBeVisible();
    const guardedWhileUnsaved = await page.evaluate(() => {
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    });
    expect(guardedWhileUnsaved).toBe(true);
    await page.screenshot({ path: `${SHOT_DIR}/12-reconcile-unsaved-honest.png` });

    releaseLostResponse(); // 丢弃响应 → 重试耗尽 → load 恢复确认「恢复基线稿」

    // 修复核心：恢复只确认已发送序号——必须继续把「续写」补发落库（旧实现把它误记为已确认而永久丢失）。
    await expect(page.getByText(/保存状态：已保存/)).toBeVisible({ timeout: 20_000 });
    expect(await writingText(f.taskId, f.sheetId)).toBe("恢复基线稿·续写");
    expect(await attemptCount(f.sheetId)).toBe(0); // 未提交：不产生 attempt

    // 保存确认后：离开提示不再拦截（状态诚实归零）。
    const guardedAfterSaved = await page.evaluate(() => {
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    });
    expect(guardedAfterSaved).toBe(false);
    await page.screenshot({ path: `${SHOT_DIR}/13-reconcile-keeps-newer-input.png` });
    await page.unroute("**/api/l3/writing/**");
  }

  // ── 清理本次故障矩阵数据 ────────────────────────────────────────────────
  await withAdmin(async (client) => {
    await client.query("DELETE FROM l3_writing_feedback WHERE user_id = $1::uuid", ["00000000-0000-1000-8000-000000000001"]);
    await client.query("DELETE FROM l3_question_attempts WHERE user_id = $1::uuid", ["00000000-0000-1000-8000-000000000001"]);
    await client.query("DELETE FROM l3_submissions WHERE user_id = $1::uuid", ["00000000-0000-1000-8000-000000000001"]);
    await client.query("DELETE FROM l3_writing_tasks WHERE user_id = $1::uuid", ["00000000-0000-1000-8000-000000000001"]);
    await client.query("DELETE FROM l3_questions WHERE user_id = $1::uuid AND file_key LIKE 'writing:%'", ["00000000-0000-1000-8000-000000000001"]);
  });
});

/** 清空 owner 的全部写作数据（幂等起点/收尾；任务仅用于本文件的验收库）。 */
async function wipeOwnerWritingData(): Promise<void> {
  await withAdmin(async (client) => {
    await client.query("DELETE FROM l3_writing_feedback WHERE user_id = $1::uuid", ["00000000-0000-1000-8000-000000000001"]);
    await client.query("DELETE FROM l3_question_attempts WHERE user_id = $1::uuid", ["00000000-0000-1000-8000-000000000001"]);
    await client.query("DELETE FROM l3_submissions WHERE user_id = $1::uuid", ["00000000-0000-1000-8000-000000000001"]);
    await client.query("DELETE FROM l3_writing_tasks WHERE user_id = $1::uuid", ["00000000-0000-1000-8000-000000000001"]);
    await client.query("DELETE FROM l3_questions WHERE user_id = $1::uuid AND file_key LIKE 'writing:%'", ["00000000-0000-1000-8000-000000000001"]);
  });
}

test("分页与生命周期（25 任务 / 25 稿次 / 搜索 / 归档恢复 / 题面继承）：跨页无重复无漏项", async ({ request }) => {
  test.skip(!ENABLED, "writing pagination matrix gated behind E2E_WRITING_SMOKE=1");
  test.setTimeout(180_000);
  const ownerHeaders = { Authorization: `Bearer ${OWNER_TOKEN}`, "Content-Type": "application/json" };

  await wipeOwnerWritingData(); // 幂等起点：清除失败运行残留

  // ── 25 个任务（唯一标题便于搜索断言）────────────────────────────────────
  const createdIds: string[] = [];
  for (let i = 1; i <= 25; i += 1) {
    const res = await request.post("/api/l3/writing/tasks", {
      headers: ownerHeaders,
      data: {
        requestId: crypto.randomUUID(),
        kind: "free",
        direction: "通用",
        title: `分页任务 ${String(i).padStart(2, "0")}`,
      },
    });
    expect(res.status()).toBe(201);
    createdIds.push((await res.json()).task.id as string);
  }

  // 第 1 页 20 条 + 第 2 页 5 条：无重复、无漏项、total 正确
  const page1Res = await request.get("/api/l3/writing/tasks?limit=20", { headers: ownerHeaders });
  expect(page1Res.status()).toBe(200);
  const page1 = await page1Res.json();
  expect(page1.total).toBe(25);
  expect(page1.items).toHaveLength(20);
  expect(page1.nextCursor).toBeTruthy();
  const page2Res = await request.get(`/api/l3/writing/tasks?limit=20&cursor=${encodeURIComponent(page1.nextCursor)}`, { headers: ownerHeaders });
  const page2 = await page2Res.json();
  expect(page2.items).toHaveLength(5);
  expect(page2.nextCursor).toBeNull();
  const listedIds = [...page1.items, ...page2.items].map((item) => item.task.id as string);
  expect(new Set(listedIds).size).toBe(25); // 无重复
  expect([...listedIds].sort()).toEqual([...createdIds].sort()); // 无漏项

  // 搜索：唯一标题命中 1 条；不存在标题命中 0 条
  const searchRes = await request.get(`/api/l3/writing/tasks?q=${encodeURIComponent("分页任务 07")}`, { headers: ownerHeaders });
  const search = await searchRes.json();
  expect(search.total).toBe(1);
  expect(search.items[0].task.title).toBe("分页任务 07");
  const missRes = await request.get(`/api/l3/writing/tasks?q=${encodeURIComponent("绝不存在的标题词")}`, { headers: ownerHeaders });
  expect((await missRes.json()).total).toBe(0);

  // ── 25 稿次（同任务封 25 次；keyset 跨页完整；题面继承 prompt 路径）────
  const mkRes = await request.post("/api/l3/writing/tasks", {
    headers: ownerHeaders,
    data: {
      requestId: crypto.randomUUID(),
      kind: "paragraph",
      direction: "通用",
      prompt: "分页稿次题面：描述一次学习经历。",
      title: "稿次分页任务",
    },
  });
  expect(mkRes.status()).toBe(201);
  const mk = await mkRes.json();
  const revTaskId = mk.task.id as string;
  expect(mk.task.prompt).toBe("分页稿次题面：描述一次学习经历。"); // 题面继承（不重复填写）
  let draftId = mk.draft.id as string;

  for (let i = 1; i <= 25; i += 1) {
    const saveRes = await request.patch(`/api/l3/writing/tasks/${revTaskId}/sheets/${draftId}`, {
      headers: ownerHeaders,
      data: { expectedVersion: 0, text: `第 ${i} 稿内容` },
    });
    expect(saveRes.status()).toBe(200);
    const subRes = await request.post(`/api/l3/writing/tasks/${revTaskId}/sheets/${draftId}/submit`, {
      headers: ownerHeaders,
      data: { expectedVersion: 1 },
    });
    expect(subRes.status()).toBe(200);
    if (i < 25) {
      const ndRes = await request.post(`/api/l3/writing/tasks/${revTaskId}/drafts`, {
        headers: ownerHeaders,
        data: { parentSheetId: draftId, seed: "blank" },
      });
      expect(ndRes.status()).toBe(201);
      draftId = (await ndRes.json()).sheet.id as string;
    }
  }

  const rev1Res = await request.get(`/api/l3/writing/tasks/${revTaskId}/revisions?limit=20`, { headers: ownerHeaders });
  expect(rev1Res.status()).toBe(200);
  const rev1 = await rev1Res.json();
  expect(rev1.total).toBe(25);
  expect(rev1.items).toHaveLength(20);
  expect(rev1.nextCursor).toBeTruthy();
  const rev2Res = await request.get(`/api/l3/writing/tasks/${revTaskId}/revisions?limit=20&cursor=${encodeURIComponent(rev1.nextCursor)}`, { headers: ownerHeaders });
  const rev2 = await rev2Res.json();
  expect(rev2.items).toHaveLength(5);
  expect(rev2.nextCursor).toBeNull();
  const revNos = [...rev1.items, ...rev2.items].map((item) => item.sheet.revisionNo as number).sort((a, b) => a - b);
  expect(revNos).toEqual(Array.from({ length: 25 }, (_, index) => index + 1)); // 1..25 无重复无漏

  // ── 归档 / 恢复（无 draft 才可归档；默认列表不含 archived）──────────────
  const archRes = await request.post(`/api/l3/writing/tasks/${revTaskId}/archive`, { headers: ownerHeaders });
  expect(archRes.status()).toBe(200);
  expect((await archRes.json()).status).toBe("archived");
  const archivedList = await (await request.get("/api/l3/writing/tasks?status=archived&limit=50", { headers: ownerHeaders })).json();
  expect(archivedList.total).toBe(1);
  expect(archivedList.items[0].task.id).toBe(revTaskId);
  const restoreRes = await request.post(`/api/l3/writing/tasks/${revTaskId}/restore`, { headers: ownerHeaders });
  expect(restoreRes.status()).toBe(200);
  expect((await restoreRes.json()).status).toBe("active");

  await wipeOwnerWritingData(); // 收尾清理
});

test("清理正文（真实链路）：占位可见、反馈与正文不泄漏、导出拒绝、库核零残留", async ({ page, request }) => {
  test.skip(!ENABLED, "writing cleanup leak check gated behind E2E_WRITING_SMOKE=1");
  test.setTimeout(120_000);
  const ownerHeaders = { Authorization: `Bearer ${OWNER_TOKEN}`, "Content-Type": "application/json" };
  mkdirSync(SHOT_DIR, { recursive: true });

  await login(page);
  const t = await createTaskViaApi(request);
  const text = "清理演练：第一段交代背景。\n\n第二段引用行内容作为锚点。";
  const quote = "引用行内容";

  await page.goto(`/l3?section=writing&writingTaskId=${t.taskId}&sheet=${t.sheetId}`);
  const textarea = page.getByRole("textbox", { name: "作文正文" });
  await textarea.fill(text);
  await expect(page.getByText(/保存状态：已保存/)).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: "提交本稿" }).click();
  await expect(page.getByText(/已提交（只读）/)).toBeVisible({ timeout: 10_000 });

  // agent 评语（含 quote 锚点；真实 HTTP）
  const sha = await page.evaluate(async (hashInput: string) => {
    const data = new TextEncoder().encode(hashInput);
    const digest = await crypto.subtle.digest("SHA-256", data);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }, text);
  const anchorStart = text.indexOf(quote);
  const putRes = await request.put(`/api/l3/writing/tasks/${t.taskId}/sheets/${t.sheetId}/feedback`, {
    headers: { Authorization: `Bearer ${AGENT_TOKEN}`, "Content-Type": "application/json" },
    data: {
      expectedVersion: 0,
      textSha256: sha,
      requestId: crypto.randomUUID(),
      feedback: {
        schemaVersion: 1,
        summary: "清理演练评语摘要。",
        strengths: ["结构可辨"],
        dimensions: {
          task_response: { applicable: true, comment: "回应题目。" },
          organization: { applicable: true, comment: "两段结构。" },
          language: { applicable: true, comment: "通顺。" },
          expression: { applicable: false, comment: "不评。" },
        },
        priorities: [{
          id: "p1",
          dimension: "language",
          observation: "锚点语句可更简洁。",
          action: "压缩该句。",
          anchor: { start: anchorStart, end: anchorStart + quote.length, quote },
        }],
      },
    },
  });
  expect(putRes.status()).toBe(200);

  await page.getByRole("button", { name: "刷新反馈" }).click();
  await expect(page.getByText(/清理演练评语摘要/)).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("button", { name: "跳至原句" })).toBeVisible();

  // 清理（与 UI「清理正文」同一端点；owner）
  const clearRes = await request.delete(`/api/l3/writing/tasks/${t.taskId}/sheets/${t.sheetId}/content`, { headers: ownerHeaders });
  expect(clearRes.status()).toBe(200);

  // 刷新页面：清理占位可见；正文与评语（含 quote/action）不再出现——下一次请求即失效旧缓存
  await page.reload();
  await expect(page.getByText(/本稿正文已清理，不再展示评语/)).toBeVisible({ timeout: 10_000 });
  expect(await page.getByRole("textbox", { name: "作文正文" }).inputValue()).toBe("");
  const bodyText = await page.locator("body").innerText();
  expect(bodyText).not.toContain("清理演练评语摘要");
  expect(bodyText).not.toContain("引用行内容");
  expect(bodyText).not.toContain("压缩该句");
  await page.screenshot({ path: `${SHOT_DIR}/12-cleared-no-leak.png` });

  // 导出被拒（不生成文件、不假成功）
  await page.getByRole("button", { name: "导出本稿" }).click();
  await expect(page.getByText(/导出失败，未生成文件/)).toBeVisible({ timeout: 10_000 });

  // 库核：active attempt = 0、feedback 行 = 0
  const dbState = await withAdmin(async (client) => {
    const attempt = await client.query("SELECT count(*)::int AS c FROM l3_question_attempts WHERE sheet_id = $1 AND status = 'active'", [t.sheetId]);
    const feedback = await client.query("SELECT count(*)::int AS c FROM l3_writing_feedback WHERE sheet_id = $1", [t.sheetId]);
    return { activeAttempts: attempt.rows[0].c as number, feedback: feedback.rows[0].c as number };
  });
  expect(dbState).toEqual({ activeAttempts: 0, feedback: 0 });

  await wipeOwnerWritingData(); // 收尾清理
});
