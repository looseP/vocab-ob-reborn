/**
 * Task 08 · 学习笔记空间 E2E（真实浏览器 + 真实 HTTP + 本批隔离 PG）。
 *
 * 覆盖（执行提示必测项）：
 *  ① 浏览列表不产生 POST（GO→列表→搜索→筛选全程零创建）；
 *  ② 显式新建只创建一次（在途守卫 + 恰 1 次 POST + 库计数）；
 *  ③ 分页游标：加载更多带 cursor、跨页去重；筛选切换清 cursor（断言请求无 cursor）；
 *  ④ 专题：创建、选择过滤、未整理加入成员、上移（beforeNoteId）→ 库内顺序核验；
 *  ⑤ noteId 深链 + F5 + 返回 + 前进：不重复创建、不丢已保存内容；
 *  ⑥ 离页 flush：成功离开；失败留原位（URL/输入保留）→ 重试成功后离开；
 *  ⑦ 双标签 409：停写 + 显式载入服务器版本 + 新基线保存（库核最终值）；
 *  ⑧ 未授权深链：不泄露内容、不创建替代；
 *  ⑨ 在途保存期间禁止错误导航（flush 等待落定后才离开）。
 *
 * 纪律：仅在专属空验收库 vocab_study_notes_task08_accept 运行（库身份显式校验）；
 * fixture owner = E2E_OWNER_ID；清理仅限本 owner 数据；故障注入只丢/延迟真实请求响应。
 * 种子数据说明：笔记 create 只收 {requestId, venue}（严格 schema），标题经保存通道 PUT 写入。
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

// ── DB helpers ──────────────────────────────────────────────────────────────

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

async function fetchNoteTitle(noteId: string): Promise<{ title: string; version: number; status: string }> {
  return withAdmin(async (client) => {
    const result = await client.query<{ title: string; version: number; status: string }>(
      "SELECT title, version, status FROM l3_study_notes WHERE id = $1::uuid AND user_id = $2::uuid",
      [noteId, OWNER_ID],
    );
    if (result.rows.length !== 1) throw new Error(`note ${noteId} 不存在`);
    return result.rows[0]!;
  });
}

async function fetchTopicMemberOrder(topicId: string): Promise<string[]> {
  return withAdmin(async (client) => {
    const result = await client.query<{ note_id: string }>(
      `SELECT note_id::text AS note_id FROM l3_study_topic_notes
       WHERE topic_id = $1::uuid AND user_id = $2::uuid ORDER BY position, note_id`,
      [topicId, OWNER_ID],
    );
    return result.rows.map((row) => row.note_id);
  });
}

// ── 浏览器内 API（真实 session/CSRF；仅用于种子与库核对照）──────────────────

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

/** 种子：create（只收 requestId+venue）→ PUT 命名（完整快照、由幂等键保护）。 */
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
  if (saved.status !== 200) throw new Error(`命名笔记失败：${saved.status} ${JSON.stringify(saved.body)}`);
  return item.id;
}

// ── 页面 helpers ────────────────────────────────────────────────────────────

const WORKSPACE_URL = "/l3?section=study-notes&venue=cloze";

interface TrackedRequests {
  posts: string[];
  listGets: string[];
}

/** 记录页面请求（POST 创建 / 列表 GET），供「零创建」「游标失效」断言。 */
function trackRequests(page: Page): TrackedRequests {
  const posts: string[] = [];
  const listGets: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (request.method() === "POST" && url.pathname === "/api/l3/study-notes") posts.push(request.url());
    if (request.method() === "GET" && url.pathname === "/api/l3/study-notes") listGets.push(request.url());
  });
  return { posts, listGets };
}

async function openWorkspace(page: Page): Promise<void> {
  await page.goto(WORKSPACE_URL);
  await expect(page.getByTestId("list-total")).toBeVisible();
  await expect(
    page.getByTestId("study-note-row").first().or(page.getByTestId("list-empty")),
  ).toBeVisible({ timeout: 15_000 });
}

/** 搜索（300ms 防抖）：等待总量与行数（均为响应驱动，确定性收敛）。 */
async function searchMarker(
  page: Page,
  marker: string,
  expectedRows: number,
  expectedTotal: number,
): Promise<void> {
  await page.getByTestId("search-input").fill(marker);
  await expect(page.getByTestId("list-total")).toHaveText(new RegExp(`共\\s*${expectedTotal}\\s*篇`), {
    timeout: 10_000,
  });
  await expect(page.getByTestId("study-note-row")).toHaveCount(expectedRows, { timeout: 10_000 });
}

async function openNoteByMarker(page: Page, marker: string): Promise<void> {
  await searchMarker(page, marker, 1, 1);
  await page.getByTestId("study-note-row").first().getByTestId("row-open").click();
  await expect(page.getByTestId("study-note-editor")).toBeVisible({ timeout: 15_000 });
}

function noteIdFromUrl(page: Page): string | null {
  return new URL(page.url()).searchParams.get("noteId");
}

// ── 前置清理（仅本 owner；库为专属空验收库）────────────────────────────────

test.beforeAll(async () => {
  await withAdmin(async (client) => {
    await client.query("BEGIN");
    await client.query("DELETE FROM l3_study_topic_notes WHERE user_id = $1::uuid", [OWNER_ID]);
    await client.query("DELETE FROM l3_study_topics WHERE user_id = $1::uuid", [OWNER_ID]);
    await client.query("DELETE FROM l3_study_note_references WHERE user_id = $1::uuid", [OWNER_ID]);
    await client.query("DELETE FROM l3_study_note_venues WHERE user_id = $1::uuid", [OWNER_ID]);
    await client.query("DELETE FROM l3_study_notes WHERE user_id = $1::uuid", [OWNER_ID]);
    await client.query("COMMIT");
  });
});

