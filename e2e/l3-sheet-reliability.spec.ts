/**
 * Task B · 普通题纸可靠保存与定格闭环（真环境：真实浏览器 + 真实 HTTP + 真实 PG）。
 *
 * 覆盖（任务书 Task B 验收）：
 *  ① 作答→保存→定格→离开→同 sheet 回看→刷新评卷；
 *     库核：answer 物化、定格清空（attempts 为唯一真源）、**零多建纸**（回看不产生新纸）；
 *  ② 故障：PATCH 持续失败（422，非可重试）→ 定格被屏障阻断（seal 不发出）、
 *     最后输入保留（本地选中态不丢、库内不固化旧值）、手动重试可恢复（诚实可操作）。
 *
 * 栈：SERVE_FRONTEND=true 单进程（SPA+API，端口 E2E_PORT）+ 独立验收库。
 * 数据：本文件自播种（admin 角色，E2E_SETUP_DATABASE_URL）并自清理；仅隔离 fixture。
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { expect, loginAsOwner, test } from "./fixtures";

const ADMIN_DB_URL = process.env.E2E_SETUP_DATABASE_URL ?? process.env.DATABASE_URL ?? "";
const OWNER_ID = process.env.E2E_OWNER_ID ?? "00000000-0000-1000-8000-000000000001";

async function withAdmin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: ADMIN_DB_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

interface Fixture {
  sourceId: string;
  questionId: string;
  questionId2: string;
  paperId: string;
  scopeKey: string;
}

/** 播种：1 source + 2 道 reading_choice 题（Q1 选项含 beta marker；Q2 选项含 gamma marker）+ 1 卷。 */
async function seedPaper(): Promise<Fixture> {
  const sourceId = randomUUID();
  const questionId = randomUUID();
  const questionId2 = randomUUID();
  const paperId = randomUUID();
  const scopeKey = `paper:${paperId}`;
  await withAdmin(async (client) => {
    await client.query(
      `INSERT INTO l3_sources (id, user_id, source_type, direction, title, content_text)
       VALUES ($1::uuid, $2::uuid, 'article', '通用', 'Task B 可靠性验收语料', 'Reliability fixture passage for the exam sheet flow.')`,
      [sourceId, OWNER_ID],
    );
    await client.query(
      `INSERT INTO l3_questions (id, user_id, source_id, space, question_type, ordinal, stem, options, answer, status)
       VALUES ($1::uuid, $2::uuid, $3::uuid, '阅读', 'reading_choice', 0, '1. Which marker is the fixture answer?', $4::jsonb, $5::jsonb, 'active')`,
      [
        questionId,
        OWNER_ID,
        sourceId,
        JSON.stringify([
          { key: "A", text: "alpha marker" },
          { key: "B", text: "beta marker" },
        ]),
        JSON.stringify({ choice: "B" }),
      ],
    );
    await client.query(
      `INSERT INTO l3_questions (id, user_id, source_id, space, question_type, ordinal, stem, options, answer, status)
       VALUES ($1::uuid, $2::uuid, $3::uuid, '阅读', 'reading_choice', 1, '2. Which marker belongs to the second question?', $4::jsonb, $5::jsonb, 'active')`,
      [
        questionId2,
        OWNER_ID,
        sourceId,
        JSON.stringify([
          { key: "A", text: "gamma marker" },
          { key: "B", text: "delta marker" },
        ]),
        JSON.stringify({ choice: "A" }),
      ],
    );
    await client.query(
      `INSERT INTO l3_papers (id, user_id, title, direction, metadata, payload, payload_version, status, created_by)
       VALUES ($1::uuid, $2::uuid, 'Task B 可靠性验收卷', '通用', '{}'::jsonb, $3::jsonb, 1, 'active', 'e2e')`,
      [
        paperId,
        OWNER_ID,
        JSON.stringify({
          version: 1,
          sections: [
            {
              key: "s1",
              title: "Task B · 两题节",
              fileKey: null,
              sourceId,
              questionIds: [questionId, questionId2],
              questionType: "reading_choice",
            },
          ],
        }),
      ],
    );
  });
  return { sourceId, questionId, questionId2, paperId, scopeKey };
}

async function cleanupFixture(f: Fixture): Promise<void> {
  await withAdmin(async (client) => {
    await client.query(
      "DELETE FROM l3_question_attempts WHERE sheet_id IN (SELECT id FROM l3_submissions WHERE user_id = $1::uuid AND scope_key = $2)",
      [OWNER_ID, f.scopeKey],
    );
    await client.query("DELETE FROM l3_submissions WHERE user_id = $1::uuid AND scope_key = $2", [OWNER_ID, f.scopeKey]);
    await client.query("DELETE FROM l3_papers WHERE id = $1::uuid", [f.paperId]);
    await client.query("DELETE FROM l3_questions WHERE id = ANY($1::uuid[])", [[f.questionId, f.questionId2]]);
    await client.query("DELETE FROM l3_sources WHERE id = $1::uuid", [f.sourceId]);
  });
}

