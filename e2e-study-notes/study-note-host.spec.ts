/**
 * Task 07 · 联调宿主 E2E（真实浏览器 + 真实 HTTP + 本批隔离 PG）。
 *
 * 覆盖（执行提示 §6 必测项）：
 *  ① 显式创建 → 编辑 → 保存 → F5/离开/重开一致；GET/F5/重开不创建新笔记（计数不变）；
 *  ② A 在途编辑 B（真实延迟响应）：回包不覆盖后值、最终保存 B；
 *  ③ 服务端已提交但响应丢失 → 原样重试（同 requestId）不重复推进版本；
 *  ④ 双标签 409（后端 CAS 显式断言）→ 本地保全 → 显式载入服务器版本 → 新基线保存；
 *  ⑤ 离页屏障：保存失败时「离开」不导航并显示原因；恢复后可离开；
 *  ⑥ 已有引用含 unavailable：仅改标题保存——引用 id/快照/capturedAt 不变。
 *
 * 纪律：仅在专属空验收库 vocab_study_notes_task07_accept 运行（库身份显式校验）；
 * fixture owner = E2E_OWNER_ID；清理仅限本 owner 数据（不 truncate 业务表）。
 * 故障注入只丢/延迟真实请求的响应（route.fetch + abort / 延迟 continue），不伪造 200。
 */
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import type { Page } from "@playwright/test";
import pg from "pg";
import { expect, loginAsOwner, test } from "../e2e/fixtures";

const ADMIN_DB_URL = process.env.E2E_SETUP_DATABASE_URL ?? "";
const EXPECTED_DB = process.env.STUDY_NOTES_E2E_DB ?? "vocab_study_notes_task07_accept";
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

async function countOwnerNotes(): Promise<number> {
  return withAdmin(async (client) => {
    const result = await client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM l3_study_notes WHERE user_id = $1::uuid",
      [OWNER_ID],
    );
    return result.rows[0]!.n;
  });
}

interface NoteRow {
  id: string;
  title: string;
  body_md: string;
  version: number;
  status: string;
  pinned: boolean;
  updated_at: Date;
}

async function fetchNote(noteId: string): Promise<NoteRow> {
  return withAdmin(async (client) => {
    const result = await client.query<NoteRow>(
      "SELECT id, title, body_md, version, status, pinned, updated_at FROM l3_study_notes WHERE id = $1::uuid",
      [noteId],
    );
    if (result.rows.length !== 1) throw new Error(`note ${noteId} 不存在`);
    return result.rows[0]!;
  });
}

async function fetchReference(refId: string): Promise<Record<string, unknown>> {
  return withAdmin(async (client) => {
    const result = await client.query(
      `SELECT id, note_id, user_id, kind, source_id, question_id, option_key, start_offset, end_offset,
              quote_snapshot, field_hash, display_snapshot, captured_at
       FROM l3_study_note_references WHERE id = $1::uuid`,
      [refId],
    );
    if (result.rows.length !== 1) throw new Error(`reference ${refId} 不存在`);
    return result.rows[0] as Record<string, unknown>;
  });
}

/** 页面内 fetch（浏览器上下文：同源 Origin/cookie 自动；CSRF 从 cookie 读取后写入头）。 */
async function pageApiCall(
  page: Page,
  path: string,
  init: { method: "POST" | "PUT"; body: unknown },
): Promise<{ status: number; body: Record<string, unknown> | null }> {
  return page.evaluate(
    async ({ path: requestPath, method, body }) => {
      const csrfEntry = document.cookie
        .split("; ")
        .find((entry) => entry.startsWith("vocab_csrf="));
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

async function apiCreateNote(page: Page, venue = "cloze"): Promise<string> {
  const result = await pageApiCall(page, "/api/l3/study-notes", {
    method: "POST",
    body: { requestId: randomUUID(), venue },
  });
  expect(result.status).toBe(201);
  const item = result.body?.item as { id: string } | undefined;
  return item!.id;
}

async function apiSaveNote(
  page: Page,
  noteId: string,
  data: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> | null }> {
  return pageApiCall(page, `/api/l3/study-notes/${noteId}`, { method: "PUT", body: data });
}

/** 打开宿主并显式创建一篇笔记；返回 noteId。 */
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
    await client.query("DELETE FROM l3_study_topic_notes WHERE user_id = $1::uuid", [OWNER_ID]);
    await client.query("DELETE FROM l3_study_note_venues WHERE user_id = $1::uuid", [OWNER_ID]);
    await client.query("DELETE FROM l3_study_topics WHERE user_id = $1::uuid", [OWNER_ID]);
    await client.query("DELETE FROM l3_study_notes WHERE user_id = $1::uuid", [OWNER_ID]);
    await client.query("DELETE FROM l3_questions WHERE user_id = $1::uuid", [OWNER_ID]);
    await client.query("DELETE FROM l3_sources WHERE user_id = $1::uuid", [OWNER_ID]);
  });
});