// ── 场景 ────────────────────────────────────────────────────────────────────

test("① 浏览列表不产生 POST：入口→列表→搜索→筛选全程零创建", async ({ authedPage: page }) => {
  const marker = `T08BROWSE-${Date.now()}`;
  await apiSeedNote(page, `${marker}-一`);
  await apiSeedNote(page, `${marker}-二`);

  const tracked = trackRequests(page); // 种子之后开始计数
  const before = await countOwnerNotes();

  await page.goto("/l3?section=study-notes"); // 入口（无 venue）：仅空态
  await expect(page.getByTestId("venue-picker")).toBeVisible();
  await page.getByTestId("venue-cloze").click(); // 进入题型
  await expect(page.getByTestId("list-total")).toHaveText(/共\s*2\s*篇/, { timeout: 15_000 });
  await expect(page.getByTestId("study-note-row")).toHaveCount(2);

  // 浏览行为：搜索命中/未命中/清空（各触发只读列表请求）
  await searchMarker(page, marker, 2, 2);
  await page.getByTestId("search-input").fill(`${marker}-zzz`);
  await expect(page.getByTestId("list-empty")).toBeVisible({ timeout: 10_000 });
  await page.getByTestId("search-input").fill(marker);
  await expect(page.getByTestId("study-note-row")).toHaveCount(2, { timeout: 10_000 });

  expect(tracked.posts).toEqual([]); // 浏览全程零创建
  expect(await countOwnerNotes()).toBe(before); // 库计数不变
  expect(tracked.listGets.length).toBeGreaterThanOrEqual(3); // 确有多次只读列表请求
});

test("② 显式新建只创建一次：在途守卫 + 恰 1 次 POST + 库 +1", async ({ authedPage: page }) => {
  const tracked = trackRequests(page);
  await openWorkspace(page);
  const before = await countOwnerNotes();

  // 延迟创建响应：断言在途期间按钮被守卫（disabled，不可并行创建）
  await page.route("**/api/l3/study-notes", async (route) => {
    if (route.request().method() === "POST") {
      await new Promise((resolve) => setTimeout(resolve, 800));
    }
    await route.continue();
  });

  const button = page.getByTestId("new-note-button");
  await button.click();
  await expect(button).toBeDisabled(); // 在途守卫
  await expect(page.getByTestId("study-note-editor")).toBeVisible({ timeout: 15_000 });
  await expect(button).toBeEnabled();

  expect(noteIdFromUrl(page)).toBeTruthy();
  expect(tracked.posts).toHaveLength(1); // 恰 1 次创建
  expect(await countOwnerNotes()).toBe(before + 1);
  await page.unroute("**/api/l3/study-notes");
});

test("③ 分页游标：加载更多带 cursor、跨页去重；筛选切换清 cursor", async ({ authedPage: page }) => {
  const tracked = trackRequests(page);
  const marker = `T08PG-${Date.now()}`;
  for (let index = 0; index < 25; index += 1) {
    await apiSeedNote(page, `${marker}-${String(index).padStart(2, "0")}`);
  }

  await openWorkspace(page);
  await searchMarker(page, marker, 20, 25); // 首页 20 条

  const firstPageUrl = tracked.listGets.at(-1)!;
  expect(new URL(firstPageUrl).searchParams.get("cursor")).toBeNull();

  await page.getByTestId("load-more-button").click();
  await expect(page.getByTestId("study-note-row")).toHaveCount(25, { timeout: 10_000 }); // 跨页去重后 25
  const secondPageUrl = tracked.listGets.at(-1)!;
  expect(new URL(secondPageUrl).searchParams.get("cursor")).not.toBeNull(); // 带 cursor

  const ids = await page.getByTestId("study-note-row").evaluateAll((rows) =>
    rows.map((row) => row.getAttribute("data-note-id")),
  );
  expect(new Set(ids).size).toBe(25); // 无重复

  // 筛选切换（状态）→ 清 cursor 重新起翻
  await page.getByTestId("status-filter").selectOption("archived");
  await expect(page.getByTestId("list-empty")).toBeVisible({ timeout: 10_000 });
  const filteredUrl = tracked.listGets.at(-1)!;
  const filtered = new URL(filteredUrl).searchParams;
  expect(filtered.get("status")).toBe("archived");
  expect(filtered.get("cursor")).toBeNull(); // 游标已失效

  await page.getByTestId("status-filter").selectOption(""); // 复原
  await expect(page.getByTestId("list-total")).toHaveText(/共\s*25\s*篇/, { timeout: 10_000 });
  await expect(page.getByTestId("study-note-row")).toHaveCount(20);
});

