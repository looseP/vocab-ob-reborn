/**
 * Task 08（面板关闭核验）· 引用选择面板「关闭」按钮 E2E 回归。
 *
 * 覆盖（全部经真实用户式点击，绝不 force / 绝不 dispatchEvent）：
 *  A. 关闭 → 面板消失 → 重新打开仍可搜索；
 *  B. 预览在途时关闭 → 迟到响应不得复活面板、不得插入引用；
 *  C. 关闭不改动任何内容：正文、引用计数、库内引用行与版本号完全不变。
 *
 * 纪律：仅在专属空验收库 vocab_study_notes_task08_accept 运行（库身份显式校验）；
 * 库核全部经 admin 连接。
 *
 * 反面约束（本文件必须显式证明，防回归退化为「取消」验收）：
 *  `data-testid="ref-picker-cancel"` 只清空预览卡、**不关闭面板**——它绝不能被当作
 *  关闭验收。C 用例在点击 close 之前先证明 cancel 之后面板仍在（count=1）。
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

async function fetchNoteVersion(noteId: string): Promise<{ bodyMd: string; version: number }> {
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

async function apiSeedNote(page: Page, title: string, bodyMd = ""): Promise<string> {
  const created = await pageApiCall(page, "/api/l3/study-notes", {
    method: "POST",
    body: { requestId: randomUUID(), venue: "cloze" },
  });
  if (created.status !== 201) throw new Error(`创建笔记失败：${created.status}`);
  const item = (created.body as { item: { id: string; version: number } }).item;
  const saved = await pageApiCall(page, `/api/l3/study-notes/${item.id}`, {
    method: "PUT",
    body: {
      expectedVersion: item.version,
      requestId: randomUUID(),
      title,
      bodyMd,
      venues: ["cloze"],
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

async function openNote(page: Page, noteId: string): Promise<void> {
  await page.goto(`/l3?section=study-notes&venue=cloze&noteId=${noteId}`);
  await expect(page.getByTestId("note-body")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("save-state")).toContainText("已保存", { timeout: 15_000 });
}

/** 打开面板 → 搜索 → 列表就绪（不点击项目，因此不触发预览）。 */
async function openPickerWithResults(page: Page, term: string): Promise<void> {
  await page.getByTestId("insert-reference-button").click();
  await expect(page.getByTestId("reference-picker")).toBeVisible({ timeout: 10_000 });
  await page.getByTestId("ref-picker-q").fill(term);
  await expect(page.getByTestId("ref-picker-item").first()).toBeVisible({ timeout: 15_000 });
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

test("A 关闭按钮：真实点击 → 面板消失 → 重新打开仍可搜索 → 再关闭", async ({ authedPage: page }) => {
  test.setTimeout(120_000);
  const marker = `T08-CLOSE-A-${Date.now()}`;
  const sourceId = await seedSource(marker);
  const noteId = await apiSeedNote(page, `${marker} 关闭笔记`);
  await openNote(page, noteId);

  await openPickerWithResults(page, marker);

  // 关闭按钮：唯一、可见、可用、几何可命中（命中元素必须是按钮自身）
  const close = page.getByTestId("ref-picker-close");
  await expect(close).toHaveCount(1);
  await expect(close).toBeVisible();
  await expect(close).toBeEnabled();
  const hitTarget = await close.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return { isSelf: top === element, tag: top?.tagName ?? null, testId: top?.getAttribute("data-testid") ?? null };
  });
  expect(hitTarget.isSelf).toBe(true);
  expect(hitTarget.testId).toBe("ref-picker-close");

  // 真实用户式点击（无 force、无 dispatchEvent）
  await close.click();
  await expect(page.getByTestId("reference-picker")).toHaveCount(0, { timeout: 10_000 });

  // 重新打开仍可搜索：同一 marker 仍能搜到目标
  await openPickerWithResults(page, marker);
  await expect(page.getByTestId("ref-picker-item").first()).toContainText(marker);

  // 再次关闭（幂等）
  await page.getByTestId("ref-picker-close").click();
  await expect(page.getByTestId("reference-picker")).toHaveCount(0, { timeout: 10_000 });

  // 关闭本身零写入
  expect(await countNoteReferences(noteId)).toBe(0);
  void sourceId;
});