test("① 显式创建→编辑→保存→F5/离开/重开一致；GET/F5 不创建", async ({ authedPage: page }) => {
  const before = await countOwnerNotes();
  const noteId = await openHostAndCreate(page);
  expect(await countOwnerNotes()).toBe(before + 1); // 显式创建 = 恰好 +1（无自动创建）

  await page.getByTestId("note-title").fill("E2E 标题一");
  await page.getByTestId("note-body").fill("E2E 正文一\n\n第二段。");
  await expect(page.getByTestId("save-state")).toContainText("已保存", { timeout: 15_000 });

  const saved = await fetchNote(noteId);
  expect(saved.title).toBe("E2E 标题一");
  expect(saved.body_md).toContain("E2E 正文一");

  // F5 刷新：只 GET、不 POST（计数不变），内容一致
  await page.reload();
  await expect(page.getByTestId("note-title")).toHaveValue("E2E 标题一", { timeout: 15_000 });
  expect(await countOwnerNotes()).toBe(before + 1);

  // 离开 → 重开同一 note：内容一致、无额外写入
  await page.getByTestId("leave-action").click();
  await expect(page.getByTestId("host-launcher")).toBeVisible({ timeout: 10_000 });
  await page.getByTestId("host-open-input").fill(noteId);
  await page.getByTestId("host-open").click();
  await expect(page.getByTestId("note-title")).toHaveValue("E2E 标题一", { timeout: 15_000 });

  const reopened = await fetchNote(noteId);
  expect(reopened.version).toBe(saved.version);
  expect(await countOwnerNotes()).toBe(before + 1);
});

test("② A 在途编辑 B：延迟响应不覆盖后值，最终保存 B", async ({ authedPage: page }) => {
  const noteId = await openHostAndCreate(page);

  let firstPutSeen = false;
  await page.route("**/api/l3/study-notes/*", async (route) => {
    if (route.request().method() === "PUT" && !firstPutSeen) {
      firstPutSeen = true;
      await new Promise((resolve) => setTimeout(resolve, 1_500)); // 仅延迟响应，真实请求继续
    }
    await route.continue();
  });

  await page.getByTestId("note-title").fill("值A");
  await expect.poll(() => firstPutSeen, { timeout: 8_000 }).toBe(true); // A 已在途
  await page.getByTestId("note-title").fill("值B");

  await expect(page.getByTestId("save-state")).toContainText("已保存", { timeout: 20_000 });
  await expect(page.getByTestId("note-title")).toHaveValue("值B"); // 不回退到 A
  const note = await fetchNote(noteId);
  expect(note.title).toBe("值B");
  expect(note.version).toBe(3); // 创建=1；A=2；B=3
});

test("③ 服务端已提交但响应丢失：原样重试不重复推进版本", async ({ authedPage: page }) => {
  const noteId = await openHostAndCreate(page);

  let droppedOnce = false;
  await page.route("**/api/l3/study-notes/*", async (route) => {
    if (route.request().method() === "PUT" && !droppedOnce) {
      droppedOnce = true;
      await route.fetch(); // 真实请求发出（服务端会提交）
      await route.abort("failed"); // 响应丢弃 → 页面看到网络失败
      return;
    }
    await route.continue();
  });

  await page.getByTestId("note-title").fill("丢响应标题");
  await expect(page.getByTestId("save-state")).toContainText("已保存", { timeout: 25_000 });

  const note = await fetchNote(noteId);
  expect(note.title).toBe("丢响应标题");
  expect(note.version).toBe(2); // 仅一次推进：重试同 requestId 幂等，不重复推进
});