test("④ 专题：创建/过滤/未整理加入成员/上移（库内核验顺序）", async ({ authedPage: page }) => {
  const marker = `T08TP-${Date.now()}`;
  const noteA = await apiSeedNote(page, `${marker}-甲`);
  const noteB = await apiSeedNote(page, `${marker}-乙`);

  await openWorkspace(page);
  const topicTitle = `专题-${Date.now()}`;
  await page.getByTestId("topic-create-input").fill(topicTitle);
  await page.getByTestId("topic-create-submit").click();
  const topicItem = page.getByTestId("topic-item").filter({ hasText: topicTitle });
  await expect(topicItem).toBeVisible({ timeout: 10_000 });
  const topicId = (await topicItem.getAttribute("data-topic-id"))!;

  // 未整理视图：检索本次两篇 → 逐一加入专题（加入后从未整理列表消失）
  await page.getByTestId("topic-unfiled-button").click();
  await searchMarker(page, marker, 2, 2);
  const joinTopRow = async (remainingAfter: number): Promise<void> => {
    const row = page.getByTestId("study-note-row").first();
    await row.getByTestId("row-topic-select").selectOption({ label: topicTitle });
    await row.getByTestId("row-join-submit").click();
    if (remainingAfter > 0) {
      await expect(page.getByTestId("study-note-row")).toHaveCount(remainingAfter, { timeout: 10_000 });
    } else {
      await expect(page.getByTestId("list-empty")).toBeVisible({ timeout: 10_000 });
    }
  };
  await joinTopRow(1);
  await joinTopRow(0);

  // 专题视图：两个成员；把第二个上移 → beforeNoteId = 前一成员（库内顺序交换）
  await page.getByTestId("topic-item").filter({ hasText: topicTitle }).click();
  await expect(page.getByTestId("study-note-row")).toHaveCount(2, { timeout: 10_000 });
  const idsDisplay = await page.getByTestId("study-note-row").evaluateAll((rows) =>
    rows.map((row) => row.getAttribute("data-note-id")),
  );
  expect([...idsDisplay].sort()).toEqual([noteA, noteB].sort());

  await page.getByTestId("study-note-row").nth(1).getByTestId("row-move-up").click();
  await expect
    .poll(async () => fetchTopicMemberOrder(topicId), { timeout: 10_000 })
    .toEqual([idsDisplay[1], idsDisplay[0]]); // 顺序已交换（服务端 position）

  // 重开（F5）确认顺序稳定（服务端真源）
  await page.reload();
  await expect(page.getByTestId("study-note-row")).toHaveCount(2, { timeout: 15_000 });
  const idsAfterReload = await page.getByTestId("study-note-row").evaluateAll((rows) =>
    rows.map((row) => row.getAttribute("data-note-id")),
  );
  expect(idsAfterReload).toEqual([idsDisplay[1], idsDisplay[0]]);
});

test("⑤ 深链/F5/返回/前进：不重复创建、不丢已保存内容", async ({ authedPage: page }) => {
  const marker = `T08NAV-${Date.now()}`;
  const noteId = await apiSeedNote(page, `${marker} 导航`);

  const tracked = trackRequests(page); // 种子之后开始计数
  const before = await countOwnerNotes();

  await openWorkspace(page);
  await openNoteByMarker(page, marker);
  expect(noteIdFromUrl(page)).toBe(noteId);

  // F5：仍是同一篇（GET 恢复），零创建
  await page.reload();
  await expect(page.getByTestId("study-note-editor")).toBeVisible({ timeout: 15_000 });
  expect(noteIdFromUrl(page)).toBe(noteId);

  // 返回 → 列表；前进 → 重新打开同一篇（零创建）
  await page.goBack();
  await page.waitForURL((url) => !url.searchParams.get("noteId"), { timeout: 10_000 });
  await expect(page.getByTestId("list-total")).toBeVisible();

  await page.goForward();
  await expect(page.getByTestId("study-note-editor")).toBeVisible({ timeout: 15_000 });
  expect(noteIdFromUrl(page)).toBe(noteId);

  // 再返回一次 → 列表（flush 屏障走干净路径）
  await page.goBack();
  await page.waitForURL((url) => !url.searchParams.get("noteId"), { timeout: 10_000 });

  expect(tracked.posts).toEqual([]); // 全程零创建
  expect(await countOwnerNotes()).toBe(before);
});

test("⑥ 离页 flush：成功离开 + 失败留原位（输入保留）→ 重试后离开", async ({ authedPage: page }) => {
  const marker = `T08LEAVE-${Date.now()}`;
  const noteId = await apiSeedNote(page, `${marker} 离页`);

  await openWorkspace(page);
  await openNoteByMarker(page, marker);

  // (a) 成功路径
  await page.getByTestId("note-title").fill(`${marker} 已改`);
  await page.getByTestId("leave-action").click();
  await page.waitForURL((url) => !url.searchParams.get("noteId"), { timeout: 15_000 });
  await expect
    .poll(async () => (await fetchNoteTitle(noteId)).title, { timeout: 10_000 })
    .toBe(`${marker} 已改`);

  // (b) 失败路径：PUT 断链（真实网络失败；自动重试 1/2/4s 耗尽 → error）
  await page.route("**/api/l3/study-notes/**", async (route) => {
    if (route.request().method() === "PUT") await route.abort("failed");
    else await route.continue();
  });
  await openNoteByMarker(page, marker);
  await page.getByTestId("note-title").fill(`${marker} 断网改动`);
  await page.getByTestId("leave-action").click();
  await expect(page.getByTestId("navigation-error")).toBeVisible({ timeout: 30_000 });
  expect(noteIdFromUrl(page)).toBe(noteId); // 留在原位
  expect(await page.getByTestId("note-title").inputValue()).toBe(`${marker} 断网改动`); // 输入保留

  // 恢复网络 → 重试保存 → 离开
  await page.unroute("**/api/l3/study-notes/**");
  await page.getByRole("button", { name: "重试保存" }).click();
  await expect(page.getByTestId("save-state")).toContainText("已保存", { timeout: 15_000 });
  await page.getByTestId("leave-action").click();
  await page.waitForURL((url) => !url.searchParams.get("noteId"), { timeout: 15_000 });
  await expect
    .poll(async () => (await fetchNoteTitle(noteId)).title, { timeout: 10_000 })
    .toBe(`${marker} 断网改动`);
});