test("B 预览在途时关闭：迟到响应不得复活面板，也不得插入引用", async ({ authedPage: page }) => {
  test.setTimeout(120_000);
  const marker = `T08-CLOSE-B-${Date.now()}`;
  await seedSource(marker);
  const noteId = await apiSeedNote(page, `${marker} 在途笔记`);
  await openNote(page, noteId);
  await openPickerWithResults(page, marker);

  // 真实延迟：为目标卡片插入约 4s 延迟的 search+preview 逻辑/请求延迟。
  // 关键区分——**必须在点击项目之前安装**：若在点击之后安装，延迟只会作用在
  // 已经发出的请求上（真实场景也如此），但无法证明「在途窗口」确实存在。
  const delayedPaths: string[] = [];
  await page.route("**/api/l3/study-notes/reference-preview", async (route) => {
    delayedPaths.push(route.request().url());
    await new Promise((resolve) => setTimeout(resolve, 4000));
    await route.continue();
  });

  const previewRequest = page.waitForRequest(
    (request) => request.url().includes("/reference-preview") && request.method() === "POST",
    { timeout: 15_000 },
  );
  await page.getByTestId("ref-picker-item").first().click();
  await previewRequest; // 预览确实已在途
  await expect(page.getByTestId("ref-preview-loading")).toBeVisible({ timeout: 5_000 });

  // 在途窗口内真实点击关闭
  await page.getByTestId("ref-picker-close").click();
  await expect(page.getByTestId("reference-picker")).toHaveCount(0, { timeout: 10_000 });

  // 等迟到响应真正返回（远超 4s 延迟），面板不得复活
  await page.waitForTimeout(6_000);
  expect(delayedPaths.length).toBeGreaterThanOrEqual(1);
  await expect(page.getByTestId("reference-picker")).toHaveCount(0);
  await expect(page.getByTestId("ref-preview-card")).toHaveCount(0);
  await expect(page.getByTestId("ref-preview-loading")).toHaveCount(0);

  // 迟到响应不得插入任何引用（正文无 marker、库内 0 行）
  await expect(page.getByTestId("note-body")).toHaveValue("");
  expect(await countNoteReferences(noteId)).toBe(0);
});

test("C 关闭不改动正文、引用列表与库内引用行（且「取消」绝不等于关闭）", async ({ authedPage: page }) => {
  test.setTimeout(120_000);
  const marker = `T08-CLOSE-C-${Date.now()}`;
  await seedSource(marker);
  const body = `已有正文 ${marker}`;
  const noteId = await apiSeedNote(page, `${marker} 不变性笔记`, body);
  await openNote(page, noteId);
  await expect(page.getByTestId("note-body")).toHaveValue(body);

  await openPickerWithResults(page, marker);

  // 先证明「取消」不是「关闭」：点 cancel 后预览卡消失，但面板仍在
  await page.getByTestId("ref-picker-item").first().click();
  await expect(page.getByTestId("ref-preview-card")).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("ref-picker-cancel").click();
  await expect(page.getByTestId("ref-preview-card")).toHaveCount(0, { timeout: 10_000 });
  await expect(page.getByTestId("reference-picker")).toHaveCount(1); // 取消 ≠ 关闭（本断言即防错用）

  const before = await fetchNoteVersion(noteId);

  // 真实点击关闭
  await page.getByTestId("ref-picker-close").click();
  await expect(page.getByTestId("reference-picker")).toHaveCount(0, { timeout: 10_000 });

  // UI 不变：正文逐字不变、引用计数仍为 0 条
  await expect(page.getByTestId("note-body")).toHaveValue(body);
  await expect(page.getByText(/引用 0 条/)).toBeVisible();

  // 库不变：正文、版本号、引用行数完全一致
  const after = await fetchNoteVersion(noteId);
  expect(after.bodyMd).toBe(before.bodyMd);
  expect(after.version).toBe(before.version);
  expect(await countNoteReferences(noteId)).toBe(0);
});