test("④ 双标签 409（后端 CAS）→ 本地保全 → 显式载入 → 新基线保存", async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const page1 = await context.newPage();
    await loginAsOwner(page1);
    const noteId = await openHostAndCreate(page1);
    await page1.getByTestId("note-title").fill("初始");
    await expect(page1.getByTestId("save-state")).toContainText("已保存", { timeout: 15_000 });

    // 第二标签（共享登录会话）更新同一笔记
    const page2 = await context.newPage();
    await page2.goto(`/study-note-host?noteId=${noteId}`);
    await expect(page2.getByTestId("note-title")).toHaveValue("初始", { timeout: 15_000 });
    await page2.getByTestId("note-title").fill("标签二标题");
    await expect(page2.getByTestId("save-state")).toContainText("已保存", { timeout: 15_000 });
    expect((await fetchNote(noteId)).version).toBe(3);

    // page1 持旧版本保存 → 409 → 冲突面板（本地输入保留）
    await page1.getByTestId("note-title").fill("标签一本地");
    await expect(page1.getByTestId("conflict-panel")).toBeVisible({ timeout: 15_000 });
    await expect(page1.getByTestId("conflict-panel")).toContainText("服务器版本 3");
    await expect(page1.getByTestId("note-title")).toHaveValue("标签一本地");

    // 后端 CAS 显式证明：陈旧 expectedVersion 的 API 保存被拒（409 + currentVersion）
    const stale = await apiSaveNote(page1, noteId, {
      expectedVersion: 2,
      requestId: randomUUID(),
      title: "陈旧写入",
      bodyMd: "",
      venues: ["cloze"],
      pinned: false,
      status: "active",
      references: [],
    });
    expect(stale.status).toBe(409);
    expect((stale.body?.details as Record<string, unknown> | undefined)?.currentVersion).toBe(3);

    // 复制本地内容入口（保全点）：本机 headless 下真实写入剪贴板会触发 worker 收尾挂死
    //（实验A/B/C 定位：显式 grantPermissions、page.request、剪贴板点击三变量逐一排除，剪贴板写入是挂因；
    //  详见执行台账）。复制成功与失败备选的交互路径由组件测试覆盖（mock clipboard）。
    await expect(page1.getByRole("button", { name: "复制本地内容" })).toBeVisible();

    // 显式载入服务器版本 → 显示标签二的内容
    await page1.getByRole("button", { name: "载入服务器版本" }).click();
    await expect(page1.getByTestId("note-title")).toHaveValue("标签二标题", { timeout: 15_000 });

    // 载入后重新编辑 → 以新基线（版本 3）保存
    await page1.getByTestId("note-title").fill("标签一重写");
    await expect(page1.getByTestId("save-state")).toContainText("已保存", { timeout: 15_000 });
    const finalNote = await fetchNote(noteId);
    expect(finalNote.title).toBe("标签一重写");
    expect(finalNote.version).toBe(4); // 创建1 + 初始2 + 标签二3 + 标签一重写4
  } finally {
    await context.close();
  }
});

test("⑤ 离页屏障：保存失败时『离开』不导航；恢复后离开成功", async ({ authedPage: page }) => {
  const noteId = await openHostAndCreate(page);

  let blocking = true;
  await page.route("**/api/l3/study-notes/*", async (route) => {
    if (route.request().method() === "PUT" && blocking) {
      await route.abort("failed"); // 请求不发出（网络故障语义）
      return;
    }
    await route.continue();
  });

  await page.getByTestId("note-title").fill("未保存的标题");
  await expect(page.getByTestId("error-panel")).toBeVisible({ timeout: 30_000 }); // 自动重试耗尽 → error

  // 失败：不导航、留在原位
  await page.getByTestId("leave-action").click();
  await expect(page.getByTestId("navigation-error")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("host-note-id")).toBeVisible();
  await expect(page.getByTestId("host-note-id")).toHaveText(noteId);

  // 恢复网络 → 重试保存成功 → 可离开
  blocking = false;
  await page.getByRole("button", { name: "重试保存" }).click();
  await expect(page.getByTestId("save-state")).toContainText("已保存", { timeout: 15_000 });

  await page.getByTestId("leave-action").click();
  await expect(page.getByTestId("host-launcher")).toBeVisible({ timeout: 10_000 });
  expect((await fetchNote(noteId)).title).toBe("未保存的标题");
});