test("⑦ 双标签 409：停写 → 显式载入服务器版本 → 新基线保存（库核）", async ({ authedPage: page }) => {
  const marker = `T08CF-${Date.now()}`;
  const noteId = await apiSeedNote(page, `${marker} 冲突`);

  const page2 = await page.context().newPage(); // 同一 context：共享 session cookie（不得重复登录）
  try {
    const noteUrl = `/l3?section=study-notes&venue=cloze&noteId=${noteId}`;

    // 两标签都打开同一篇（均 GET 零创建）
    await page.goto(noteUrl);
    await expect(page.getByTestId("study-note-editor")).toBeVisible({ timeout: 15_000 });
    await page2.goto(noteUrl);
    await expect(page2.getByTestId("study-note-editor")).toBeVisible({ timeout: 15_000 });

    // 标签一保存（推进服务端版本；以库核为准等待落库）
    const versionBefore = (await fetchNoteTitle(noteId)).version;
    await page.getByTestId("note-title").fill(`${marker} 标签一`);
    await expect
      .poll(async () => (await fetchNoteTitle(noteId)).version, { timeout: 15_000 })
      .toBe(versionBefore + 1);
    expect((await fetchNoteTitle(noteId)).title).toBe(`${marker} 标签一`);

    // 标签二（旧基线）保存 → 真实 409 → 冲突面板；本地输入保留、未静默覆盖
    await page2.getByTestId("note-title").fill(`${marker} 标签二`);
    await expect(page2.getByTestId("conflict-panel")).toBeVisible({ timeout: 15_000 });
    expect(await page2.getByTestId("note-title").inputValue()).toBe(`${marker} 标签二`);
    expect((await fetchNoteTitle(noteId)).title).toBe(`${marker} 标签一`);

    // 显式载入服务器版本 → 以新基线重新编辑保存
    await page2.getByRole("button", { name: "载入服务器版本" }).click();
    await expect(page2.getByTestId("note-title")).toHaveValue(`${marker} 标签一`, { timeout: 15_000 });
    await page2.getByTestId("note-title").fill(`${marker} 标签二改`);
    await expect
      .poll(async () => (await fetchNoteTitle(noteId)).title, { timeout: 15_000 })
      .toBe(`${marker} 标签二改`);
    expect((await fetchNoteTitle(noteId)).version).toBeGreaterThan(versionBefore + 1); // 新基线推进
  } finally {
    await page2.close();
  }
});

test("⑧ 未授权深链：不泄露内容、不创建替代", async ({ authedPage: page }) => {
  const tracked = trackRequests(page);
  const before = await countOwnerNotes();
  const strangerId = randomUUID(); // 不存在（或他人）的 noteId

  await page.goto(`/l3?section=study-notes&venue=cloze&noteId=${strangerId}`);
  await expect(page.getByTestId("note-error")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("note-error")).toContainText("不存在或无权访问");
  expect(tracked.posts).toEqual([]); // 不创建替代
  expect(await countOwnerNotes()).toBe(before);
});

test("⑨ 在途保存期间禁止错误导航：flush 落定后才离开", async ({ authedPage: page }) => {
  const marker = `T08INFLIGHT-${Date.now()}`;
  const noteId = await apiSeedNote(page, `${marker} 在途`);

  await page.route("**/api/l3/study-notes/**", async (route) => {
    if (route.request().method() === "PUT") {
      await new Promise((resolve) => setTimeout(resolve, 1500)); // 在途延迟
    }
    await route.continue();
  });

  await openWorkspace(page);
  await openNoteByMarker(page, marker);
  await page.getByTestId("note-title").fill(`${marker} 内容`);
  await page.getByTestId("leave-action").click();

  // 保存未落定：仍在原位（显示保存锁提示）
  await expect(page.getByText(/正在保存并确认未保存内容/)).toBeVisible({ timeout: 10_000 });
  expect(noteIdFromUrl(page)).toBe(noteId);

  // 落定后自动离开
  await page.waitForURL((url) => !url.searchParams.get("noteId"), { timeout: 15_000 });
  await expect
    .poll(async () => (await fetchNoteTitle(noteId)).title, { timeout: 10_000 })
    .toBe(`${marker} 内容`);
  await page.unroute("**/api/l3/study-notes/**");
});

// ── R1–R5 补修场景（⑩–⑭）────────────────────────────────────────────────────

/** 种子：创建专题（title 可直接进 create 请求，与笔记不同）。 */
async function apiSeedTopic(page: Page, title: string, venue = "cloze"): Promise<string> {
  const created = await pageApiCall(page, "/api/l3/study-topics", {
    method: "POST",
    body: { requestId: randomUUID(), venue, title },
  });
  if (created.status !== 201) throw new Error(`创建专题失败：${created.status} ${JSON.stringify(created.body)}`);
  return (created.body as { item: { id: string } }).item.id;
}

async function fetchTopicTitle(topicId: string): Promise<{ title: string; version: number }> {
  return withAdmin(async (client) => {
    const result = await client.query<{ title: string; version: number }>(
      "SELECT title, version FROM l3_study_topics WHERE id = $1::uuid AND user_id = $2::uuid",
      [topicId, OWNER_ID],
    );
    if (result.rows.length !== 1) throw new Error(`topic ${topicId} 不存在`);
    return result.rows[0]!;
  });
}

