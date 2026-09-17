/**
 * Integration test — L2 content append semantics on the real PostgreSQL DB.
 * Skipped unless TEST_DATABASE_URL is set.
 *
 * Run with: npm run test:integration
 *
 * P0 修正守护（ADR-0017「修正（2026-09-11）：方向不设唯一约束」）：
 * direction 只作内容维度，同一 (word_id, field, direction) 的 active 行可 0..n 条。
 * 修复前（旧版 0027 带 partial UNIQUE + preflight 守卫）实测 4 failed / 1 passed：
 *   (a) 两次 confirmDraft 同字段 → 第二次撞 23505（collocation, 通用）
 *   (b) 已有 active 行时 append 采纳候选 → 撞 23505（corpus, 通用）
 *   (c) replace 采纳 → 通过（先退休兄弟行再激活，本就不依赖索引缺失）
 *   (d) 造"同 direction 两条 active"夹具本身撞 23505 → 失败
 *   (e) 索引存在性断言 → 失败（索引仍在）
 * 修复后（0027 删除索引/守卫 + 0029 兜底 DROP INDEX）5/5 全部通过。
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { createRepositories, resetDb, withTransaction } from "@/index";
import { getPool } from "@/db/connection";
import { L2ContentService } from "@/services/l2-content.service";
import { extractL2Items } from "@/repositories/l2-content.repository";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;

const COLLOCATION_A = [
  {
    phrase: "abandon ship",
    gloss: "弃船",
    tone: "neutral",
    example: "The captain ordered to abandon ship.",
    exampleTranslation: "船长下令弃船。",
  },
];
const COLLOCATION_B = [
  {
    phrase: "abandon hope",
    gloss: "放弃希望",
    tone: "neutral",
    example: "Never abandon hope.",
    exampleTranslation: "永不放弃希望。",
  },
];
const CORPUS_A = [
  { text: "They had to abandon the project.", translation: "他们不得不放弃这个项目。", source: "generated" },
];
const CORPUS_B = [
  { text: "The search was abandoned at dusk.", translation: "搜索在黄昏时被放弃。", source: "generated" },
];
const SYNONYM_A = [
  {
    word: "desert",
    semanticDiff: "强调违背义务",
    tone: "formal",
    usage: "多用于人离开职责",
    delta: "abandon 更通用",
    object: "人/地点",
  },
];
const SYNONYM_B = [
  {
    word: "forsake",
    semanticDiff: "强调彻底舍弃",
    tone: "formal",
    usage: "书面语",
    delta: "abandon 更口语",
    object: "人/信念",
  },
];

describe.skipIf(!TEST_DB_URL)("L2 content append semantics (integration)", () => {
  const service = new L2ContentService({});
  const actorId = randomUUID();
  let wordId = "";

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB_URL!;
    wordId = randomUUID();
    await getPool().query(
      `INSERT INTO words (id, slug, content_hash, source_path, title, lemma, definition_md, body_md)
       VALUES ($1, $2, $3, 'test/l2-append.md', 'l2-append', 'l2append', 'def', 'body')`,
      [wordId, `l2-append-${wordId.slice(0, 8)}`, createHash("sha256").update(wordId).digest("hex")],
    );
  });

  afterAll(async () => {
    await getPool().query("DELETE FROM words WHERE id = $1", [wordId]);
    await resetDb();
  });

  async function activeRows(field: string): Promise<Array<{
    id: string;
    direction: string;
    is_active: boolean;
    approved_at: string | null;
    content: unknown;
  }>> {
    const rows = await getPool().query(
      `SELECT id, direction, is_active, approved_at, content
       FROM word_l2_content
       WHERE word_id = $1 AND field = $2 AND is_active = true
       ORDER BY created_at, id`,
      [wordId, field],
    );
    return rows.rows;
  }

  async function activePhrases(field: string, key: string): Promise<string[]> {
    const rows = await activeRows(field);
    // content 可能是裸数组或 v1 wrapper（{schemaVersion, items}）——用仓库的
    // extractL2Items 归一化，避免假设存储形态。
    return rows
      .flatMap((row) => extractL2Items(row.content) as Array<Record<string, unknown>>)
      .map((item) => String(item[key]));
  }

  async function allRows(field: string): Promise<Array<{
    id: string;
    is_active: boolean;
    approved_at: string | null;
  }>> {
    const rows = await getPool().query(
      `SELECT id, is_active, approved_at FROM word_l2_content
       WHERE word_id = $1 AND field = $2 ORDER BY created_at, id`,
      [wordId, field],
    );
    return rows.rows;
  }

  async function cacheItemCount(column: string): Promise<number> {
    const row = (await getPool().query(`SELECT ${column} AS items FROM words WHERE id = $1`, [wordId])).rows[0];
    return (row.items as unknown[]).length;
  }

  it("(a) 同字段连续两次 confirmDraft 都成功，两行 active 共存，缓存含两组条目", async () => {
    await service.confirmDraft(wordId, "collocation", COLLOCATION_A, { source: "manual", actorId });
    await service.confirmDraft(wordId, "collocation", COLLOCATION_B, { source: "manual", actorId });

    const rows = await activeRows("collocation");
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.direction === "通用")).toBe(true);
    expect(await cacheItemCount("collocations")).toBe(2);
  });

  it("(b) 已有 active 行时以 append 采纳候选 → 成功共存", async () => {
    await service.confirmDraft(wordId, "corpus", CORPUS_A, { source: "manual", actorId });
    const { candidateId } = await service.proposeCandidates(wordId, "corpus", CORPUS_B, {
      source: "external_chat",
      actorId,
    });

    const result = await service.acceptCandidate(wordId, candidateId, undefined, actorId, "append");

    expect(result).toEqual({ itemCount: 1, replacedCount: 0 });
    const rows = await activeRows("corpus");
    // 两条 active 共存：原行 + 被采纳的候选行（candidateId 必须在其列）。
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.id)).toContain(candidateId);
    expect(await activePhrases("corpus", "text")).toEqual(
      expect.arrayContaining([CORPUS_A[0]!.text, CORPUS_B[0]!.text]),
    );
    expect(await cacheItemCount("corpus_items")).toBe(2);
  });

  it("(c) 以 replace 采纳 → 兄弟行转 retired（留档，不删除）", async () => {
    await service.confirmDraft(wordId, "synonym", SYNONYM_A, { source: "manual", actorId });
    const { candidateId } = await service.proposeCandidates(wordId, "synonym", SYNONYM_B, {
      source: "external_chat",
      actorId,
    });

    const result = await service.acceptCandidate(wordId, candidateId, undefined, actorId, "replace");

    expect(result).toEqual({ itemCount: 1, replacedCount: 1 });
    const rows = await allRows("synonym");
    expect(rows).toHaveLength(2);
    const active = rows.filter((row) => row.is_active);
    const retired = rows.filter((row) => !row.is_active);
    expect(active).toHaveLength(1);
    expect(active[0]!.approved_at).not.toBeNull();
    expect(retired).toHaveLength(1);
    // 留档：approved_at 有值（不回收件箱），内容不删除。
    expect(retired[0]!.approved_at).not.toBeNull();
    expect(await cacheItemCount("synonym_items")).toBe(1);
  });

  it("(d) refresh_l2_cache：按 created_at 聚合、条目带 direction、跨调用逐字节稳定", async () => {
    await getPool().query(
      `INSERT INTO word_l2_content (word_id, field, direction, content, source, created_at) VALUES
         ($1, 'antonym', '通用', '[{"word":"retain"}]'::jsonb, 'p0-fix-probe', '2026-01-01T00:00:00Z'),
         ($1, 'antonym', '考研', '[{"word":"forfeit"}]'::jsonb, 'p0-fix-probe', '2026-01-02T00:00:00Z'),
         ($1, 'antonym', '通用', '[{"word":"withhold"}]'::jsonb, 'p0-fix-probe', '2026-01-03T00:00:00Z')`,
      [wordId],
    );

    await withTransaction(async (tx) => {
      await createRepositories(tx).l2Content.refreshL2Cache(wordId);
    }, { actorId });
    const first = (await getPool().query("SELECT antonym_items AS items FROM words WHERE id = $1", [wordId])).rows[0].items;

    await withTransaction(async (tx) => {
      await createRepositories(tx).l2Content.refreshL2Cache(wordId);
    }, { actorId });
    const second = (await getPool().query("SELECT antonym_items AS items FROM words WHERE id = $1", [wordId])).rows[0].items;

    expect(first).toEqual([
      { word: "retain", direction: "通用" },
      { word: "forfeit", direction: "考研" },
      { word: "withhold", direction: "通用" },
    ]);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("(e) P0 修正守护：word_l2_content 不存在同键唯一索引", async () => {
    const rows = await getPool().query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'word_l2_content'`,
    );
    const names = rows.rows.map((row) => row.indexname);
    expect(names).not.toContain("word_l2_content_word_field_direction_active_unique");
    // 唯一性约束也不得复活：任何同时涉及 UNIQUE 与 direction 的索引都算违规
    // （pkey 是 UNIQUE 但不含 direction，不在此列）。
    const uniques = await getPool().query<{ count: string }>(
      `SELECT count(*)::text AS count FROM pg_indexes
       WHERE schemaname = 'public' AND tablename = 'word_l2_content'
         AND indexdef LIKE '%UNIQUE%' AND indexdef LIKE '%direction%'`,
    );
    expect(uniques.rows[0]!.count).toBe("0");
  });
});