test("⑥ 已有引用含 unavailable：仅改标题保存，引用 id/快照/capturedAt 不变", async ({ authedPage: page }) => {
  // 种子：source + active question（admin 直插）；capture 经真实 API（服务端生成引用行）
  const sourceId = randomUUID();
  const questionId = randomUUID();
  await withAdmin(async (client) => {
    await client.query(
      `INSERT INTO l3_sources (id, user_id, source_type, title, content_text)
       VALUES ($1::uuid, $2::uuid, 'article', 'E2E 来源', '来源正文 A1')`,
      [sourceId, OWNER_ID],
    );
    await client.query(
      `INSERT INTO l3_questions (id, user_id, source_id, file_key, space, question_type, stem, options, answer, evidence)
       VALUES ($1::uuid, $2::uuid, $3::uuid, NULL, '阅读', 'reading_choice', 'E2E 题干 B1', '[]'::jsonb, '{}'::jsonb, '[]'::jsonb)`,
      [questionId, OWNER_ID, sourceId],
    );
  });

  await page.goto("/study-note-host");
  const noteId = await apiCreateNote(page);
  const refId = randomUUID();
  const capture = await apiSaveNote(page, noteId, {
    expectedVersion: 1,
    requestId: randomUUID(),
    title: "引用笔记",
    bodyMd: `正文一\n\n[[ref:${refId}]]\n`,
    venues: ["cloze"],
    pinned: false,
    status: "active",
    references: [{ id: refId, action: "capture", target: { kind: "question", questionId } }],
  });
  expect(capture.status).toBe(200);
  const refBefore = await fetchReference(refId);

  // 目标变为 rejected → 引用 unavailable（保留旧摘录，不阻断编辑/保存）
  await withAdmin(async (client) => {
    await client.query("UPDATE l3_questions SET status='rejected' WHERE id = $1::uuid", [questionId]);
  });

  // 打开 → 仅改标题 → 保存
  await page.goto(`/study-note-host?noteId=${noteId}`);
  await expect(page.getByTestId("note-title")).toHaveValue("引用笔记", { timeout: 15_000 });
  await page.getByTestId("note-title").fill("只改标题");
  await expect(page.getByTestId("save-state")).toContainText("已保存", { timeout: 15_000 });

  // 库核：note 推进；引用行不变（id/摘录/快照/capturedAt/field_hash 全部保持）
  const note = await fetchNote(noteId);
  expect(note.title).toBe("只改标题");
  expect(note.version).toBe(3);
  const refAfter = await fetchReference(refId);
  expect(refAfter).toEqual(refBefore);
});

test("⑦ 界面证据截图（编辑/预览/冲突面板；输出目录可配）", async ({ authedPage: page }) => {
  const shotsDir = process.env.STUDY_NOTES_SHOTS_DIR ?? "D:/tmp/n1t-shots";
  mkdirSync(shotsDir, { recursive: true });

  const noteId = await openHostAndCreate(page);
  await page.getByTestId("note-title").fill("截图示例标题");
  await page.getByTestId("note-body").fill("这是一段示例正文。\n\n第二段内容（Markdown 预览将渲染）。");
  await expect(page.getByTestId("save-state")).toContainText("已保存", { timeout: 15_000 });
  await page.screenshot({ path: `${shotsDir}/01-editor.png`, fullPage: true });

  await page.getByRole("button", { name: "预览" }).click();
  await expect(page.getByTestId("note-preview")).toBeVisible();
  await page.screenshot({ path: `${shotsDir}/02-preview.png`, fullPage: true });
  await page.getByRole("button", { name: "返回编辑" }).click();

  // 制造冲突：服务端版本被推进后，旧版本保存 → 冲突面板
  const bumped = await apiSaveNote(page, noteId, {
    expectedVersion: 2,
    requestId: randomUUID(),
    title: "他端更新",
    bodyMd: "他端正文",
    venues: ["cloze"],
    pinned: false,
    status: "active",
    references: [],
  });
  expect(bumped.status).toBe(200);
  await page.getByTestId("note-title").fill("本地旧版本改动");
  await expect(page.getByTestId("conflict-panel")).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: `${shotsDir}/03-conflict.png`, fullPage: true });

  await page.getByRole("button", { name: "载入服务器版本" }).click();
  await expect(page.getByTestId("note-title")).toHaveValue("他端更新", { timeout: 15_000 });
  await page.screenshot({ path: `${shotsDir}/04-after-load-server.png`, fullPage: true });
});

/** 记录 PUT 请求体（用于断言「重试提交的是最新内容」而非旧载荷）。 */
function trackPutRequests(page: Page): { count: () => number; bodies: () => string[] } {
  const bodies: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "PUT" && request.url().includes("/api/l3/study-notes/")) {
      bodies.push(request.postData() ?? "");
    }
  });
  return { count: () => bodies.length, bodies: () => [...bodies] };
}