/** 取尽专题分页（点击「加载更多专题」直到入口消失），返回终态 DOM 的专题 id 集合。 */
async function exhaustTopicPagination(page: Page): Promise<string[]> {
  for (let guard = 0; guard < 10; guard += 1) {
    const moreButton = page.getByTestId("topic-load-more");
    if ((await moreButton.count()) === 0) break;
    const before = await page.getByTestId("topic-item").count();
    await moreButton.click();
    // 等待行数增长（响应驱动）；若等待失败但按钮已消失，说明 cursor 取尽（成功路径）
    try {
      await page.waitForFunction(
        (previous) => document.querySelectorAll('[data-testid="topic-item"]').length > previous,
        before,
        { timeout: 15_000 },
      );
    } catch {
      if ((await page.getByTestId("topic-load-more").count()) === 0) break;
      const now = await page.getByTestId("topic-item").count();
      const hasError = await page.getByTestId("topic-error").count();
      const errText = hasError ? await page.getByTestId("topic-error").textContent() : "(none)";
      throw new Error(
        `专题续取未增长且未取尽：before=${before} now=${now} topicError=${String(errText)}`,
      );
    }
  }
  // 终态统一收集（避免过渡帧重复行干扰）
  return (await page.getByTestId("topic-item").evaluateAll((rows) =>
    rows.map((row) => row.getAttribute("data-topic-id")),
  )) as string[];
}

/** 读取专题列表一页（真实服务端；用于选取确认不在首屏的深链目标）。 */
async function apiListTopics(
  page: Page,
  cursor?: string,
): Promise<{ ids: string[]; nextCursor: string | null }> {
  return page.evaluate(async (cursorValue: string | null) => {
    const query = new URLSearchParams({ venue: "cloze", limit: "20" });
    if (cursorValue) query.set("cursor", cursorValue);
    const response = await fetch(`/api/l3/study-topics?${query.toString()}`, {
      headers: { "X-Requested-With": "VocabObservatory" },
    });
    const body = (await response.json()) as { items: Array<{ id: string }>; nextCursor?: string | null };
    return { ids: body.items.map((item) => item.id), nextCursor: body.nextCursor ?? null };
  }, cursor ?? null);
}

test("⑩a R1 专题分页：55 个专题全数可达、无重无漏（独立断言）", async ({ authedPage: page }) => {
  test.setTimeout(120_000);
  const marker = `T08R1-${Date.now()}`;
  const seededIds: string[] = [];
  for (let index = 0; index < 55; index += 1) {
    seededIds.push(await apiSeedTopic(page, `${marker}-${String(index).padStart(2, "0")}`));
  }
  expect(new Set(seededIds).size).toBe(55);

  await openWorkspace(page);
  await expect(page.getByTestId("topic-item")).toHaveCount(20, { timeout: 15_000 }); // 首页 20
  await expect(page.getByTestId("topic-load-more")).toBeVisible();

  const visibleIds = await exhaustTopicPagination(page);
  expect(new Set(visibleIds).size).toBe(visibleIds.length); // 无重复
  // 本 suite 的 ④ 场景可能已创建遗留专题（beforeAll 只清一次）：断言「本批 seed 全数可达 + 无遗漏」
  expect(new Set(seededIds).difference(new Set(visibleIds)).size).toBe(0);
});

test("⑩b R1 后页深链：真实首屏响应选取非首页 ID → 直接 goto 自动定位 → 重命名（库核；无预翻页/无点击目标）", async ({ authedPage: page }) => {
  test.setTimeout(120_000);
  const marker = `T08R1B-${Date.now()}`;
  const seededIds: string[] = [];
  for (let index = 0; index < 25; index += 1) {
    seededIds.push(await apiSeedTopic(page, `${marker}-${String(index).padStart(2, "0")}`));
  }

  // 读取真实第一页 ID 集合（与 UI 首屏同源排序），选一个「确定不在首页」的目标
  const firstPage = await apiListTopics(page);
  expect(firstPage.nextCursor).not.toBeNull();
  const offPageId = seededIds.find((id) => !firstPage.ids.includes(id));
  expect(offPageId).toBeTruthy(); // 25 个 seed 中必有不在首页者

  const expectedBefore = await fetchTopicTitle(offPageId!);

  // 直接进入深链：不点击「加载更多专题」、不点击目标项 —— 页面应自动定位
  await page.goto(`/l3?section=study-notes&venue=cloze&topicId=${offPageId}`);
  await expect(page.getByTestId("topic-rename-input")).toBeVisible({ timeout: 20_000 }); // 定位完成：重命名入口出现
  await expect(page.getByTestId("topic-version")).toContainText(`v${expectedBefore.version}`); // 服务端真实版本
  await expect(page.getByTestId("topic-locate-error")).toHaveCount(0);

  await page.getByTestId("topic-rename-input").fill(`${marker}-后页改名`);
  await page.getByTestId("topic-rename-submit").click();
  await expect(
    page.getByTestId("topic-item").filter({ hasText: `${marker}-后页改名` }),
  ).toBeVisible({ timeout: 10_000 });

  const renamed = await fetchTopicTitle(offPageId!);
  expect(renamed.title).toBe(`${marker}-后页改名`);
  expect(renamed.version).toBe(expectedBefore.version + 1);
});

