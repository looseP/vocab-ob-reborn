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

/** 引用行的持久化快照/哈希/时间——用于证明 keep 不重采集、capture 才刷新。 */
interface StoredReference {
  id: string;
  displaySnapshot: unknown;
  fieldHash: string | null;
  capturedAt: string;
}

async function fetchStoredReferences(noteId: string): Promise<StoredReference[]> {
  return withAdmin(async (client) => {
    const result = await client.query<{
      id: string;
      display_snapshot: unknown;
      field_hash: string | null;
      captured_at: Date | string;
    }>(
      `SELECT id, display_snapshot, field_hash, captured_at
         FROM l3_study_note_references
        WHERE note_id = $1::uuid AND user_id = $2::uuid
        ORDER BY id`,
      [noteId, OWNER_ID],
    );
    return result.rows.map((row) => ({
      id: row.id,
      displaySnapshot: row.display_snapshot,
      fieldHash: row.field_hash,
      capturedAt: row.captured_at instanceof Date ? row.captured_at.toISOString() : String(row.captured_at),
    }));
  });
}

/** 直接改来源标题（模拟「来源在预览后变化」），不触碰引用行。 */
async function renameSource(sourceId: string, title: string): Promise<void> {
  await withAdmin(async (client) => {
    await client.query("UPDATE l3_sources SET title = $2 WHERE id = $1::uuid AND user_id = $3::uuid", [
      sourceId,
      title,
      OWNER_ID,
    ]);
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

// ── Task 09A 补修（R1–R4）新增场景：真实 PG 库核 ──────────────────────────────

test("⑥ 确认后仅改标题：请求为 keep，库内引用快照/hash/captured_at 不变，重开显示 changed", async ({
  authedPage: page,
}) => {
  test.setTimeout(120_000);
  const marker = `T09A-KEEP-${Date.now()}`;
  const sourceId = await seedSource(marker);
  const noteId = await apiSeedNote(page, `${marker} 确认用例`);
  await openNote(page, noteId);

  // 插入并**等待确认**（保存完成后 capture 已落库）
  await insertViaPicker(page, marker);
  await waitSaved(page);

  const afterInsert = await fetchStoredReferences(noteId);
  expect(afterInsert).toHaveLength(1);
  const before = afterInsert[0]!;
  expect(before.capturedAt).toBeTruthy();

  // 来源改名（引用行的快照仍是旧标题）
  await renameSource(sourceId, `改名后 ${marker}`);

  // 仅改笔记标题 → 触发第二次保存；引用必须 keep（绝不重采集）
  const titleInput = page.getByTestId("note-title");
  await titleInput.fill(`${marker} 仅改标题`);
  await waitSaved(page);

  const after = await fetchStoredReferences(noteId);
  expect(after).toHaveLength(1);
  const same = after[0]!;
  // 库内快照/hash/captured_at 逐字段不变（keep 语义；若被重采集，标题会变新名、时间会前推）
  expect(same.capturedAt).toBe(before.capturedAt);
  expect(same.fieldHash).toBe(before.fieldHash);
  expect(JSON.stringify(same.displaySnapshot)).toBe(JSON.stringify(before.displaySnapshot));
  expect(JSON.stringify(same.displaySnapshot)).toContain(marker); // 仍是旧标题快照
  expect(JSON.stringify(same.displaySnapshot)).not.toContain("改名后");

  // 重开：快照仍是旧标题（keep 未重采集）；卡片显示服务端 liveTitle=新名。
  // 注意：`changed` 由**来源字段文本哈希**（source=content_text）判定，仅改标题不算
  // changed（改标题+正文的场景见用例 ⑤），所以这里断言 liveTitle 而非「内容已变化」。
  await openNote(page, noteId);
  await page.getByText("预览").click();
  const card = page.getByTestId("reference-placeholder");
  await expect(card).toContainText(marker); // 快照旧标题保留
  await expect(card).not.toContainText("改名后");
  // 再改来源**正文**（哈希口径）→ 服务端判定 changed，liveTitle 对照新名
  await withAdmin(async (client) => {
    await client.query("UPDATE l3_sources SET content_text = $1 WHERE id = $2::uuid AND user_id = $3::uuid", [
      `改后正文 ${marker}`,
      sourceId,
      OWNER_ID,
    ]);
  });
  await openNote(page, noteId);
  await page.getByText("预览").click();
  await expect(page.getByTestId("reference-placeholder")).toContainText("内容已变化");
  await expect(page.getByTestId("reference-placeholder")).toContainText(`当前来源：改名后 ${marker}`);
  // 快照（含标题与摘录）与时间仍未被刷新
  const finalRefs = await fetchStoredReferences(noteId);
  expect(finalRefs[0]!.capturedAt).toBe(before.capturedAt);
  expect(JSON.stringify(finalRefs[0]!.displaySnapshot)).toBe(JSON.stringify(before.displaySnapshot));
});

test("⑦ 代码块内同名 marker 与真实卡片并存：移除只动真实段落，代码原文不变且保存/F5 正常", async ({
  authedPage: page,
}) => {
  test.setTimeout(120_000);
  const marker = `T09A-CODE-${Date.now()}`;
  const sourceId = await seedSource(marker);
  const noteId = await apiSeedNote(page, `${marker} 代码用例`);
  await openNote(page, noteId);

  await insertViaPicker(page, marker);
  await waitSaved(page);

  // 读出真实 refId，再把「代码示例 + 顶层真标记」写进正文
  const bodyWithMarker = await page.getByTestId("note-body").inputValue();
  const refId = /\[\[ref:([0-9a-f-]{36})\]\]/.exec(bodyWithMarker)![1]!;
  const codeBlock = ["```md", `[[ref:${refId}]]`, "```"].join("\n");
  const newBody = `${codeBlock}\n\n正文段\n\n[[ref:${refId}]]`;

  await page.getByTestId("note-body").fill(newBody);
  await waitSaved(page);

  // 预览：代码块里那条不是卡片；只有真实顶层段落渲染为卡片
  await page.getByText("预览").click();
  await expect(page.getByTestId("reference-placeholder")).toHaveCount(1);
  await page.getByText("返回编辑").click();

  // 移除引用：只删真实顶层 marker，代码示例逐字保留
  await page.getByText("预览").click();
  await page.getByTestId("ref-card-remove").click();
  await page.getByText("返回编辑").click();
  await waitSaved(page);

  const persisted = await fetchNoteBody(noteId);
  expect(persisted.bodyMd).toContain(codeBlock); // 代码示例原样
  expect(persisted.bodyMd).not.toContain(`\n\n[[ref:${refId}]]`); // 顶层标记已移除
  expect(await countNoteReferences(noteId)).toBe(0);

  // 重开仍一致（正文可正常保存，不留残态）
  await openNote(page, noteId);
  expect(await page.getByTestId("note-body").inputValue()).toContain(codeBlock);
  void sourceId;
});

test("⑧ 预览后来源变化：真实 capture 保存新快照，确认后页面无需重开即展示新内容", async ({
  authedPage: page,
}) => {
  test.setTimeout(120_000);
  const marker = `T09A-FRESH-${Date.now()}`;
  const sourceId = await seedSource(marker);
  const noteId = await apiSeedNote(page, `${marker} 时序用例`);
  await openNote(page, noteId);

  // 搜索列表就绪（预览尚未发起）
  await page.getByTestId("insert-reference-button").click();
  await expect(page.getByTestId("reference-picker")).toBeVisible({ timeout: 10_000 });
  await page.getByTestId("ref-picker-q").fill(marker);
  const item = page.getByTestId("ref-picker-item").first();
  await expect(item).toBeVisible({ timeout: 15_000 });
  await item.click();
  await expect(page.getByTestId("ref-preview-card")).toBeVisible({ timeout: 15_000 });

  // **预览已取得后**改来源：服务端 capture 将保存新标题
  await renameSource(sourceId, `改名后 ${marker}`);
  await page.getByTestId("ref-picker-insert").click();
  await waitSaved(page);

  // 库内快照 = 服务端 capture 当时的内容（新标题），而非预览时的旧标题
  const stored = await fetchStoredReferences(noteId);
  expect(stored).toHaveLength(1);
  expect(JSON.stringify(stored[0]!.displaySnapshot)).toContain(`改名后 ${marker}`);

  // 确认后卡片立即与已确认 DTO 一致（**无需 F5**）
  await page.getByText("预览").click();
  const card = page.getByTestId("reference-placeholder");
  await expect(card).toContainText(`改名后 ${marker}`, { timeout: 10_000 });
  await page.getByText("返回编辑").click();
  await page.reload();
  await openNote(page, noteId);
  await page.getByText("预览").click();
  await expect(page.getByTestId("reference-placeholder")).toContainText(`改名后 ${marker}`);
});

test("⑨ 代码块内插入被明确拒绝：可见反馈、正文与引用计数完全不变、仍可正常保存", async ({
  authedPage: page,
}) => {
  test.setTimeout(120_000);
  const marker = `T09A-REJECT-${Date.now()}`;
  await seedSource(marker);
  const noteId = await apiSeedNote(page, `${marker} 拒绝用例`);
  await openNote(page, noteId);

  const codeBody = ["```md", "example line", "```"].join("\n");
  await page.getByTestId("note-body").fill(codeBody);
  await waitSaved(page);

  // 光标放进代码块内部（"example" 中间）——直接设 selection，避免键盘导航的非确定性
  const caret = codeBody.indexOf("example") + 3;
  await page.getByTestId("note-body").click();
  await page.evaluate(
    ({ pos }: { pos: number }) => {
      const el = document.querySelector('[data-testid="note-body"]') as HTMLTextAreaElement;
      el.focus();
      el.setSelectionRange(pos, pos);
    },
    { pos: caret },
  );
  await expect
    .poll(async () => page.getByTestId("note-body").evaluate((el) => (el as HTMLTextAreaElement).selectionStart))
    .toBe(caret);
  await page.getByTestId("insert-reference-button").click();
  await expect(page.getByTestId("reference-picker")).toBeVisible({ timeout: 10_000 });
  await page.getByTestId("ref-picker-q").fill(marker);
  const item = page.getByTestId("ref-picker-item").first();
  await expect(item).toBeVisible({ timeout: 15_000 });
  await item.click();
  await expect(page.getByTestId("ref-preview-card")).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("ref-picker-insert").click();

  // 明确拒绝 + 可见原因（面板保持打开、不写入任何内容——用户可原位调整光标）
  await expect(page.getByTestId("reference-error")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("reference-error")).toContainText("代码块");
  await expect(page.getByTestId("note-body")).toHaveValue(codeBody);
  await expect(page.getByText(/引用 0 条/)).toBeVisible();
  await expect(page.getByTestId("reference-picker")).toBeVisible(); // 面板未被误关

  // 不留阻塞保存的残态：正文可继续编辑并保存成功。
  //
  // 更正（2026-09-21，浏览器内直接实测）：picker 头部的「关闭」按钮**是可点击的**，并非
  // 几何不可用——1280x720 视口下实测 visible+enabled、包围盒 {x:1187,y:536,w:48,h:32}、
  // elementFromPoint 命中按钮自身，真实用户点击可正常卸载面板。此前注释称其「几何点击
  // 不可用（预存在缺陷）」是**错误的**，已删除该说法。
  //
  // 本场景仍然使用面板内「取消」而非「关闭」，理由是场景目的：⑨ 证明的是「**拒绝后无残留、
  // 保存通道仍可用**」——即插入被拒后正文/引用计数不变，且正文仍可继续编辑并保存成功。
  // 「拒绝后清理预览」的语义正是「取消」（清空预览卡、面板保持打开，用户可原位调整光标重试）；
  // 「关闭」是整块面板的对话级收束，属另一条路径。两者在应用里是不同按钮、不同语义：
  // cancel → resetPreview（只清预览，不改正文/引用，面板仍在），close → setShowPicker(false)。
  // 因此这里保持「取消」才是与本场景目的相符的最小清理动作。
  // 关闭按钮本身的永久覆盖在 e2e-study-notes/study-notes-ref-picker-close.spec.ts 的 A/B/C
  // （真实点击、命中自证、关闭零写入、cancel≠close 的反面约束），本文件不重复。
  await page.getByTestId("ref-picker-cancel").click({ timeout: 20_000 });
  await page.getByTestId("note-body").fill(`${codeBody}\n\n追加正文`);
  await waitSaved(page);
  const persisted = await fetchNoteBody(noteId);
  expect(persisted.bodyMd).toBe(`${codeBody}\n\n追加正文`);
  expect(await countNoteReferences(noteId)).toBe(0);
});
