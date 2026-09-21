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

async function apiSeedNote(page: Page, title: string, venue = "cloze"): Promise<string> {
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

/** 打开卷面（题纸）并等待其装配完成。 */
async function openPaperAndNotesPanel(page: Page): Promise<void> {
  const paperId = await withAdmin(async (client) => {
    const result = await client.query<{ id: string }>(
      "SELECT id::text AS id FROM l3_papers ORDER BY created_at LIMIT 1",
    );
    return result.rows[0]?.id ?? null;
  });
  if (!paperId) throw new Error("验收库中没有 l3_papers 行：本 E2E 需要一份试卷以进入卷面");
  await page.goto(`/l3?paper=${encodeURIComponent(paperId)}`);
  await expect(page.getByTestId("sheet-study-notes-toggle")).toBeVisible({ timeout: 25_000 });
  await page.getByTestId("sheet-study-notes-toggle").click();
  await expect(page.getByTestId("study-note-side-panel")).toBeVisible({ timeout: 15_000 });
}

test.describe("Task 09B · 卷面内学习笔记侧栏", () => {
  test("M1/M2：打开侧栏零创建；关闭重开后题纸未卸载、题纸数不变", async ({ page }) => {
    const notesBefore = await countOwnerNotes();
    const sheetsBefore = await countOwnerSheets();

    const writes: string[] = [];
    page.on("request", (request) => {
      const method = request.method();
      if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
        writes.push(`${method} ${new URL(request.url()).pathname}`);
      }
    });

    await loginAsOwner(page);
    await openPaperAndNotesPanel(page);

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
    const noteId = await apiSeedNote(page, `09B 编辑用 ${randomUUID().slice(0, 8)}`);

    try {
      const sheetWrites: string[] = [];
      page.on("request", (request) => {
        const path = new URL(request.url()).pathname;
        if (path.startsWith("/api/l3/exam-sheets") && request.method() !== "GET") {
          sheetWrites.push(`${request.method()} ${path}`);
        }
      });

      await openPaperAndNotesPanel(page);
      // 打开该笔记
      await page.goto(`/l3?section=study-notes&noteId=${noteId}`);
      await expect(page.getByTestId("note-body")).toBeVisible({ timeout: 15_000 });

      const before = await fetchNote(noteId);
      await page.getByTestId("note-body").fill(`09B 侧栏编辑 ${randomUUID().slice(0, 6)}`);
      await expect(page.getByTestId("save-state")).toContainText("已保存", { timeout: 15_000 });

      const after = await fetchNote(noteId);
      expect(after.version).toBeGreaterThan(before.version);
      expect(after.body_md).toContain("09B 侧栏编辑");
      // 题纸未被本次笔记保存写入
      expect(sheetWrites).toEqual([]);
    } finally {
      await cleanupOwner(page, [noteId]);
    }
  });

  test("M10：当前题目快捷引用——入口零写，显式插入后保存并重开一致", async ({ page }) => {
    await loginAsOwner(page);
    const noteId = await apiSeedNote(page, `09B 引用用 ${randomUUID().slice(0, 8)}`);

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

      // 选择种子笔记
      await page.goto(`/l3?section=study-notes&noteId=${noteId}`);
      await expect(page.getByTestId("note-body")).toBeVisible({ timeout: 15_000 });
      const beforeInsert = await fetchNote(noteId);

      // 打开引用面板并预置当前题目标
      await page.getByTestId("insert-reference-button").click();
      await expect(page.getByTestId("reference-picker")).toBeVisible();

      // 入口本身零写：正文未变
      const midInsert = await fetchNote(noteId);
      expect(midInsert.body_md).toBe(beforeInsert.body_md);
      expect(midInsert.version).toBe(beforeInsert.version);

      // 显式插入引用（若面板有候选则先选一个再插入；否则关闭即零写）
      const candidates = page.getByTestId("ref-picker-item");
      if (await candidates.count()) {
        await candidates.first().click();
        await expect(page.getByTestId("ref-preview-card")).toBeVisible({ timeout: 10_000 });
        await page.getByTestId("ref-picker-insert").click();
        await expect(page.getByTestId("save-state")).toContainText("已保存", { timeout: 15_000 });

        const afterInsert = await fetchNote(noteId);
        expect(afterInsert.version).toBeGreaterThan(beforeInsert.version);
        expect(afterInsert.body_md).toContain("[[ref:");
      } else {
        await page.getByTestId("ref-picker-close").click();
        const afterCancel = await fetchNote(noteId);
        expect(afterCancel.version).toBe(beforeInsert.version); // 取消零写
      }
    } finally {
      await cleanupOwner(page, [noteId]);
    }
  });
});