test("⑪ R2 迟到创建回包不注入新题型：真实 POST 响应挂在门闩后交付；UUID/标题双断言 + 库核", async ({ authedPage: page }) => {
  test.setTimeout(90_000);
  const marker = `T08R2-${Date.now()}`;
  let capturedId: string | null = null;
  let createDelivered = false;
  let releaseCreate!: () => void;
  const createGate = new Promise<void>((resolve) => {
    releaseCreate = resolve;
  });

  await page.route("**/api/l3/study-topics", async (route) => {
    if (route.request().method() === "POST") {
      const response = await route.fetch(); // 真实请求已提交（服务端已落库）
      const body = (await response.json()) as { item: { id: string } };
      capturedId = body.item.id; // 真实 UUID
      await createGate; // 持有真实响应，等待放行时机
      await route.fulfill({ response }); // 交付真实响应（非伪造）
      createDelivered = true;
      return;
    }
    await route.continue();
  });

  await openWorkspace(page);
  await page.getByTestId("topic-create-input").fill(`${marker}-完形`);
  await page.getByTestId("topic-create-submit").click(); // POST → route.fetch → 交付挂起

  // 等真实响应已取得（此时尚未交付给 UI）
  await expect.poll(() => capturedId, { timeout: 15_000 }).not.toBeNull();
  expect(createDelivered).toBe(false);

  // 切题型：新题型首屏 GET 完成（创建响应仍被门闩持有）
  await page.getByTestId("venue-chip-sentence_translation").click();
  await expect(page.getByTestId("topic-unfiled-button")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("list-total")).toBeVisible({ timeout: 15_000 });

  // 新题型首屏已完成 → 现在才放行旧题型创建响应
  releaseCreate();
  await expect.poll(() => createDelivered, { timeout: 10_000 }).toBe(true);
  await page.waitForTimeout(500); // 渲染稳定窗口（顺序由门闩与首屏断言保证，非 sleep 证明）

  // 双断言：UUID 不混入（同类型比较）+ 标题不出现
  const translationIds = await page.getByTestId("topic-item").evaluateAll((rows) =>
    rows.map((row) => row.getAttribute("data-topic-id")),
  );
  const translationTexts = await page.getByTestId("topic-item").evaluateAll((rows) =>
    rows.map((row) => row.textContent ?? ""),
  );
  expect(translationIds).not.toContain(capturedId);
  expect(translationTexts.join("|")).not.toContain(`${marker}-完形`);

  // 切回 cloze：真实成功可读；库核仅一条
  await page.getByTestId("venue-chip-cloze").click();
  await expect(
    page.getByTestId("topic-item").filter({ hasText: `${marker}-完形` }),
  ).toBeVisible({ timeout: 15_000 });
  await withAdmin(async (client) => {
    const result = await client.query<{ n: number; title: string }>(
      "SELECT count(*)::int AS n, min(title) AS title FROM l3_study_topics WHERE user_id = $1::uuid AND id = $2::uuid",
      [OWNER_ID, capturedId],
    );
    expect(result.rows[0]!.n).toBe(1);
    expect(result.rows[0]!.title).toBe(`${marker}-完形`);
  });
  await page.unroute("**/api/l3/study-topics");
});

test("⑫ R3 迟到刷新（缓存真实 v1 响应）不退已确认 v2；loading 终结、可续写 v3（库核）", async ({ authedPage: page }) => {
  test.setTimeout(90_000);
  const marker = `T08R3-${Date.now()}`;
  const topicId = await apiSeedTopic(page, `${marker}-原题`);

  await openWorkspace(page);
  const topicItem = page.getByTestId("topic-item").filter({ hasText: `${marker}-原题` });
  await expect(topicItem).toBeVisible({ timeout: 15_000 });
  await topicItem.click();

  // 门闩：刷新触发的 GET → 先取真实 v1 响应并持有交付
  let capturedV1: import("@playwright/test").APIResponse | null = null;
  let capturedV1Version = -1;
  let releaseRefresh!: () => void;
  const refreshGate = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });
  await page.route("**/api/l3/study-topics*", async (route) => {
    if (route.request().method() === "GET") {
      const response = await route.fetch(); // 真实 v1 快照（此刻写尚未发生）
      const body = (await response.json()) as { items: Array<{ version: number }> };
      capturedV1 = response;
      capturedV1Version = body.items[0]?.version ?? -1;
      await refreshGate; // 持有真实 v1，等待 PUT 完成后再交付
      await route.fulfill({ response });
      return;
    }
    await route.continue();
  });

  await page.getByTestId("topic-refresh-button").click(); // GET → fetch → 交付挂起
  await expect.poll(() => capturedV1, { timeout: 15_000 }).not.toBeNull();
  expect(capturedV1Version).toBe(1); // 缓存的确实是 v1（非写后快照）

  // 写确认 v2（PUT 不被拦截，走真实服务端）
  await page.getByTestId("topic-rename-input").fill(`${marker}-v2名`);
  await page.getByTestId("topic-rename-submit").click();
  await expect(
    page.getByTestId("topic-item").filter({ hasText: `${marker}-v2名` }),
  ).toBeVisible({ timeout: 10_000 });

  // 交付缓存的真实 v1 响应（旧快照晚到）
  releaseRefresh();
  await page.waitForTimeout(600); // 渲染稳定窗口（顺序由门闩与版本断言保证）

  // 数据不退 + 加载终态（不残留"正在加载专题…"）
  await expect(page.getByTestId("topic-version")).toContainText("v2");
  await expect(page.getByText("正在加载专题…")).toHaveCount(0);

  // 续写 v3：写基线必须是已确认的 v2（若被 v1 回退，此写将 409）
  await page.getByTestId("topic-rename-input").fill(`${marker}-v3名`);
  await page.getByTestId("topic-rename-submit").click();
  await expect(
    page.getByTestId("topic-item").filter({ hasText: `${marker}-v3名` }),
  ).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("topic-version")).toContainText("v3");

  const finalTopic = await fetchTopicTitle(topicId);
  expect(finalTopic.title).toBe(`${marker}-v3名`);
  expect(finalTopic.version).toBe(3);
  await page.unroute("**/api/l3/study-topics*");
});

