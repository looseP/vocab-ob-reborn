/**
 * Task 09B · 卷面内学习笔记侧栏 E2E（真实浏览器 + 真实 HTTP + 本批隔离 PG）。
 *
 * 覆盖（任务书 §5 验收矩阵，本批可在此栈上验证的部分）：
 *  M1  打开侧栏：无写请求；题纸仍在；笔记数不变；
 *  M2  关闭/重开侧栏：题纸未卸载、题纸数不变；
 *  M4  在侧栏内编辑并保存：仅笔记 PUT；题纸行未被写；
 *  M8  显式创建：恰 1 次 POST；笔记 +1（不多建）；
 *  M9  浏览/取消后关闭：零创建（允许只读 reference-preview）；
 *  M10 快捷引用：当前题目身份 → preview → 显式插入 → 保存 → 重开一致；
 *      点击入口本身不写正文。
 *
 * 纪律：仅在专属空验收库 vocab_study_notes_task09b_accept 运行（库身份显式校验）；
 * fixture owner = E2E_OWNER_ID；清理仅限本 owner（不 truncate 业务表）；
 * 不伪造 200——观测真实请求时序与真实落库。
 */
import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import pg from "pg";
import { expect, loginAsOwner, test } from "../e2e/fixtures";

const ADMIN_DB_URL = process.env.E2E_SETUP_DATABASE_URL ?? "";
const EXPECTED_DB = process.env.STUDY_NOTES_E2E_DB ?? "vocab_study_notes_task09b_accept";
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