/** 恢复引用行（E2E ⑨：世界修复）——按原值 INSERT。 */
async function restoreReference(row: Record<string, unknown>): Promise<void> {
  await withAdmin(async (client) => {
    await client.query(
      `INSERT INTO l3_study_note_references
         (id, note_id, user_id, kind, source_id, question_id, option_key, start_offset, end_offset,
          quote_snapshot, field_hash, display_snapshot, captured_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::uuid, $6::uuid, $7, $8, $9, $10, $11, $12::jsonb, $13)`,
      [
        row.id,
        row.note_id,
        row.user_id,
        row.kind,
        row.source_id,
        row.question_id,
        row.option_key,
        row.start_offset,
        row.end_offset,
        row.quote_snapshot,
        row.field_hash,
        JSON.stringify(row.display_snapshot ?? null),
        row.captured_at,
      ],
    );
  });
}

// ⑧ 用户可操作的真实服务端拒绝恢复路径：
//   「输入越界（标题 121 字）→ 服务端确定拒绝 → 用户改短标题 → 重试提交最新内容 → 成功」。
//   用户只用编辑器即可完成恢复；真实 HTTP（400 VALIDATION_ERROR）+ 真实 PG 库核。
test("⑧ 服务端确定拒绝（真实超长标题）→ 修正 → 重试提交最新内容成功", async ({ authedPage: page }) => {
  const noteId = await openHostAndCreate(page);
  const puts = trackPutRequests(page);

  // 真实超限标题（121 > 120）：服务端路由层 schema 拒绝（VALIDATION_ERROR）
  await page.getByTestId("note-title").fill("超".repeat(121));
  await expect(page.getByTestId("error-panel")).toBeVisible({ timeout: 30_000 }); // 真实服务端拒绝
  const panelText = (await page.getByTestId("error-panel").textContent()) ?? "";
  expect(panelText).toContain("服务端拒绝"); // 分类文案（修复前：一律「网络或服务异常」）
  expect(panelText).not.toContain("网络或服务异常");

  // 修正内容 → 显式重试 → 提交最新完整快照
  await page.getByTestId("note-title").fill("修正后的标题");
  await page.getByRole("button", { name: "重试保存" }).click();
  await expect(page.getByTestId("save-state")).toContainText("已保存", { timeout: 15_000 });

  // 请求纪律：恰好 2 次 PUT；第 2 次携带修正后内容（修复前：重发 121 字旧载荷 → 再失败）
  expect(puts.count()).toBe(2);
  expect(puts.bodies()[1]).toContain("修正后的标题");

  const note = await fetchNote(noteId);
  expect(note.title).toBe("修正后的标题");
  expect(note.version).toBe(2); // 创建 1 → 修正保存 2（拒绝不推进版本）
});

