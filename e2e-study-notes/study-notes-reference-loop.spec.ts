/**
 * Task 09A · 引用闭环 E2E（真实浏览器 + 真实 HTTP + 本批隔离 PG）。
 *
 * 覆盖：分页查找（搜索面板）→ 预览 → 插入引用（marker + capture 原子保存）→
 * 重开一致（库核 references 行）→ 移除 → 重开 → 转普通摘录 → 重开 →
 * unavailable（目标被拒）卡片展示与移除。
 *
 * 纪律：仅在专属空验收库 vocab_study_notes_task08_accept 运行（库身份显式校验）；
 * 故障/延迟仅作用于真实请求（本文件不注入故障）；库核全部经 admin 连接。
 */
import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import pg from "pg";
import { expect, test } from "../e2e/fixtures";

const ADMIN_DB_URL = process.env.E2E_SETUP_DATABASE_URL ?? "";
const EXPECTED_DB = process.env.STUDY_NOTES_E2E_DB ?? "vocab_study_notes_task08_accept";
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

async function countNoteReferences(noteId: string): Promise<number> {
  return withAdmin(async (client) => {
    const result = await client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM l3_study_note_references WHERE note_id = $1::uuid AND user_id = $2::uuid",
      [noteId, OWNER_ID],
    );
    return result.rows[0]!.n;
  });
}

async function fetchNoteBody(noteId: string): Promise<{ bodyMd: string; version: number }> {
  return withAdmin(async (client) => {
    const result = await client.query<{ body_md: string; version: number }>(
      "SELECT body_md, version FROM l3_study_notes WHERE id = $1::uuid AND user_id = $2::uuid",
      [noteId, OWNER_ID],
    );
    if (result.rows.length !== 1) throw new Error(`note ${noteId} 不存在`);
    return { bodyMd: result.rows[0]!.body_md, version: result.rows[0]!.version };
  });
}

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

async function apiSeedNote(page: Page, title: string, venue = "cloze"): Promise<string> {
  const created = await pageApiCall(page, "/api/l3/study-notes", {
    method: "POST",
    body: { requestId: randomUUID(), venue },
  });
  if (created.status !== 201) throw new Error(`创建笔记失败：${created.status}`);
  const item = (created.body as { item: { id: string; version: number } }).item;
  const saved = await pageApiCall(page, `/api/l3/study-notes/${item.id}`, {
    method: "PUT",
    body: {
      expectedVersion: item.version,
      requestId: randomUUID(),
      title,
      bodyMd: "",
      venues: [venue],
      pinned: false,
      status: "active",
      references: [],
    },
  });
  if (saved.status !== 200) throw new Error(`命名失败：${saved.status}`);
  return item.id;
}

/** admin 直插 active source（标题带唯一 marker 便于搜索定位）。 */
async function seedSource(marker: string): Promise<string> {
  const sourceId = randomUUID();
  await withAdmin(async (client) => {
    await client.query(
      `INSERT INTO l3_sources (id, user_id, source_type, title, content_text)
       VALUES ($1::uuid, $2::uuid, 'article', $3, $4)`,
      [sourceId, OWNER_ID, `来源 ${marker}`, `来源正文 ${marker}`],
    );
  });
  return sourceId;
}

async function seedQuestion(marker: string, sourceId: string | null = null): Promise<string> {
  const questionId = randomUUID();
  await withAdmin(async (client) => {
    await client.query(
      `INSERT INTO l3_questions (id, user_id, source_id, file_key, space, question_type, stem, options, answer, evidence)
       VALUES ($1::uuid, $2::uuid, $3::uuid, NULL, '阅读', 'reading_choice', $4, '[]'::jsonb, '{}'::jsonb, '[]'::jsonb)`,
      [questionId, OWNER_ID, sourceId, `题干 ${marker}`],
    );
  });
  return questionId;
}

async function openNote(page: Page, noteId: string): Promise<void> {
  await page.goto(`/l3?section=study-notes&venue=cloze&noteId=${noteId}`);
  await expect(page.getByTestId("note-body")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("save-state")).toContainText("已保存", { timeout: 15_000 });
}

async function waitSaved(page: Page): Promise<void> {
  await expect(page.getByTestId("save-state")).toContainText("已保存", { timeout: 15_000 });
}

