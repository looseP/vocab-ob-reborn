/**
 * Task 08 · 两处已提交修复的真实栈回归（真实浏览器 + 真实 HTTP + 隔离验收 PG）。
 *
 * F1（commit 4f58e35「迟到的引用确认不得复活已移除的元数据」）：
 *   插入 A → A 的自动保存 PUT 在途（响应被门闩持有）→ 移除 A（本地元数据清空）
 *   → 放行 A 的迟到响应 → 保存完成。经 UI 与数据库双向断言：
 *   A 既不被复活，也不丢失；第二次保存载荷为空；库内引用行归零。
 *
 * F2（commit 3d5b687「引用标记定位改用原文坐标」）：
 *   经**真实保存 API** 创建 CRLF 正文笔记 → GET 逐字核验 → 打开编辑器**直接**
 *   执行「移除/转普通摘录」（不先手改 textarea，避免隐式 CRLF→LF 归一化掩盖缺陷）
 *   → 保存 → 核验正文、引用行与重开结果。
 *
 * 纪律：仅在专属验收库 vocab_study_notes_task08_accept 运行（库身份显式校验）；
 * 故障注入只**延迟交付真实响应**（route.fetch 后挂门闩），不伪造状态码/载荷。
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

async function fetchReferenceIds(noteId: string): Promise<string[]> {
  return withAdmin(async (client) => {
    const result = await client.query<{ id: string }>(
      "SELECT id::text AS id FROM l3_study_note_references WHERE note_id = $1::uuid AND user_id = $2::uuid ORDER BY id",
      [noteId, OWNER_ID],
    );
    return result.rows.map((row) => row.id);
  });
}

async function pageApiCall(
  page: Page,
  path: string,
  init: { method: "POST" | "PUT"; body?: unknown },
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
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
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
    { path, method: init.method, body: init.body ?? null },
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
      bodyMd: "",
      venues: [venue],
      pinned: false,
      status: "active",
      references: [],
    },
  });
  if (saved.status !== 200) throw new Error(`命名失败：${saved.status} ${JSON.stringify(saved.body)}`);
  return item.id;
}

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

async function waitSaved(page: Page): Promise<void> {
  await expect(page.getByTestId("save-state")).toContainText("已保存", { timeout: 15_000 });
}

/** 经 picker 插入一条引用（不等待保存落定——调用方自行控序）。 */
async function insertViaPicker(page: Page, searchTerm: string): Promise<void> {
  await page.getByTestId("insert-reference-button").click();
  await expect(page.getByTestId("reference-picker")).toBeVisible({ timeout: 10_000 });
  await page.getByTestId("ref-picker-q").fill(searchTerm);
  const item = page.getByTestId("ref-picker-item").first();
  await expect(item).toBeVisible({ timeout: 15_000 });
  await item.click();
  await expect(page.getByTestId("ref-preview-card")).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("ref-picker-insert").click();
  await expect(page.getByTestId("reference-picker")).toHaveCount(0, { timeout: 10_000 });
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

// ── F1：交错保存 —— 迟到的引用确认不得复活已移除的元数据 ─────────────────────

/**
 * 真实交错：插入 A → A 的自动保存 PUT 响应被门闩**真实延迟** → 移除 A →
 * 插入 B → 先放行 B 的响应、再放行 A 的迟到响应。断言经**UI + 保存载荷 + 数据库**
 * 三面：A 不丢失也不复活（不得出现在正文 / 卡片 / 最终载荷 / 库行），B 完整保留。
 */
test("F1 真实栈：延迟的保存响应交付后，A 不复活、B 不丢失（UI + 载荷 + 库三面）", async ({
  authedPage: page,
}) => {
  test.setTimeout(120_000);
  const marker = `T08F1-${Date.now()}`;
  const markerB = `${marker}-B`;
  await seedSource(marker);
  await seedSource(markerB);
  const noteId = await apiSeedNote(page, `${marker} F1 交错`);

  const capturedSaves: Array<{ status: number; payload: { bodyMd?: string; references?: Array<{ id: string; action: string }> } }> = [];
  let releaseA!: () => void;
  const gateA = new Promise<void>((resolve) => {
    releaseA = resolve;
  });
  let heldA = false;
  let aPayload: Array<{ id: string; action: string }> = [];

  await page.route("**/api/l3/study-notes/*", async (route) => {
    if (route.request().method() !== "PUT") {
      await route.continue();
      return;
    }
    const payload = route.request().postDataJSON() as { bodyMd?: string; references?: Array<{ id: string; action: string }> };
    capturedSaves.push({ status: 0, payload });
    const index = capturedSaves.length - 1;
    const response = await route.fetch(); // 真实请求已提交（服务端已落库）
    capturedSaves[index]!.status = response.status();
    // 只延迟「首个含 capture 引用」的保存 = A 那次（B 自己的那次不延迟）。
    const isA = !heldA && (payload.references ?? []).some((write) => write.action === "capture");
    if (isA) {
      heldA = true;
      aPayload = payload.references ?? [];
      await gateA;
    }
    await route.fulfill({ response }); // 交付真实响应（非伪造）
  });

  await openNote(page, noteId);

  // 1) 插入 A —— 自动保存 PUT 的真实响应被门闩持有（在途）。
  await insertViaPicker(page, marker);
  await expect.poll(() => heldA, { timeout: 15_000 }).toBe(true);
  expect(aPayload.length).toBe(1);
  const refIdA = aPayload[0]!.id;
  expect(aPayload[0]!.action).toBe("capture");

  // A 此刻应为「待确认」（本机预览，尚未拿到服务端确认）；卡片仅预览模式渲染。
  await page.getByText("预览").click();
  await expect(page.locator(`[data-ref-id="${refIdA}"]`)).toHaveAttribute("data-ref-confirmed", "pending", {
    timeout: 10_000,
  });
  await page.getByText("返回编辑").click();

  // 2) A 的响应仍在途时移除 A：UI 上 A 的卡片与 marker 都必须立即消失。
  await page.getByText("预览").click();
  await expect(page.getByTestId("ref-card-remove")).toBeVisible({ timeout: 10_000 });
  await page.getByTestId("ref-card-remove").click();
  await page.getByText("返回编辑").click();
  await expect(page.getByTestId("note-body")).not.toHaveValue(/\[\[ref:/, { timeout: 10_000 });
  await expect(page.locator(`[data-ref-id="${refIdA}"]`)).toHaveCount(0);

  // 3) 插入 B（A 的响应**仍被持有**）——制造「迟到确认落在移除之后」的真实交错。
  await insertViaPicker(page, markerB);
  await page.getByText("预览").click();
  const placeholdersBefore = await page.getByTestId("reference-placeholder").count();
  expect(placeholdersBefore).toBe(1); // 只有 B
  const idB = await page.getByTestId("reference-placeholder").first().getAttribute("data-ref-id");
  expect(idB).toBeTruthy();
  await page.getByText("返回编辑").click();

  // 4) 放行 A 的迟到响应，让其确认真正交付（交错落点）。
  releaseA();
  await waitSaved(page);

  // 5) UI 面：A 绝不复活；B 仍在且最终转为已确认。
  await page.getByText("预览").click();
  await expect(page.getByTestId("reference-placeholder")).toHaveCount(1);
  await expect(page.locator(`[data-ref-id="${refIdA}"]`)).toHaveCount(0);
  await expect(page.locator(`[data-ref-id="${idB}"]`)).toHaveAttribute("data-ref-confirmed", "confirmed", {
    timeout: 15_000,
  });
  await page.getByText("返回编辑").click();

  // 6) 载荷面：A 不得出现在移除之后的任何保存载荷中；末次载荷恰含 B。
  const aInLaterPayloads = capturedSaves
    .slice(1)
    .some((save) => (save.payload.references ?? []).some((write) => write.id === refIdA));
  expect(aInLaterPayloads, "A 不得在移除后重新出现在保存载荷里").toBe(false);
  const lastSave = capturedSaves[capturedSaves.length - 1]!;
  expect(lastSave.status).toBe(200);
  expect((lastSave.payload.references ?? []).map((write) => write.id)).toEqual([idB]);
  expect(lastSave.payload.bodyMd).toContain(`[[ref:${idB}]]`);
  expect(lastSave.payload.bodyMd).not.toContain(`[[ref:${refIdA}]]`);

  // 7) 数据库面：仅 B 的引用行，A 既不复活（不新增行）也不丢 B。
  await expect.poll(() => countNoteReferences(noteId), { timeout: 15_000 }).toBe(1);
  const refIdsInDb = await fetchReferenceIds(noteId);
  expect(refIdsInDb.map((id) => id.toLowerCase())).toEqual([idB.toLowerCase()]);
  expect(refIdsInDb.map((id) => id.toLowerCase())).not.toContain(refIdA.toLowerCase());
  const persisted = await fetchNoteBody(noteId);
  expect(persisted.bodyMd).toContain(`[[ref:${idB}]]`);
  expect(persisted.bodyMd).not.toContain(`[[ref:${refIdA}]]`);

  // 8) 重开：UI 与库一致（B 在、A 无）。
  await page.reload();
  await expect(page.getByTestId("note-body")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("note-body")).toHaveValue(new RegExp(`\\[\\[ref:${idB}\\]\\]`));
  await page.getByText("预览").click();
  await expect(page.getByTestId("reference-placeholder")).toHaveCount(1);
  await expect(page.locator(`[data-ref-id="${refIdA}"]`)).toHaveCount(0);

  await page.unroute("**/api/l3/study-notes/*");
});

// ── F2：CRLF 正文经真实保存 API，直接移除 / 直接转摘录 ───────────────────────

test("F2 真实栈：CRLF 正文经真实 API 保存后，直接「移除」不手改 textarea", async ({
  authedPage: page,
}) => {
  test.setTimeout(120_000);
  const marker = `T08F2RM-${Date.now()}`;
  await seedSource(marker);
  const noteId = await apiSeedNote(page, `${marker} F2 移除`);

  await page.goto(`/l3?section=study-notes&venue=cloze`);
  const refId = randomUUID();
  // CRLF 正文：既有普通行，又有顶层 marker 段落。
  const crlfBody = `第一行\r\n第二行\r\n\r\n[[ref:${refId}]]\r\n\r\n结尾行\r\n`;
  const current = await fetchNoteBody(noteId);
  const saved = await pageApiCall(page, `/api/l3/study-notes/${noteId}`, {
    method: "PUT",
    body: {
      expectedVersion: current.version,
      requestId: randomUUID(),
      title: `${marker} F2 移除`,
      bodyMd: crlfBody,
      venues: ["cloze"],
      pinned: false,
      status: "active",
      references: [{ id: refId, action: "capture", target: { kind: "source", sourceId: (await sourceIdFor(marker)) } }],
    },
  });
  expect(saved.status).toBe(200);

  // GET 逐字核验：库内正文保持 CRLF（服务端不归一化）。
  const afterSave = await fetchNoteBody(noteId);
  expect(afterSave.bodyMd).toContain("\r\n");
  expect(afterSave.bodyMd).toBe(crlfBody);
  expect(await countNoteReferences(noteId)).toBe(1);

  // 打开编辑器：**不触碰 textarea**，直接预览 → 移除 → 保存。
  // 注意：textarea 的 .value 按 HTML 规范把 CRLF 归一为 LF，**不能**用它观测原文换行；
  // CRLF 的存在只以库内 body_md（下方 GET/落库核验）为证。
  await openNote(page, noteId);
  // 移除前确认 marker 存在（marker 文本不含换行，textarea 观测有效）。
  await expect(page.getByTestId("note-body")).toHaveValue(new RegExp(`\\[\\[ref:${refId}\\]\\]`));

  await page.getByText("预览").click();
  await expect(page.getByTestId("ref-card-remove")).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("ref-card-remove").click();
  await page.getByText("返回编辑").click();

  // 移除必须真正生效（缺陷态为「引用标记不存在」+ 正文原样保留）。
  await expect(page.getByTestId("reference-error")).toHaveCount(0);
  await expect(page.getByTestId("note-body")).not.toHaveValue(/\[\[ref:/, { timeout: 10_000 });

  await waitSaved(page);

  // 库核：正文无 marker、其余 CRLF 正文逐字保留、引用行归零。
  await expect.poll(() => countNoteReferences(noteId), { timeout: 15_000 }).toBe(0);
  const persisted = await fetchNoteBody(noteId);
  expect(persisted.bodyMd).not.toContain("[[ref:");
  expect(persisted.bodyMd).toContain("第一行\r\n第二行");
  expect(persisted.bodyMd).toContain("结尾行");

  // 重开：正文与库内一致，标记不复现。
  await page.reload();
  await expect(page.getByTestId("note-body")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("note-body")).not.toHaveValue(/\[\[ref:/);
  expect((await fetchReferenceIds(noteId)).length).toBe(0);
});

test("F2 真实栈：CRLF 正文直接「转普通摘录」不手改 textarea", async ({ authedPage: page }) => {
  test.setTimeout(120_000);
  const marker = `T08F2CV-${Date.now()}`;
  await seedSource(marker);
  const noteId = await apiSeedNote(page, `${marker} F2 转换`);

  await page.goto(`/l3?section=study-notes&venue=cloze`);
  const refId = randomUUID();
  const crlfBody = `开头\r\n\r\n[[ref:${refId}]]\r\n\r\n结束\r\n`;
  const current = await fetchNoteBody(noteId);
  const saved = await pageApiCall(page, `/api/l3/study-notes/${noteId}`, {
    method: "PUT",
    body: {
      expectedVersion: current.version,
      requestId: randomUUID(),
      title: `${marker} F2 转换`,
      bodyMd: crlfBody,
      venues: ["cloze"],
      pinned: false,
      status: "active",
      references: [{ id: refId, action: "capture", target: { kind: "source", sourceId: (await sourceIdFor(marker)) } }],
    },
  });
  expect(saved.status).toBe(200);
  const afterSave = await fetchNoteBody(noteId);
  expect(afterSave.bodyMd).toBe(crlfBody);

  await openNote(page, noteId);
  // 不触碰 textarea 观测 CRLF（其 .value 会归一为 LF）；CRLF 只由库内 body_md 证明。

  // 直接预览 → 转普通摘录 → 保存（不触碰 textarea）。
  await page.getByText("预览").click();
  await expect(page.getByTestId("ref-card-convert")).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("ref-card-convert").click();
  await page.getByText("返回编辑").click();

  await expect(page.getByTestId("reference-error")).toHaveCount(0);
  await expect(page.getByTestId("note-body")).not.toHaveValue(/\[\[ref:/, { timeout: 10_000 });
  await waitSaved(page);

  // 库核：摘录行在、marker 不在、引用行归零、非目标正文保留。
  await expect.poll(() => countNoteReferences(noteId), { timeout: 15_000 }).toBe(0);
  const persisted = await fetchNoteBody(noteId);
  expect(persisted.bodyMd).not.toContain("[[ref:");
  expect(persisted.bodyMd).toContain("> —— 来源");
  expect(persisted.bodyMd).toContain("开头");

  await page.reload();
  await expect(page.getByTestId("note-body")).toHaveValue(/> —— 来源/, { timeout: 15_000 });
  expect((await fetchReferenceIds(noteId)).length).toBe(0);
});

/** admin 读回 marker 对应的 active source id（本批 seedSource 用标题 marker 落库）。 */
async function sourceIdFor(marker: string): Promise<string> {
  return withAdmin(async (client) => {
    const result = await client.query<{ id: string }>(
      "SELECT id::text AS id FROM l3_sources WHERE user_id = $1::uuid AND title = $2 ORDER BY id LIMIT 1",
      [OWNER_ID, `来源 ${marker}`],
    );
    if (result.rows.length !== 1) throw new Error(`source ${marker} 不存在`);
    return result.rows[0]!.id;
  });
}