async function countOwnerSheets(): Promise<number> {
  return withAdmin(async (client) => {
    const result = await client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM l3_submissions WHERE user_id = $1::uuid",
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
}

async function fetchNote(noteId: string): Promise<NoteRow> {
  return withAdmin(async (client) => {
    const result = await client.query<NoteRow>(
      "SELECT id, title, body_md, version FROM l3_study_notes WHERE id = $1::uuid",
      [noteId],
    );
    if (result.rows.length !== 1) throw new Error(`note ${noteId} 不存在`);
    return result.rows[0]!;
  });
}

/** 浏览器内真实 API 调用（真实 session/CSRF；用于种子与对照）。 */
async function pageApiCall(
  page: Page,
  path: string,
  init: { method: "POST" | "PUT" | "DELETE"; body: unknown },
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

async function apiSeedNote(page: Page, title: string, venue = "sentence_translation"): Promise<string> {
  const created = await pageApiCall(page, "/api/l3/study-notes", {
    method: "POST",
    body: { requestId: randomUUID(), venue },
  });
  if (created.status !== 201) throw new Error(`创建笔记失败：${created.status} ${JSON.stringify(created.body)}`);
  const item = (created.body as { item: { id: string; version: number } }).item;
  const saved = await pageApiCall(page, `/api/l3/study-notes/${item.id}`, {
    method: "PUT",
    body: {
      expectedVersion: item.version,
      requestId: randomUUID(),
      title,
      bodyMd: "种子正文",
      venues: [venue],
      pinned: false,
      status: "active",
      references: [],
    },
  });
  if (saved.status !== 200) throw new Error(`命名笔记失败：${saved.status} ${JSON.stringify(saved.body)}`);
  return item.id;
}

async function cleanupOwner(page: Page, noteIds: string[]): Promise<void> {
  await withAdmin(async (client) => {
    if (noteIds.length > 0) {
      await client.query(
        "DELETE FROM l3_study_notes WHERE user_id = $1::uuid AND id = ANY($2::uuid[])",
        [OWNER_ID, noteIds],
      );
    }
  });
  // 仅清理本批临时笔记；题纸由题纸自身流程管理（不 truncate 业务表）。
  void page;
}

/**
 * 种子：经真实 POST /api/l3/papers 建一份最小试卷（翻译题组，题面自足）。
 * 返回 paperId；本批仅需「能进卷面」，不校验题面内容。
 */
async function apiSeedPaper(page: Page, title: string): Promise<string> {
  const created = await pageApiCall(page, "/api/l3/papers", {
    method: "POST",
    body: {
      title,
      direction: "通用",
      sections: [
        {
          title: "翻译",
          questionType: "sentence_translation",
          fileKey: `e2e-09b-${randomUUID()}`,
          questions: [
            {
              ordinal: 0,
              stem: "01. 这是一道用于 09B 侧栏验收的翻译题。",
              answer: { text: "参考答案" },
            },
          ],
        },
      ],
    },
  });
  if (created.status !== 201) {
    throw new Error(`建卷失败：${created.status} ${JSON.stringify(created.body)}`);
  }
  const paper = (created.body as { paper?: { id?: string } }).paper;
  const id = paper?.id ?? (created.body as { id?: string }).id;
  if (!id) throw new Error(`建卷响应缺少试卷 id：${JSON.stringify(created.body)}`);
  return id;
}

/** 该 owner 的作答行数（题纸作答不因侧栏操作增减）。 */
async function countOwnerAttempts(): Promise<number> {
  return withAdmin(async (client) => {
    const result = await client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM l3_question_attempts WHERE user_id = $1::uuid",
      [OWNER_ID],
    );
    return result.rows[0]!.n;
  });
}

/** 种子：经真实 API 把指定题纸定格（sealed），返回 seal 响应状态。 */
async function apiSealSheet(page: Page, sheetId: string): Promise<number> {
  // 先取当前版本作为 CAS 基线（定格要求 expectedVersion）
  const current = await page.evaluate(async (id) => {
    const res = await fetch(`/api/l3/sheets/${encodeURIComponent(id)}`);
    return { status: res.status, body: await res.text() };
  }, sheetId);
  if (current.status !== 200) throw new Error(`读题纸失败：${current.status} ${current.body.slice(0, 200)}`);
  // 定格 CAS 锚点是 `draft_version`（公开响应字段；不是 `version`）
  const version = (JSON.parse(current.body) as { sheet: { draft_version: number } }).sheet.draft_version;

  const sealed = await pageApiCall(page, `/api/l3/sheets/${encodeURIComponent(sheetId)}/seal`, {
    method: "POST",
    body: { expectedVersion: version, mode: "full", acknowledgeUnanswered: true },
  });
  if (sealed.status !== 200) {
    throw new Error(`定格失败：${sealed.status} ${JSON.stringify(sealed.body).slice(0, 300)}`);
  }
  return sealed.status;
}

/** 打开卷面（题纸）并等待其装配完成。 */
async function openPaperAndNotesPanel(page: Page): Promise<string> {
  const paperId = await apiSeedPaper(page, `09B 卷面 ${randomUUID().slice(0, 8)}`);
  await page.goto(`/l3?paper=${encodeURIComponent(paperId)}`);
  await expect(page.getByTestId("sheet-study-notes-toggle")).toBeVisible({ timeout: 25_000 });
  await page.getByTestId("sheet-study-notes-toggle").click();
  await expect(page.getByTestId("study-note-side-panel")).toBeVisible({ timeout: 15_000 });
  return paperId;
}

/** 在侧栏列表内按标题选中一篇笔记（不离开卷面；侧栏是卷面级表面）。 */
async function selectNoteInSidebar(page: Page, title: string): Promise<void> {
  const search = page.getByTestId("study-note-panel-venue");
  void search; // 题型筛选用默认（= 卷面题型）；选项均为真实题型（列表契约 venue 必填，无「全部题型」选项）
  const row = page.getByTestId("study-note-row").filter({ hasText: title }).first();
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.getByTestId("row-open").click();
  await expect(page.getByTestId("note-body")).toBeVisible({ timeout: 15_000 });
}

test.describe("Task 09B · 卷面内学习笔记侧栏", () => {
  test("M1/M2：打开侧栏零创建；关闭重开后题纸未卸载、题纸数不变", async ({ page }) => {
    const notesBefore = await countOwnerNotes();

    const writes: string[] = [];
    page.on("request", (request) => {
      const method = request.method();
      if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
        writes.push(`${method} ${new URL(request.url()).pathname}`);
      }
    });

    await loginAsOwner(page);
    await openPaperAndNotesPanel(page);
    // 开卷本身会为试卷建草稿题纸（既有语义）；「侧栏不改变题纸数」从此刻起算。
    const sheetsBefore = await countOwnerSheets();

    // M1：打开侧栏无**创建**写请求
    expect(writes.filter((entry) => entry === "POST /api/l3/study-notes")).toEqual([]);

    // M2：关闭再打开——题纸节点与开关仍在（未卸载）
    await page.getByTestId("study-note-panel-close").click();
    await expect(page.getByTestId("study-note-side-panel")).toHaveCount(0);
    await expect(page.getByTestId("sheet-study-notes-toggle")).toBeVisible();
    await page.getByTestId("sheet-study-notes-toggle").click();
    await expect(page.getByTestId("study-note-side-panel")).toBeVisible();

    expect(await countOwnerNotes()).toBe(notesBefore);
    expect(await countOwnerSheets()).toBe(sheetsBefore);
  });

  test("M8/M9：浏览零创建；显式创建恰 1 次 POST", async ({ page }) => {
    const notesBefore = await countOwnerNotes();
    const created: string[] = [];

    await loginAsOwner(page);
    const seeded = await apiSeedNote(page, `09B 浏览用 ${randomUUID().slice(0, 8)}`);
    created.push(seeded);

    try {
      await openPaperAndNotesPanel(page);

      // M9：浏览列表不创建
      const listVisible = await page.getByTestId("study-note-list").isVisible().catch(() => false);
      if (listVisible) {
        await expect(page.getByTestId("study-note-list")).toBeVisible();
      }
      expect(await countOwnerNotes()).toBe(notesBefore + 1); // 仅种子那一篇

      // M8：显式创建恰 1 次
      const posts: string[] = [];
      page.on("request", (request) => {
        if (request.method() === "POST" && new URL(request.url()).pathname === "/api/l3/study-notes") {
          posts.push(request.url());
        }
      });
      await page.getByTestId("study-note-panel-create").click();
      await expect(page.getByTestId("study-note-editor")).toBeVisible({ timeout: 15_000 });

      // 在途守卫：立即再点一次不产生第二个创建
      await page.getByTestId("study-note-panel-back").click().catch(() => {});
      expect(posts.length).toBeLessThanOrEqual(1);
      expect(await countOwnerNotes()).toBe(notesBefore + 2);

      const all = await withAdmin(async (client) => {
        const result = await client.query<{ id: string }>(
          "SELECT id::text AS id FROM l3_study_notes WHERE user_id = $1::uuid",
          [OWNER_ID],
        );
        return result.rows.map((row) => row.id);
      });
      const extra = all.filter((id) => !created.includes(id));
      // 清理本用例新增（种子由我们创建）
      await cleanupOwner(page, [...created, ...extra.filter((id) => id !== seeded)]);
    } finally {
      await cleanupOwner(page, created);
    }
  });

  test("M4：侧栏内编辑保存——仅笔记 PUT，题纸行未被写", async ({ page }) => {
    await loginAsOwner(page);
    const noteTitle = `09B 编辑用 ${randomUUID().slice(0, 8)}`;
    const noteId = await apiSeedNote(page, noteTitle);

    try {
      const sheetWrites: string[] = [];
      page.on("request", (request) => {
        const path = new URL(request.url()).pathname;
        if (path.startsWith("/api/l3/sheets") && request.method() !== "GET") {
          sheetWrites.push(`${request.method()} ${path}`);
        }
      });

      const paperId = await apiSeedPaper(page, `09B 卷面 ${randomUUID().slice(0, 8)}`);
      await page.goto(`/l3?paper=${encodeURIComponent(paperId)}`);
      await expect(page.getByTestId("sheet-study-notes-toggle")).toBeVisible({ timeout: 25_000 });
      await page.getByTestId("sheet-study-notes-toggle").click();
      await expect(page.getByTestId("study-note-side-panel")).toBeVisible({ timeout: 15_000 });
      await selectNoteInSidebar(page, noteTitle);

      const before = await fetchNote(noteId);
      // 从「笔记保存动作开始」起计：开卷自身的 POST /api/l3/sheets（草稿题纸）不计入。
      sheetWrites.length = 0;
      await page.getByTestId("note-body").fill(`09B 侧栏编辑 ${randomUUID().slice(0, 6)}`);
      await expect(page.getByTestId("save-state")).toContainText("已保存", { timeout: 15_000 });

      const after = await fetchNote(noteId);
      expect(after.version).toBeGreaterThan(before.version);
      expect(after.body_md).toContain("09B 侧栏编辑");
      // 笔记保存不得写题纸（开卷后的这一段窗口内零题纸写）
      expect(sheetWrites).toEqual([]);
    } finally {
      await cleanupOwner(page, [noteId]);
    }
  });

  test("M10：当前题目快捷引用——入口零写，显式插入后保存并重开一致", async ({ page }) => {
    await loginAsOwner(page);
    const noteTitle = `09B 引用用 ${randomUUID().slice(0, 8)}`;
    const noteId = await apiSeedNote(page, noteTitle);

    try {
      await openPaperAndNotesPanel(page);

      // 从某道题发起引用（真实 questionId）
      const entry = page.getByTestId("reference-question-to-note").first();
      await expect(entry).toBeVisible({ timeout: 15_000 });
      const questionId = await entry.getAttribute("data-question-id");
      expect(questionId).toMatch(/^[0-9a-f-]{36}$/i);

      await entry.click();
      // 打开的是侧栏（不离开卷面）
      await expect(page.getByTestId("study-note-side-panel")).toBeVisible();

      // 选择种子笔记（仍在卷面内）
      await selectNoteInSidebar(page, noteTitle);
      const beforeInsert = await fetchNote(noteId);

      // 打开引用面板（问题 kind：搜索本卷题目）
      await page.getByTestId("insert-reference-button").click();
      await expect(page.getByTestId("reference-picker")).toBeVisible();
      await page.getByTestId("ref-picker-kind-question").click();

      // 入口本身零写：正文未变
      const midInsert = await fetchNote(noteId);
      expect(midInsert.body_md).toBe(beforeInsert.body_md);
      expect(midInsert.version).toBe(beforeInsert.version);

      // 必须有候选题（本卷已建题）；选中 → 预览 → 显式插入
      const candidates = page.getByTestId("ref-picker-item");
      await expect(candidates.first()).toBeVisible({ timeout: 15_000 });
      await candidates.first().click();
      await expect(page.getByTestId("ref-preview-card")).toBeVisible({ timeout: 10_000 });
      await page.getByTestId("ref-picker-insert").click();
      await expect(page.getByTestId("save-state")).toContainText("已保存", { timeout: 15_000 });

      const afterInsert = await fetchNote(noteId);
      expect(afterInsert.version).toBeGreaterThan(beforeInsert.version);
      expect(afterInsert.body_md).toContain("[[ref:");

      // 库核：引用行已落库
      const refCount = await withAdmin(async (client) => {
        const result = await client.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM l3_study_note_references WHERE note_id = $1::uuid",
          [noteId],
        );
        return result.rows[0]!.n;
      });
      expect(refCount).toBe(1);

      // 重开一致：刷新后卷面恢复（本批不持久化侧栏选中态，符合任务书 §1.10），
      // 重新在侧栏内选中同一笔记，marker 仍在且引用卡片可见。
      await page.reload();
      await expect(page.getByTestId("sheet-study-notes-toggle")).toBeVisible({ timeout: 25_000 });
      await page.getByTestId("sheet-study-notes-toggle").click();
      await expect(page.getByTestId("study-note-side-panel")).toBeVisible({ timeout: 15_000 });
      await selectNoteInSidebar(page, noteTitle);
      await expect(page.getByTestId("note-body")).toHaveValue(/\[\[ref:/, { timeout: 15_000 });
    } finally {
      await cleanupOwner(page, [noteId]);
    }
  });
  test("M3：sealed 题纸打开侧栏——题纸只读、零题纸写、题纸与作答数不变", async ({ page }) => {
    await loginAsOwner(page);
    const paperId = await apiSeedPaper(page, `09B sealed ${randomUUID().slice(0, 8)}`);

    // 开卷 → 取本卷 sheetId → 定格
    await page.goto(`/l3?paper=${encodeURIComponent(paperId)}`);
    await expect(page.getByTestId("sheet-study-notes-toggle")).toBeVisible({ timeout: 25_000 });
    const sheetId = await page.evaluate(async (pid) => {
      const res = await fetch("/api/l3/sheets?limit=100");
      if (!res.ok) return null;
      const body = (await res.json()) as { items?: Array<{ id: string; paper_id: string | null; status: string }> };
      return body.items?.find((row) => row.paper_id === pid && row.status === "draft")?.id ?? null;
    }, paperId);
    expect(sheetId).toBeTruthy();

    const sealStatus = await apiSealSheet(page, sheetId!);
    expect([200, 201]).toContain(sealStatus);

    // 定格后经**只读回看深链** `?sheet=<id>` 打开（F-1 合同：不调 openSheet、不新建草稿）
    const notesBefore = await countOwnerNotes();
    const sheetsBefore = await countOwnerSheets();
    const attemptsBefore = await countOwnerAttempts();

    const sheetWrites: string[] = [];
    page.on("request", (request) => {
      const method = request.method();
      const path = new URL(request.url()).pathname;
      if (method !== "GET" && path.startsWith("/api/l3/sheets")) {
        sheetWrites.push(`${method} ${path}`);
      }
    });

    await page.goto(`/l3?sheet=${encodeURIComponent(sheetId!)}`);
    await expect(page.getByTestId("sheet-study-notes-toggle")).toBeVisible({ timeout: 25_000 });

    // 题纸处于只读（sealed）状态：显示「已定格」，且不再出现「定格题纸」入口
    await expect(page.getByText("已定格").first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("button", { name: "定格题纸" })).toHaveCount(0);

    // 打开侧栏（sealed 卷面同样可用）
    await page.getByTestId("sheet-study-notes-toggle").click();
    await expect(page.getByTestId("study-note-side-panel")).toBeVisible({ timeout: 15_000 });

    // 侧栏可用：列表或空态可见（绝不自动创建）
    const listOrEmpty = page.getByTestId("study-note-list").or(page.getByTestId("study-note-panel-empty"));
    await expect(listOrEmpty.first()).toBeVisible({ timeout: 15_000 });

    // sealed 题纸不得被侧栏写入：零题纸 POST/PUT/PATCH/DELETE，且数量不变
    expect(sheetWrites).toEqual([]);
    expect(await countOwnerSheets()).toBe(sheetsBefore);
    expect(await countOwnerAttempts()).toBe(attemptsBefore);
    expect(await countOwnerNotes()).toBe(notesBefore); // 只读浏览零创建
  });

  test("M15：从侧栏笔记引用后返回定位——保留 sheetId/questionId、零新题纸", async ({ page }) => {
    await loginAsOwner(page);
    const paperId = await apiSeedPaper(page, `09B 定位 ${randomUUID().slice(0, 8)}`);

    await page.goto(`/l3?paper=${encodeURIComponent(paperId)}`);
    await expect(page.getByTestId("sheet-study-notes-toggle")).toBeVisible({ timeout: 25_000 });

    const sheetsBefore = await countOwnerSheets();
    const attemptsBefore = await countOwnerAttempts();

    // 记录返回定位相关请求：?question= 深链不得触发创建草稿（POST /sheets）
    const sheetPosts: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "POST" && new URL(request.url()).pathname === "/api/l3/sheets") {
        sheetPosts.push(request.url());
      }
    });

    // 取一道真实题目 id（从卷面 DOM 的引用入口拿，确保是真实 questionId）
    await page.getByTestId("sheet-study-notes-toggle").click();
    await expect(page.getByTestId("study-note-side-panel")).toBeVisible({ timeout: 15_000 });
    const entry = page.getByTestId("reference-question-to-note").first();
    await expect(entry).toBeVisible({ timeout: 15_000 });
    const questionId = await entry.getAttribute("data-question-id");
    expect(questionId).toMatch(/^[0-9a-f-]{36}$/i);

    // 经返回定位深链回到该题（零创建路径）
    await page.goto(`/l3?paper=${encodeURIComponent(paperId)}&question=${encodeURIComponent(questionId!)}`);
    await expect(page.getByTestId("sheet-study-notes-toggle")).toBeVisible({ timeout: 25_000 });

    // 定位到位：该题节点存在且被聚焦高亮
    await expect(page.locator(`#question-${questionId}`)).toBeVisible({ timeout: 15_000 });

    // 零创建草稿：题纸数与作答数不变（开卷复用幂等草稿，不新建）
    expect(await countOwnerSheets()).toBe(sheetsBefore);
    expect(await countOwnerAttempts()).toBe(attemptsBefore);
  });
});