async function insertViaPicker(page: Page, searchTerm: string): Promise<void> {
  await page.getByTestId("insert-reference-button").click();
  await expect(page.getByTestId("reference-picker")).toBeVisible({ timeout: 10_000 });
  await page.getByTestId("ref-picker-q").fill(searchTerm);
  const item = page.getByTestId("ref-picker-item").first();
  await expect(item).toBeVisible({ timeout: 15_000 });
  await item.click();
  await expect(page.getByTestId("ref-preview-card")).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("ref-picker-insert").click();
  await expect(page.getByTestId("reference-picker")).toHaveCount(0, { timeout: 10_000 }); // 插入后关闭
}

test.beforeAll(async () => {
  await withAdmin(async (client) => {
    await client.query("BEGIN");
    await client.query("DELETE FROM l3_study_note_references WHERE user_id = $1::uuid", [OWNER_ID]);
    await client.query("DELETE FROM l3_study_topic_notes WHERE user_id = $1::uuid", [OWNER_ID]);
    await client.query("DELETE FROM l3_study_topics WHERE user_id = $1::uuid", [OWNER_ID]);
    await client.query("DELETE FROM l3_study_note_venues WHERE user_id = $1::uuid", [OWNER_ID]);
    await client.query("DELETE FROM l3_study_notes WHERE user_id = $1::uuid", [OWNER_ID]);
    await client.query("COMMIT");
  });
});