interface SheetRow {
  id: string;
  status: string;
  answers: Record<string, unknown>;
  draft_version: number;
}

async function sheetRow(f: Fixture): Promise<SheetRow | null> {
  return withAdmin(async (client) => {
    const r = await client.query<SheetRow>(
      "SELECT id, status, answers, draft_version FROM l3_submissions WHERE user_id = $1::uuid AND scope_key = $2",
      [OWNER_ID, f.scopeKey],
    );
    return r.rows[0] ?? null;
  });
}

async function attemptCount(sheetId: string): Promise<number> {
  return withAdmin(async (client) => {
    const r = await client.query<{ c: number }>("SELECT count(*)::int AS c FROM l3_question_attempts WHERE sheet_id = $1", [sheetId]);
    return r.rows[0].c;
  });
}

async function sheetCount(f: Fixture): Promise<number> {
  return withAdmin(async (client) => {
    const r = await client.query<{ c: number }>(
      "SELECT count(*)::int AS c FROM l3_submissions WHERE user_id = $1::uuid AND scope_key = $2",
      [OWNER_ID, f.scopeKey],
    );
    return r.rows[0].c;
  });
}

test.describe("Task B · 题纸保存/定格屏障（真实栈）", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("作答→保存→定格→离开→同 sheet 回看→刷新评卷（库核：物化、清空、零多建纸）", async ({ authedPage: page }) => {
    test.setTimeout(90_000);
    const f = await seedPaper();
    try {
      await page.goto(`/l3?paper=${f.paperId}`);
      await expect(page.getByRole("button", { name: "定格题纸" })).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText("草稿", { exact: true })).toBeVisible({ timeout: 15_000 }); // 开纸就绪

      // 作答（beta marker）→ 防抖保存
      await page.getByRole("button", { name: /beta marker/ }).click();
      await expect(page.getByText(/草稿 · 已保存/)).toBeVisible({ timeout: 10_000 });

      const afterSave = await sheetRow(f);
      expect(afterSave?.status).toBe("draft");
      expect((afterSave?.answers?.[f.questionId] as { choice?: string } | undefined)?.choice).toBe("B");
      expect(afterSave!.draft_version).toBeGreaterThanOrEqual(1);

      // 定格（两题 fixture 只答其一：服务端软确认 → 「仍要定格」）
      await page.getByRole("button", { name: "定格题纸" }).click();
      await expect(page.getByRole("dialog", { name: "定格题纸" })).toBeVisible();
      await page.getByRole("button", { name: "确认定格" }).click();
      await expect(page.getByText(/还有 1 题未作答/)).toBeVisible({ timeout: 10_000 });
      await page.getByRole("button", { name: "仍要定格" }).click();
      await expect(page.getByText("已定格", { exact: true })).toBeVisible({ timeout: 15_000 });

      const sealed = await sheetRow(f);
      expect(sealed?.status).toBe("sealed");
      expect(Object.keys(sealed?.answers ?? {})).toHaveLength(0); // 定格清空：attempts 为唯一真源
      expect(await attemptCount(sealed!.id)).toBe(1); // answer 已物化

      // 离开 → 同 sheet 回看（只读）→ 刷新评卷
      await page.goto("/l3");
      await page.goto(`/l3?sheet=${sealed!.id}`);
      await expect(page.getByText("已定格", { exact: true })).toBeVisible({ timeout: 15_000 });
      const refresh = page.getByRole("button", { name: "刷新评卷" });
      await expect(refresh).toBeVisible();
      await refresh.click();
      await expect(page.getByText(/刷新中…|待评卷|已评/)).toBeVisible({ timeout: 10_000 });

      // 零多建纸：回看不产生新题纸
      expect(await sheetCount(f)).toBe(1);
    } finally {
      await cleanupFixture(f);
    }
  });

  test("故障：PATCH 持续失败 → 定格被屏障阻断、最后输入保留、手动重试可恢复", async ({ authedPage: page }) => {
    test.setTimeout(90_000);
    const f = await seedPaper();
    let sealRequests = 0;
    page.on("request", (request) => {
      if (request.method() === "POST" && request.url().endsWith("/seal")) sealRequests += 1;
    });
    try {
      await page.goto(`/l3?paper=${f.paperId}`);
      await expect(page.getByRole("button", { name: "定格题纸" })).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText("草稿", { exact: true })).toBeVisible({ timeout: 15_000 });

      let failPatches = true;
      await page.route("**/api/l3/sheets/**", (route) => {
        if (route.request().method() === "PATCH" && failPatches) {
          return route.fulfill({
            status: 422,
            contentType: "application/json",
            body: JSON.stringify({ error: "rejected", code: "VALIDATION_ERROR" }),
          });
        }
        return route.continue();
      });

      // 作答（PATCH 将持续 422 失败）
      await page.getByRole("button", { name: /beta marker/ }).click();
      await expect(page.getByText(/草稿 · 保存失败，尚未保存，请勿离开/)).toBeVisible({ timeout: 10_000 });
      await expect(page.getByRole("button", { name: "重试", exact: true })).toBeVisible();

      // 尝试定格：屏障阻断（seal 不得发出、题纸不得定格）
      await page.getByRole("button", { name: "定格题纸" }).click();
      await expect(page.getByRole("dialog", { name: "定格题纸" })).toBeVisible();
      await page.getByRole("button", { name: "确认定格" }).click();
      await expect(page.getByText(/定格失败/)).toBeVisible({ timeout: 10_000 });
      expect(sealRequests).toBe(0);
      // 失败后模态保持打开（不自动关闭）：先取消，回到卷面再走"重试保存"恢复路径
      await page.getByRole("button", { name: "取消", exact: true }).click();
      await expect(page.getByRole("dialog", { name: "定格题纸" })).toBeHidden();

      // 最后输入保留（本地选中态不丢）；库核：仍 draft、无物化、不固化旧值
      await expect(page.getByRole("button", { name: /beta marker/ })).toHaveAttribute("data-selected", "true");
      const draft = await sheetRow(f);
      expect(draft?.status).toBe("draft");
      expect(await attemptCount(draft!.id)).toBe(0);

      // 手动重试可恢复：放行后重试 → 已保存
      failPatches = false;
      await page.getByRole("button", { name: "重试", exact: true }).click();
      await expect(page.getByText(/草稿 · 已保存/)).toBeVisible({ timeout: 10_000 });
      const afterRetry = await sheetRow(f);
      expect((afterRetry?.answers?.[f.questionId] as { choice?: string } | undefined)?.choice).toBe("B");

      await page.unroute("**/api/l3/sheets/**");
    } finally {
      await cleanupFixture(f);
    }
  });

  test("双标签冲突：同题他写后本端 409（库不写入）；载入服务器版本后不同题改动保留并成功", async ({ authedPage: page, browser }) => {
    test.setTimeout(120_000);
    const f = await seedPaper();
    const contextB = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const pageB = await contextB.newPage();
    try {
      await loginAsOwner(pageB);

      // A 先答 Q1=A（alpha）保存成功 → v1
      await page.goto(`/l3?paper=${f.paperId}`);
      await expect(page.getByText("草稿", { exact: true })).toBeVisible({ timeout: 15_000 });
      await page.getByRole("button", { name: /alpha marker/ }).click();
      await expect(page.getByText(/草稿 · 已保存/)).toBeVisible({ timeout: 10_000 });
      const v1 = await sheetRow(f);
      expect(v1!.draft_version).toBe(1);

      // B 打开（基线 v1）→ 改同题 Q1=B（beta）保存成功 → v2（他端已写入）
      await pageB.goto(`/l3?paper=${f.paperId}`);
      await expect(pageB.getByText("草稿", { exact: true })).toBeVisible({ timeout: 15_000 });
      await pageB.getByRole("button", { name: /beta marker/ }).click();
      await expect(pageB.getByText(/草稿 · 已保存/)).toBeVisible({ timeout: 10_000 });
      const v2 = await sheetRow(f);
      expect(v2!.draft_version).toBe(2);
      expect((v2!.answers[f.questionId] as { choice?: string } | undefined)?.choice).toBe("B");

      // A 只改 Q2（gamma）→ PATCH(expectedVersion=1) 相对服务器 v2 → 409 冲突（库不写入）
      await page.getByRole("button", { name: /gamma marker/ }).click();
      await expect(page.getByText(/保存冲突/)).toBeVisible({ timeout: 10_000 });
      const conflicted = await sheetRow(f);
      expect(conflicted!.draft_version).toBe(2);
      expect(conflicted!.answers[f.questionId2]).toBeUndefined(); // 本地保留、未落库

      // A 载入服务器版本（明确恢复动作）→ 冲突解除；重新显式改 Q2 → v3（他端 Q1 未被覆盖）
      await page.getByRole("button", { name: "载入服务器版本" }).click();
      await expect(page.getByText(/保存冲突/)).toBeHidden({ timeout: 10_000 });
      await page.getByRole("button", { name: /gamma marker/ }).click();
      await expect(page.getByText(/草稿 · 已保存/)).toBeVisible({ timeout: 10_000 });
      const v3 = await sheetRow(f);
      expect(v3!.draft_version).toBe(3);
      expect((v3!.answers[f.questionId] as { choice?: string } | undefined)?.choice).toBe("B"); // 他端 Q1 保留
      expect((v3!.answers[f.questionId2] as { choice?: string } | undefined)?.choice).toBe("A"); // gamma 落库
    } finally {
      await contextB.close();
      await cleanupFixture(f);
    }
  });
});