test("⑬ R4 翻页挂起时刷新：释放加载锁、可再次翻页（真实 HTTP 延迟 + 库核归档）", async ({ authedPage: page }) => {
  test.setTimeout(120_000);
  const marker = `T08R4-${Date.now()}`;
  const noteIds: string[] = [];
  for (let index = 0; index < 25; index += 1) {
    noteIds.push(await apiSeedNote(page, `${marker}-${String(index).padStart(2, "0")}`));
  }

  await openWorkspace(page);
  await searchMarker(page, marker, 20, 25);

  // 仅延迟带 cursor 的翻页请求（refresh 无 cursor，立即返回）
  await page.route("**/api/l3/study-notes*", async (route) => {
    if (route.request().method() === "GET" && new URL(route.request().url()).searchParams.has("cursor")) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    await route.continue();
  });

  await page.getByTestId("load-more-button").click(); // 翻页挂起
  await expect(page.getByTestId("load-more-button")).toBeDisabled();

  // 归档第一行 → 触发列表 refresh（取代挂起翻页）
  await page.getByTestId("study-note-row").first().getByTestId("row-archive").click();
  await expect(page.getByTestId("load-more-button")).toBeEnabled({ timeout: 10_000 }); // R4：释放

  // 挂起的旧翻页回包到达（被丢弃）；再次翻页确实发请求并增量合并
  await page.waitForTimeout(2000);
  await page.getByTestId("load-more-button").click();
  // refresh 不带 status 过滤：25 条（24 active + 1 archived）；首页 20 + 第二页 5
  await expect(page.getByTestId("study-note-row")).toHaveCount(25, { timeout: 10_000 });
  // 归档行在列表中呈现已归档状态（refresh 取到归档结果）
  await expect(page.getByTestId("study-note-row").first()).toContainText("已归档");

  const ids = await page.getByTestId("study-note-row").evaluateAll((rows) =>
    rows.map((row) => row.getAttribute("data-note-id")),
  );
  expect(new Set(ids).size).toBe(25); // 去重成立（旧翻页回包未重复合并）
  await withAdmin(async (client) => {
    const result = await client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM l3_study_notes WHERE user_id = $1::uuid AND status = 'archived' AND title LIKE $2",
      [OWNER_ID, `${marker}%`],
    );
    expect(result.rows[0]!.n).toBe(1); // 归档恰好 1 条（库核）
  });
  await page.unroute("**/api/l3/study-notes*");
});

test("⑭ R5 防抖期点击加载更多：不发『新 q + 旧 cursor』错配请求（服务端无 400）", async ({ authedPage: page }) => {
  test.setTimeout(90_000);
  const marker = `T08R5-${Date.now()}`;
  for (let index = 0; index < 25; index += 1) {
    await apiSeedNote(page, `${marker}-${String(index).padStart(2, "0")}`);
  }

  await openWorkspace(page);
  await searchMarker(page, marker, 20, 25);

  const badRequests: string[] = [];
  const listResponses: number[] = [];
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.pathname === "/api/l3/study-notes") listResponses.push(response.status());
  });
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (request.method() === "GET" && url.pathname === "/api/l3/study-notes") {
      const cursor = url.searchParams.get("cursor");
      const q = url.searchParams.get("q");
      // 错配定义：带 cursor 的翻页请求同时携带 q（防抖期组合）
      if (cursor && q) badRequests.push(request.url());
    }
  });

  // 输入新搜索词（300ms 防抖挂起）→ R5 修复：旧游标立即失效 → 「加载更多」入口即时关闭
  await page.getByTestId("search-input").fill(`${marker}-不匹配词`);
  await expect(page.getByTestId("load-more-button")).toHaveCount(0, { timeout: 5_000 });

  // 防抖到期：唯一的新请求 = 新 q 首页（无 cursor）；全程无错配、无 400
  await expect(page.getByTestId("list-empty")).toBeVisible({ timeout: 10_000 });
  expect(badRequests).toEqual([]);
  expect(listResponses.filter((status) => status === 400)).toEqual([]);
  expect(listResponses.every((status) => status < 400)).toBe(true);
});

// ── 交错场景（⑮–⑰；deferred 门闩控制真实响应交付次序，禁 sleep 证序）──────

test("⑮ F2b 交错：旧题型写确认先交付、新题型首屏 GET 后交付 —— 新读不被作废", async ({ authedPage: page }) => {
  test.setTimeout(90_000);
  const marker = `T08R2B-${Date.now()}`;
  let capturedCreateId: string | null = null;
  let releaseCreate!: () => void;
  const createGate = new Promise<void>((resolve) => {
    releaseCreate = resolve;
  });
  let translationCaptured = false;
  let releaseTranslation!: () => void;
  const translationGate = new Promise<void>((resolve) => {
    releaseTranslation = resolve;
  });

  let getCount = 0;
  await page.route("**/api/l3/study-topics*", async (route) => {
    const method = route.request().method();
    if (method === "POST") {
      const response = await route.fetch();
      const body = (await response.json()) as { item: { id: string } };
      capturedCreateId = body.item.id;
      await createGate;
      await route.fulfill({ response });
      return;
    }
    if (method === "GET") {
      getCount += 1;
      if (getCount >= 2) {
        // 第二次及以后（translation 首屏等）：缓存真实响应，挂闸交付
        const response = await route.fetch();
        translationCaptured = true;
        await translationGate;
        await route.fulfill({ response });
        return;
      }
    }
    await route.continue();
  });

  await openWorkspace(page); // cloze 首屏 GET（#1 直通）
  await page.getByTestId("topic-create-input").fill(`${marker}-完形`);
  await page.getByTestId("topic-create-submit").click(); // POST → 真实响应被门闩持有
  await expect.poll(() => capturedCreateId, { timeout: 15_000 }).not.toBeNull();

  await page.getByTestId("venue-chip-sentence_translation").click(); // translation 首屏 GET（#2 挂闸）
  await expect.poll(() => translationCaptured, { timeout: 15_000 }).toBe(true);

  // 写确认先交付（新题型 GET 仍被持有）
  releaseCreate();
  await page.waitForTimeout(300);

  // 新题型数据后交付：必须正常装配（F2b）
  releaseTranslation();
  await expect(page.getByTestId("topic-unfiled-button")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("正在加载专题…")).toHaveCount(0);
  const ids = await page.getByTestId("topic-item").evaluateAll((rows) =>
    rows.map((row) => row.getAttribute("data-topic-id")),
  );
  expect(ids).not.toContain(capturedCreateId); // 未混入当前视图

  // 库核：真实创建存在且仅一条
  await withAdmin(async (client) => {
    const result = await client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM l3_study_topics WHERE user_id = $1::uuid AND id = $2::uuid",
      [OWNER_ID, capturedCreateId],
    );
    expect(result.rows[0]!.n).toBe(1);
  });
  await page.unroute("**/api/l3/study-topics*");
});