// ⑨ 【异常检测用例——非「用户可操作恢复」路径】：keep 引用被服务端删除属「世界损坏」类 422。
//   当前编辑器不提供移除/重建引用（引用工具后置 Task 09），用户无法在界面内自修；
//   本用例验证：真实 422 检测、本地输入保全、错误分类可读、重试提交「最新内容」且恰好 2 次 PUT。
//   恢复需「世界修复」（恢复引用行）——这是异常检测，不作用户可操作恢复的宣称；
//   用户可操作恢复场景由 ⑧（改短标题）、⑤（网络恢复留原位）、④（409 显式载入）覆盖。
test("⑨ 真实 422（keep 引用缺失）→ 本地保全 → 世界修复 + 内容修正 → 重试最新内容成功", async ({ authedPage: page }) => {
  // 种子：question + capture 建立引用（真实 API 生成引用行）
  const sourceId = randomUUID();
  const questionId = randomUUID();
  await withAdmin(async (client) => {
    await client.query(
      `INSERT INTO l3_sources (id, user_id, source_type, title, content_text)
       VALUES ($1::uuid, $2::uuid, 'article', 'E2E 422 来源', '来源正文 C1')`,
      [sourceId, OWNER_ID],
    );
    await client.query(
      `INSERT INTO l3_questions (id, user_id, source_id, file_key, space, question_type, stem, options, answer, evidence)
       VALUES ($1::uuid, $2::uuid, $3::uuid, NULL, '阅读', 'reading_choice', 'E2E 422 题干', '[]'::jsonb, '{}'::jsonb, '[]'::jsonb)`,
      [questionId, OWNER_ID, sourceId],
    );
  });

  await page.goto("/study-note-host");
  const noteId = await apiCreateNote(page);
  const refId = randomUUID();
  const capture = await apiSaveNote(page, noteId, {
    expectedVersion: 1,
    requestId: randomUUID(),
    title: "422 场景",
    bodyMd: `正文\n\n[[ref:${refId}]]\n`,
    venues: ["cloze"],
    pinned: false,
    status: "active",
    references: [{ id: refId, action: "capture", target: { kind: "question", questionId } }],
  });
  expect(capture.status).toBe(200);
  const refBefore = await fetchReference(refId);

  // 打开编辑器（本地持有完整引用与 marker）
  await page.goto(`/study-note-host?noteId=${noteId}`);
  await expect(page.getByTestId("note-title")).toHaveValue("422 场景", { timeout: 15_000 });
  const puts = trackPutRequests(page);

  // 制造 keep 缺失：删除服务端引用行（本地编辑快照仍持有该引用）
  await withAdmin(async (client) => {
    await client.query("DELETE FROM l3_study_note_references WHERE id = $1::uuid", [refId]);
  });

  // 第一次修正 → 保存 → 服务端 keep 校验失败 → 真实 422
  await page.getByTestId("note-title").fill("第一次修正");
  await expect(page.getByTestId("error-panel")).toBeVisible({ timeout: 30_000 });
  const panelText = (await page.getByTestId("error-panel").textContent()) ?? "";
  expect(panelText).toContain("服务端拒绝");
  expect(panelText).toContain("keep 引用必须已属于当前笔记"); // 服务端可读原因（非「网络异常」）
  await expect(page.getByTestId("note-title")).toHaveValue("第一次修正"); // 本地输入保留

  // 世界修复：恢复引用行（原值）
  await restoreReference(refBefore);

  // 内容再修正 → 显式重试 → 提交最新完整快照（修复前：重发旧载荷「第一次修正」）
  await page.getByTestId("note-title").fill("第二次修正");
  await page.getByRole("button", { name: "重试保存" }).click();
  await expect(page.getByTestId("save-state")).toContainText("已保存", { timeout: 15_000 });

  expect(puts.count()).toBe(2); // 422 一次 + 修正后一次（修复前：3 次——旧载荷重试 + 续发新载荷）
  expect(puts.bodies()[1]).toContain("第二次修正");

  const note = await fetchNote(noteId);
  expect(note.title).toBe("第二次修正");
  const refAfter = await fetchReference(refId);
  expect(refAfter).toEqual(refBefore); // 引用行经删除/恢复后与原值一致
});

test("⑩ 在途保存与 IME 组合交错：组合中不发送未完成快照；compositionend 后发送完整内容", async ({ authedPage: page }) => {
  const noteId = await openHostAndCreate(page);
  const puts = trackPutRequests(page);

  // 第一次保存（A）延迟响应，制造在途窗口
  let delayedOnce = false;
  await page.route("**/api/l3/study-notes/*", async (route) => {
    if (route.request().method() === "PUT" && !delayedOnce) {
      delayedOnce = true;
      await new Promise((resolve) => setTimeout(resolve, 1_500));
    }
    await route.continue();
  });

  await page.getByTestId("note-title").fill("在途-A");
  await expect.poll(() => puts.count(), { timeout: 10_000 }).toBe(1); // A 已发出（在途）

  // 在途期间进入 IME 组合并输入未完成内容（合成 composition 事件验证事件路径；
  // 非 OS 输入法人工实测——HTTP/PG 全部真实）
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="note-title"]') as HTMLInputElement;
    el.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
  });
  await page.getByTestId("note-title").fill("组合完成B");

  // 覆盖 A 的 1.5s 延迟响应 + 观察窗口：组合中不得发送新快照
  await page.waitForTimeout(2_200);
  expect(puts.count()).toBe(1); // 修复前：A 确认后立刻发送组合中的快照（2 次）
  await expect(page.getByTestId("save-state")).toContainText("未保存"); // 如实呈现（非「已保存」）

  // 完成组合 → 防抖后发送完整内容
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="note-title"]') as HTMLInputElement;
    el.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
  });
  await expect.poll(() => puts.count(), { timeout: 10_000 }).toBe(2);
  expect(puts.bodies()[1]).toContain("组合完成B");
  await expect(page.getByTestId("save-state")).toContainText("已保存", { timeout: 15_000 });

  const note = await fetchNote(noteId);
  expect(note.title).toBe("组合完成B"); // A 与 B 分次确认（创建 1 → A 2 → B 3）
  expect(note.version).toBe(3);
});