test("① 搜索→预览→插入→保存→重开一致（marker + 卡片 + 库核）", async ({ authedPage: page }) => {
  test.setTimeout(120_000);
  const marker = `T09A-${Date.now()}`;
  const sourceId = await seedSource(marker);
  const noteId = await apiSeedNote(page, `${marker} 引用笔记`);

  await openNote(page, noteId);
  await insertViaPicker(page, marker);

  // 正文出现 marker；保存后落库
  await waitSaved(page);
  const bodyAfterInsert = (await page.getByTestId("note-body").inputValue());
  const markerMatch = /\[\[ref:([0-9a-f-]{36})\]\]/.exec(bodyAfterInsert);
  expect(markerMatch).not.toBeNull();
  const refId = markerMatch![1]!;

  await expect.poll(() => countNoteReferences(noteId), { timeout: 15_000 }).toBe(1);
  await withAdmin(async (client) => {
    const result = await client.query<{ kind: string; source_id: string }>(
      "SELECT kind, source_id::text AS source_id FROM l3_study_note_references WHERE id = $1::uuid AND user_id = $2::uuid",
      [refId, OWNER_ID],
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.kind).toBe("source");
    expect(result.rows[0]!.source_id).toBe(sourceId);
  });

  // 重开（F5）一致：marker + 卡片（current）+ 计数
  await page.reload();
  await expect(page.getByTestId("note-body")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("note-body")).toHaveValue(/\[\[ref:/, { timeout: 15_000 });
  await expect(page.getByText(/引用 1 条/)).toBeTruthy();
  await page.getByText("预览").click();
  const card = page.getByTestId("reference-placeholder");
  await expect(card).toHaveCount(1);
  await expect(card).toContainText(`来源 ${marker}`);
  await expect(page.getByTestId("ref-card-remove")).toBeVisible();
});

test("② 移除引用→保存→重开（marker 与库行同消失）", async ({ authedPage: page }) => {
  test.setTimeout(120_000);
  const marker = `T09A-RM-${Date.now()}`;
  await seedSource(marker);
  const noteId = await apiSeedNote(page, `${marker} 移除用例`);

  await openNote(page, noteId);
  await insertViaPicker(page, marker);
  await waitSaved(page);
  await expect.poll(() => countNoteReferences(noteId), { timeout: 15_000 }).toBe(1);

  // 预览 → 移除 → 保存 → 库核 0
  await page.getByText("预览").click();
  await page.getByTestId("ref-card-remove").click();
  await page.getByText("返回编辑").click();
  await expect(page.getByTestId("note-body")).not.toHaveValue(/\[\[ref:/, { timeout: 10_000 });
  await waitSaved(page);
  await expect.poll(() => countNoteReferences(noteId), { timeout: 15_000 }).toBe(0);

  await page.reload();
  await expect(page.getByTestId("note-body")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("note-body")).not.toHaveValue(/\[\[ref:/);
  const persisted = await fetchNoteBody(noteId);
  expect(persisted.bodyMd).not.toContain("[[ref:");
});

test("③ 转普通摘录→保存→重开（摘录保留、引用移除）", async ({ authedPage: page }) => {
  test.setTimeout(120_000);
  const marker = `T09A-CV-${Date.now()}`;
  await seedSource(marker);
  const noteId = await apiSeedNote(page, `${marker} 转换用例`);

  await openNote(page, noteId);
  await insertViaPicker(page, marker);
  await waitSaved(page);

  await page.getByText("预览").click();
  await page.getByTestId("ref-card-convert").click();
  await page.getByText("返回编辑").click();
  await waitSaved(page);

  const persisted = await fetchNoteBody(noteId);
  expect(persisted.bodyMd).not.toContain("[[ref:");
  expect(persisted.bodyMd).toContain("> —— 来源"); // 摘录行（source 快照）
  expect(await countNoteReferences(noteId)).toBe(0);

  await page.reload();
  await expect(page.getByTestId("note-body")).toHaveValue(/> —— 来源/, { timeout: 15_000 });
});

test("④ unavailable 目标（被拒题目）：卡片显示已失效、保留旧摘录、可移除且保存成功", async ({ authedPage: page }) => {
  test.setTimeout(120_000);
  const marker = `T09A-UA-${Date.now()}`;
  const sourceId = await seedSource(marker); // identity_check：question 必须挂 source 或 file_key
  const questionId = await seedQuestion(marker, sourceId);
  const noteId = await apiSeedNote(page, `${marker} 失效用例`);

  // 经真实 API capture（服务端生成引用行；版本取当前值——seed 命名已推进到 v2）
  await page.goto(`/l3?section=study-notes&venue=cloze`);
  const refId = randomUUID();
  const current = await fetchNoteBody(noteId);
  const withRef = await pageApiCall(page, `/api/l3/study-notes/${noteId}`, {
    method: "PUT",
    body: {
      expectedVersion: current.version,
      requestId: randomUUID(),
      title: `${marker} 失效用例`,
      bodyMd: `正文\n\n[[ref:${refId}]]\n`,
      venues: ["cloze"],
      pinned: false,
      status: "active",
      references: [{ id: refId, action: "capture", target: { kind: "question", questionId } }],
    },
  });
  expect(withRef.status).toBe(200);

  // 目标被拒 → unavailable
  await withAdmin(async (client) => {
    await client.query("UPDATE l3_questions SET status='rejected' WHERE id = $1::uuid", [questionId]);
  });

  await openNote(page, noteId);
  await page.getByText("预览").click();
  const card = page.getByTestId("reference-placeholder");
  await expect(card).toContainText("引用已失效");
  await expect(card).toContainText(`题干 ${marker}`); // 旧摘录保留
  await expect(page.getByTestId("ref-card-remove")).toBeVisible(); // 可移除

  await page.getByTestId("ref-card-remove").click();
  await page.getByText("返回编辑").click();
  await waitSaved(page);
  expect(await countNoteReferences(noteId)).toBe(0);
  const persisted = await fetchNoteBody(noteId);
  expect(persisted.bodyMd).not.toContain("[[ref:");
});

test("⑤ changed 目标（来源被改名）：卡片显示已变化 + liveTitle 对照，快照旧摘录保留", async ({ authedPage: page }) => {
  test.setTimeout(120_000);
  const marker = `T09A-CH-${Date.now()}`;
  const sourceId = await seedSource(marker);
  const noteId = await apiSeedNote(page, `${marker} 变化用例`);

  // 经真实 API capture（同 ④：命名已推进到 v2，动态取当前版本）
  await page.goto(`/l3?section=study-notes&venue=cloze`);
  const refId = randomUUID();
  const current = await fetchNoteBody(noteId);
  const withRef = await pageApiCall(page, `/api/l3/study-notes/${noteId}`, {
    method: "PUT",
    body: {
      expectedVersion: current.version,
      requestId: randomUUID(),
      title: `${marker} 变化用例`,
      bodyMd: `正文\n\n[[ref:${refId}]]\n`,
      venues: ["cloze"],
      pinned: false,
      status: "active",
      references: [{ id: refId, action: "capture", target: { kind: "source", sourceId } }],
    },
  });
  expect(withRef.status).toBe(200);

  // 来源正文与标题均改 → 服务端 preview 判定 changed（content_text 哈希不符；liveTitle=新标题）
  await withAdmin(async (client) => {
    await client.query("UPDATE l3_sources SET title = $1, content_text = $2 WHERE id = $3::uuid", [
      `改名后 ${marker}`,
      `改后正文 ${marker}`,
      sourceId,
    ]);
  });

  await openNote(page, noteId);
  await page.getByText("预览").click();
  const card = page.getByTestId("reference-placeholder");
  await expect(card).toContainText("内容已变化");
  await expect(card).toContainText(`来源 ${marker}`); // 快照旧标题/摘录保留
  await expect(card).toContainText(`当前来源：改名后 ${marker}`); // liveTitle 对照
});