test("⑯ F1 交错：专题翻页挂起时刷新 —— 释放 pending、可再次翻页取尽（无重）", async ({ authedPage: page }) => {
  test.setTimeout(120_000);
  const marker = `T08F1-${Date.now()}`;
  const seededIds: string[] = [];
  for (let index = 0; index < 25; index += 1) {
    seededIds.push(await apiSeedTopic(page, `${marker}-${String(index).padStart(2, "0")}`));
  }

  let cursorHits = 0;
  let releaseCursor!: () => void;
  const cursorGate = new Promise<void>((resolve) => {
    releaseCursor = resolve;
  });
  await page.route("**/api/l3/study-topics*", async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() === "GET" && url.searchParams.has("cursor")) {
      cursorHits += 1;
      if (cursorHits === 1) {
        const response = await route.fetch(); // 真实翻页响应，门闩持有
        await cursorGate;
        await route.fulfill({ response });
        return;
      }
    }
    await route.continue();
  });

  await openWorkspace(page);
  await expect(page.getByTestId("topic-item")).toHaveCount(20, { timeout: 15_000 }); // 首页 20
  await page.getByTestId("topic-load-more").click(); // 翻页挂起（真实响应被持有）
  await expect(page.getByTestId("topic-load-more")).toBeDisabled();
  await expect.poll(() => cursorHits, { timeout: 15_000 }).toBe(1);

  // 刷新取代挂起翻页：刷新完成后 pending 必须被释放（按钮可用）
  await page.getByTestId("topic-refresh-button").click();
  await expect(page.getByTestId("topic-load-more")).toBeEnabled({ timeout: 15_000 });

  // 交付旧翻页响应（应被丢弃）
  releaseCursor();
  await page.waitForTimeout(500);
  await expect(page.getByTestId("topic-item")).toHaveCount(20); // 旧数据未混入

  // 再次翻页：真实发出并取尽 marker 集合（含第二页）
  await page.getByTestId("topic-load-more").click();
  await expect(
    page.getByTestId("topic-item").filter({ hasText: `${marker}-00` }),
  ).toBeVisible({ timeout: 15_000 });
  const ids = await page.getByTestId("topic-item").evaluateAll((rows) =>
    rows.map((row) => row.getAttribute("data-topic-id")),
  );
  expect(new Set(ids).size).toBe(ids.length); // 无重复
  expect(new Set(seededIds).difference(new Set(ids)).size).toBe(0); // seed 全部可达
  await page.unroute("**/api/l3/study-topics*");
});

test("⑰ F3 交错：后页定位在途切题型 —— 定位结果不污染新题型列表", async ({ authedPage: page }) => {
  test.setTimeout(120_000);
  const marker = `T08F3-${Date.now()}`;
  const seededIds: string[] = [];
  for (let index = 0; index < 25; index += 1) {
    seededIds.push(await apiSeedTopic(page, `${marker}-${String(index).padStart(2, "0")}`));
  }
  const firstPage = await apiListTopics(page);
  const offPageId = seededIds.find((id) => !firstPage.ids.includes(id));
  expect(offPageId).toBeTruthy();

  let releaseWalk!: () => void;
  const walkGate = new Promise<void>((resolve) => {
    releaseWalk = resolve;
  });
  let walkCaptured = false;
  await page.route("**/api/l3/study-topics*", async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() === "GET" && url.searchParams.has("cursor") && !walkCaptured) {
      const response = await route.fetch(); // 真实定位响应，门闩持有
      walkCaptured = true;
      await walkGate;
      await route.fulfill({ response });
      return;
    }
    await route.continue();
  });

  await page.goto(`/l3?section=study-notes&venue=cloze&topicId=${offPageId}`);
  await expect(page.getByTestId("topic-locating")).toBeVisible({ timeout: 15_000 }); // 定位中（F4）
  await expect.poll(() => walkCaptured, { timeout: 15_000 }).toBe(true);

  // 定位在途切题型（URL 清 topicId → 定位作废）
  await page.getByTestId("venue-chip-sentence_translation").click();
  await expect(page.getByTestId("topic-unfiled-button")).toBeVisible({ timeout: 15_000 });

  // 交付旧题型定位响应：不得污染 translation 列表、不显示错误
  releaseWalk();
  await page.waitForTimeout(500);
  const ids = await page.getByTestId("topic-item").evaluateAll((rows) =>
    rows.map((row) => row.getAttribute("data-topic-id")),
  );
  expect(ids.some((id) => seededIds.includes(id!))).toBe(false); // 无 cloze 专题混入
  await expect(page.getByTestId("topic-locate-error")).toHaveCount(0);
  await expect(page.getByText("正在加载专题…")).toHaveCount(0);
  await page.unroute("**/api/l3/study-topics*");
});
