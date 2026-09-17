/**
 * L3 RLS 集成测试 —— 连接真实 PostgreSQL，验证素材空间的行级隔离。
 *
 * Run with: npm run rls:acceptance:verify（先起 acceptance 基建）或单跑：
 *   npm run rls:acceptance:test:l3
 *
 * 前置（与 tests/db/transaction-rls.integration.test.ts 同一套基建）：
 * - TEST_DATABASE_URL       管理连接（vocab_rls_admin@55433）——仅用于 seed/cleanup/grant
 * - TEST_APP_DATABASE_URL   受限应用连接（vocab_app@55433）——表属主为 vocab_migration，
 *                           vocab_app NOBYPASSRLS 非属主 → auth.uid() 策略强制生效
 *
 * 覆盖：三件套写入（RLS WITH CHECK）、跨用户读隔离、跨用户写无操作、
 * 冒名插入被 RLS 拒绝、双用户互不可见、删除级联 + bound_sense 落库；
 * 0033 批次一：做题注记/标签字典隔离（读不可见、冒名 WITH CHECK、update/软删
 * 无操作）与题删除经 vocab_app 级联清理注记。
 */

import { createHash, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { L3ContextRepository } from "@/repositories/l3-context.repository";
import { resetPool } from "@/db/connection";
import { withTransaction } from "@/db/transaction";

const adminDatabaseUrl = process.env.TEST_DATABASE_URL;
const appDatabaseUrl = process.env.TEST_APP_DATABASE_URL;

// Fail closed, matching tests/db/transaction-rls.integration.test.ts. This file
// is collected unconditionally by `npm run test:integration`; a silent skip
// would let the L3 isolation guarantees go unverified while the suite still
// exits 0. Missing wiring must break the run, not disappear from it.
if (!adminDatabaseUrl) {
  throw new Error("TEST_DATABASE_URL is required to seed the L3 RLS fixture");
}
if (!appDatabaseUrl) {
  throw new Error("TEST_APP_DATABASE_URL is required for the restricted L3 RLS session");
}

describe("L3 RLS isolation (integration)", () => {
  const ACTOR_A = randomUUID();
  const ACTOR_B = randomUUID();
  const WORD_ID = randomUUID();
  const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
  const ORIGINAL_POOL_MAX = process.env.DB_POOL_MAX;
  const adminPool = new Pool({ connectionString: adminDatabaseUrl, max: 1 });

  /** 在指定 actor 的 RLS 事务里构造 repository（生产同款：factory(tx) 注入 tx client）。 */
  async function inTx<T>(actorId: string, fn: (repo: L3ContextRepository, tx: PoolClient) => Promise<T>): Promise<T> {
    return withTransaction(async (tx) => fn(new L3ContextRepository(tx), tx), { actorId });
  }

  /** 三件套输入（A/B 共用形状，title/hash 区分）。 */
  function trioInputs(userId: string) {
    return {
      source: {
        user_id: userId,
        wordbook_id: null,
        source_type: "article" as const,
        title: `RLS test ${userId.slice(0, 8)}`,
        author: null,
        url: null,
        language: "en",
        metadata: {},
        content_text: "The enduring lesson stayed with the reader across many seasons.",
        content_hash: null,
      },
      context: {
        user_id: userId,
        source_id: "",
        context_type: "sentence" as const,
        text: "The enduring lesson stayed with the reader.",
        normalized_text: null,
        language: "en",
        position: { start: 0, end: 44 },
        metadata: {},
      },
      occurrence: {
        user_id: userId,
        context_id: "",
        word_id: WORD_ID,
        surface: "enduring",
        lemma: "enduring",
        start_offset: 4,
        end_offset: 12,
        confidence: null,
        evidence: { via: "l3_rls_integration_test" },
        bound_sense: "持久的（测试绑定释义）" as string | null,
      },
    };
  }

  beforeAll(async () => {
    // 用户 + profile（l3_sources.user_id FK → profiles）
    await adminPool.query(
      `INSERT INTO users (id, email) VALUES ($1, $2), ($3, $4)`,
      [
        ACTOR_A, `l3-rls-a-${ACTOR_A.slice(0, 8)}@example.test`,
        ACTOR_B, `l3-rls-b-${ACTOR_B.slice(0, 8)}@example.test`,
      ],
    );
    await adminPool.query(
      `INSERT INTO profiles (id, email) VALUES ($1, $2), ($3, $4)`,
      [
        ACTOR_A, `l3-rls-a-${ACTOR_A.slice(0, 8)}@example.test`,
        ACTOR_B, `l3-rls-b-${ACTOR_B.slice(0, 8)}@example.test`,
      ],
    );
    // 目标词（l3_occurrences.word_id FK → words）；content_hash 受 64 位 sha256 CHECK 约束。
    // 0023 起触发器强制仅 stub（definition_md=''）可删——fixture 播种为 stub 形态
    // （与 capture-first 采集语义一致），afterAll 的 admin 清理才能通过触发器。
    const contentHash = createHash("sha256").update(WORD_ID).digest("hex");
    await adminPool.query(
      `INSERT INTO words (id, slug, title, lemma, definition_md, body_md, content_hash, source_path)
       VALUES ($1, $2, 'enduring', 'enduring', '', '', $3, 'test/l3-rls')`,
      [WORD_ID, `l3rls-${WORD_ID.slice(0, 8)}`, contentHash],
    );

    // 切换到受限应用角色：表属主 vocab_migration，vocab_app 非属主 → RLS 强制
    await resetPool();
    process.env.DATABASE_URL = appDatabaseUrl!;
    process.env.DB_POOL_MAX = "1";
  });

  afterAll(async () => {
    try {
      // 逐条执行清理
      await adminPool.query("DELETE FROM l3_occurrences WHERE user_id = ANY($1::uuid[])", [[ACTOR_A, ACTOR_B]]);
      await adminPool.query("DELETE FROM l3_context_links WHERE user_id = ANY($1::uuid[])", [[ACTOR_A, ACTOR_B]]);
      await adminPool.query("DELETE FROM l3_contexts WHERE user_id = ANY($1::uuid[])", [[ACTOR_A, ACTOR_B]]);
      await adminPool.query("DELETE FROM l3_sources WHERE user_id = ANY($1::uuid[])", [[ACTOR_A, ACTOR_B]]);
      // 0036 批次三①：评卷结果（sheet/question 删除已级联，这里兜底显式清理）
      await adminPool.query("DELETE FROM l3_grading_results WHERE user_id = ANY($1::uuid[])", [[ACTOR_A, ACTOR_B]]);
      // 0035 批次二增补：评析区（题删除已级联，这里兜底显式清理）
      await adminPool.query("DELETE FROM l3_question_assessments WHERE user_id = ANY($1::uuid[])", [[ACTOR_A, ACTOR_B]]);
      // 0034 批次二：作答历史/题纸（attempts 无级联到题纸，先删 attempts 再删 submissions）
      await adminPool.query("DELETE FROM l3_question_attempts WHERE user_id = ANY($1::uuid[])", [[ACTOR_A, ACTOR_B]]);
      await adminPool.query("DELETE FROM l3_submissions WHERE user_id = ANY($1::uuid[])", [[ACTOR_A, ACTOR_B]]);
      // 0033 批次一：做题注记/标签字典（题删除已级联注记，这里兜底显式清理）
      await adminPool.query("DELETE FROM l3_question_annotations WHERE user_id = ANY($1::uuid[])", [[ACTOR_A, ACTOR_B]]);
      await adminPool.query("DELETE FROM l3_annotation_tags WHERE user_id = ANY($1::uuid[])", [[ACTOR_A, ACTOR_B]]);
      await adminPool.query("DELETE FROM l3_questions WHERE user_id = ANY($1::uuid[])", [[ACTOR_A, ACTOR_B]]);
      await adminPool.query("DELETE FROM words WHERE id = $1", [WORD_ID]);
      await adminPool.query("DELETE FROM profiles WHERE id = ANY($1::uuid[])", [[ACTOR_A, ACTOR_B]]);
      await adminPool.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [[ACTOR_A, ACTOR_B]]);
    } finally {
      await resetPool();
      await adminPool.end();
      if (ORIGINAL_DATABASE_URL === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
      if (ORIGINAL_POOL_MAX === undefined) delete process.env.DB_POOL_MAX;
      else process.env.DB_POOL_MAX = ORIGINAL_POOL_MAX;
    }
  });

  it("actor A writes its own trio with bound_sense (RLS WITH CHECK passes for the owner)", async () => {
    const input = trioInputs(ACTOR_A);
    const { source, context, occurrence } = await inTx(ACTOR_A, async (repo) => {
      const source = await repo.createSource(input.source);
      const context = await repo.createContext({ ...input.context, source_id: source.id });
      const occurrence = await repo.createOccurrence({
        ...input.occurrence,
        context_id: context.id,
      });
      return { source, context, occurrence };
    });

    expect(source.user_id).toBe(ACTOR_A);
    expect(context.source_id).toBe(source.id);
    expect(occurrence.word_id).toBe(WORD_ID);
    expect(occurrence.bound_sense).toBe("持久的（测试绑定释义）");
  });

  it("actor B cannot read any of actor A's L3 rows", async () => {
    const aSource = await adminPool.query<{ id: string }>(
      "SELECT id FROM l3_sources WHERE user_id = $1", [ACTOR_A],
    ).then((r) => r.rows[0]!);
    const aContext = await adminPool.query<{ id: string }>(
      "SELECT id FROM l3_contexts WHERE user_id = $1", [ACTOR_A],
    ).then((r) => r.rows[0]!);
    expect(aSource).toBeTruthy();
    expect(aContext).toBeTruthy();

    await inTx(ACTOR_B, async (repo, tx) => {
      expect(await repo.findSourceById(ACTOR_B, aSource.id)).toBeNull();
      expect(await repo.findContextById(ACTOR_B, aContext.id)).toBeNull();
      expect(await repo.getContextDetail(ACTOR_B, aContext.id)).toBeNull();
      // words 表无 RLS（全局词典内容），B 的词空间没有任何自己的语境/occurrence
      const wordSpace = await repo.getWordSpace({ userId: ACTOR_B, slug: `l3rls-${WORD_ID.slice(0, 8)}`, limit: 10, cursor: null });
      if (wordSpace) {
        expect(wordSpace.contexts).toHaveLength(0);
        expect(wordSpace.occurrences).toHaveLength(0);
      }
      const counts = await tx.query<{ sources: number; contexts: number; occurrences: number; links: number }>(
        `SELECT
           (SELECT count(*)::int FROM l3_sources) AS sources,
           (SELECT count(*)::int FROM l3_contexts) AS contexts,
           (SELECT count(*)::int FROM l3_occurrences) AS occurrences,
           (SELECT count(*)::int FROM l3_context_links) AS links`,
      );
      expect(counts.rows[0]).toEqual({ sources: 0, contexts: 0, occurrences: 0, links: 0 });
    });
  });

  it("actor B mutations on actor A's rows are no-ops", async () => {
    const occ = await adminPool.query<{ id: string; context_id: string }>(
      "SELECT id, context_id FROM l3_occurrences WHERE user_id = $1", [ACTOR_A],
    ).then((r) => r.rows[0]!);
    const src = await adminPool.query<{ id: string }>(
      "SELECT id FROM l3_sources WHERE user_id = $1", [ACTOR_A],
    ).then((r) => r.rows[0]!);

    await inTx(ACTOR_B, async (repo) => {
      expect(await repo.deleteOccurrence(ACTOR_B, occ.id)).toBeNull();
      expect(await repo.deleteSource(ACTOR_B, src.id)).toBeNull();
    });

    const still = await adminPool.query<{ occurrences: number; sources: number }>(
      `SELECT
         (SELECT count(*)::int FROM l3_occurrences WHERE user_id = $1) AS occurrences,
         (SELECT count(*)::int FROM l3_sources WHERE user_id = $1) AS sources`,
      [ACTOR_A],
    );
    expect(still.rows[0]).toEqual({ occurrences: 1, sources: 1 });
  });

  it("rejects actor B inserting a row attributed to actor A (RLS WITH CHECK)", async () => {
    await expect(inTx(ACTOR_B, async (_repo, tx) => {
      await tx.query(
        `INSERT INTO l3_sources (id, user_id, source_type, title)
         VALUES ($1, $2, 'article', 'spoofed owner')`,
        [randomUUID(), ACTOR_A],
      );
    })).rejects.toThrow(/row-level security/i);
  });

  it("keeps two actors mutually invisible while each owns a trio", async () => {
    // B 建自己的三件套
    const bInput = trioInputs(ACTOR_B);
    const bIds = await inTx(ACTOR_B, async (repo) => {
      const source = await repo.createSource(bInput.source);
      const context = await repo.createContext({ ...bInput.context, source_id: source.id });
      await repo.createOccurrence({ ...bInput.occurrence, context_id: context.id, bound_sense: null });
      return { sourceId: source.id, contextId: context.id };
    });

    // 各自视角：只看到自己的 1 来源/1 语境/1 occurrence
    for (const actor of [ACTOR_A, ACTOR_B]) {
      await inTx(actor, async (repo, tx) => {
        const counts = await tx.query<{ sources: number; contexts: number; occurrences: number }>(
          `SELECT
             (SELECT count(*)::int FROM l3_sources) AS sources,
             (SELECT count(*)::int FROM l3_contexts) AS contexts,
             (SELECT count(*)::int FROM l3_occurrences) AS occurrences`,
        );
        expect(counts.rows[0]).toEqual({ sources: 1, contexts: 1, occurrences: 1 });
      });
    }

    // A 看不到 B 的 source
    await inTx(ACTOR_A, async (repo) => {
      expect(await repo.findSourceById(ACTOR_A, bIds.sourceId)).toBeNull();
      expect(await repo.findContextById(ACTOR_A, bIds.contextId)).toBeNull();
    });
  });

  it("deletes cascade within the owner scope (context → occurrences, then source)", async () => {
    const rows = await adminPool.query<{ user_id: string; id: string }>(
      "SELECT user_id, id FROM l3_sources ORDER BY user_id",
    ).then((r) => r.rows);
    expect(rows).toHaveLength(2);

    for (const row of rows) {
      await inTx(row.user_id, async (repo) => {
        const contexts = await adminPool.query<{ id: string }>(
          "SELECT id FROM l3_contexts WHERE user_id = $1 AND source_id = $2", [row.user_id, row.id],
        ).then((r) => r.rows);
        for (const ctx of contexts) {
          const deleted = await repo.deleteContext(row.user_id, ctx.id);
          expect(deleted).toBeTruthy();
        }
        const source = await repo.deleteSource(row.user_id, row.id);
        expect(source).toBeTruthy();
      });
    }

    const remaining = await adminPool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM l3_sources",
    );
    expect(remaining.rows[0]!.count).toBe(0);
  });

  // ── 0033 批次一：做题注记（原文分析条目）与规律标签字典的行级隔离 ──
  let aQuestionId = "";

  it("actor A attaches anchored/loose annotations and tag-dict rows to its question", async () => {
    aQuestionId = randomUUID();
    // file_key 题组（无 source 也满足 l3_questions 的身份 CHECK）
    await adminPool.query(
      `INSERT INTO l3_questions (id, user_id, file_key, space, question_type, stem)
       VALUES ($1, $2, $3, '阅读', 'reading_choice', 'RLS fixture question')`,
      [aQuestionId, ACTOR_A, `rls-file-${aQuestionId.slice(0, 8)}`],
    );

    await inTx(ACTOR_A, async (_repo, tx) => {
      await tx.query(
        `INSERT INTO l3_question_annotations
           (id, user_id, question_id, ordinal, anchor_start, anchor_end, excerpt, note, entry_tags, option_tags)
         VALUES ($1, $2, $3, 0, 12, 20, $4, 'evidence anchors the trap', $5::jsonb, $6::jsonb)`,
        [randomUUID(), ACTOR_A, aQuestionId, "trap phrase",
          JSON.stringify(["推断题"]), JSON.stringify({ B: ["偷换概念"] })],
      );
      await tx.query(
        `INSERT INTO l3_question_annotations (id, user_id, question_id, ordinal, note)
         VALUES ($1, $2, $3, 1, '题型归因，无锚点')`,
        [randomUUID(), ACTOR_A, aQuestionId],
      );
      await tx.query(
        `INSERT INTO l3_annotation_tags (id, user_id, kind, label, ordinal)
         VALUES ($1, $2, 'entry', '细节题', 0), ($3, $4, 'option', '无中生有', 0)`,
        [randomUUID(), ACTOR_A, randomUUID(), ACTOR_A],
      );
      const counts = await tx.query<{ annotations: number; tags: number }>(
        `SELECT
           (SELECT count(*)::int FROM l3_question_annotations) AS annotations,
           (SELECT count(*)::int FROM l3_annotation_tags) AS tags`,
      );
      expect(counts.rows[0]).toEqual({ annotations: 2, tags: 2 });
    });
  });

  it("actor B cannot read actor A's annotations or tags", async () => {
    await inTx(ACTOR_B, async (_repo, tx) => {
      const counts = await tx.query<{ annotations: number; tags: number }>(
        `SELECT
           (SELECT count(*)::int FROM l3_question_annotations) AS annotations,
           (SELECT count(*)::int FROM l3_annotation_tags) AS tags`,
      );
      expect(counts.rows[0]).toEqual({ annotations: 0, tags: 0 });
      const onQuestion = await tx.query(
        "SELECT id FROM l3_question_annotations WHERE question_id = $1",
        [aQuestionId],
      );
      expect(onQuestion.rows).toHaveLength(0);
    });
  });

  it("rejects actor B inserting annotations/tags attributed to actor A (RLS WITH CHECK)", async () => {
    await expect(inTx(ACTOR_B, async (_repo, tx) => {
      await tx.query(
        `INSERT INTO l3_question_annotations (id, user_id, question_id, note)
         VALUES ($1, $2, $3, 'spoofed owner annotation')`,
        [randomUUID(), ACTOR_A, aQuestionId],
      );
    })).rejects.toThrow(/row-level security/i);
    await expect(inTx(ACTOR_B, async (_repo, tx) => {
      await tx.query(
        `INSERT INTO l3_annotation_tags (id, user_id, kind, label)
         VALUES ($1, $2, 'entry', 'spoofed owner tag')`,
        [randomUUID(), ACTOR_A],
      );
    })).rejects.toThrow(/row-level security/i);
  });

  it("actor B update/soft-delete against actor A's annotations are no-ops", async () => {
    const before = await adminPool.query<{ note: string; status: string }>(
      "SELECT note, status FROM l3_question_annotations WHERE question_id = $1 ORDER BY ordinal",
      [aQuestionId],
    ).then((r) => r.rows);

    await inTx(ACTOR_B, async (_repo, tx) => {
      const updated = await tx.query(
        `UPDATE l3_question_annotations SET note = 'hijacked', updated_at = now()
         WHERE question_id = $1 RETURNING id`,
        [aQuestionId],
      );
      expect(updated.rows).toHaveLength(0);
      const softDeleted = await tx.query(
        "UPDATE l3_question_annotations SET status = 'deleted' WHERE question_id = $1 RETURNING id",
        [aQuestionId],
      );
      expect(softDeleted.rows).toHaveLength(0);
    });

    const after = await adminPool.query<{ note: string; status: string }>(
      "SELECT note, status FROM l3_question_annotations WHERE question_id = $1 ORDER BY ordinal",
      [aQuestionId],
    ).then((r) => r.rows);
    expect(after).toEqual(before);
  });

  it("cascades annotations when actor A deletes its question through the vocab_app path", async () => {
    await inTx(ACTOR_A, async (_repo, tx) => {
      const deleted = await tx.query(
        "DELETE FROM l3_questions WHERE id = $1 RETURNING id",
        [aQuestionId],
      );
      expect(deleted.rows).toHaveLength(1);
    });
    const remaining = await adminPool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM l3_question_annotations WHERE question_id = $1",
      [aQuestionId],
    );
    expect(remaining.rows[0]!.count).toBe(0);
  });

  // ── 0034 批次二：题纸（l3_submissions）/ 作答历史（l3_question_attempts）/
  //    草稿注记（stage/sheet_id）的行级隔离与状态守卫 ──
  let aSheetId = "";
  let aSheetSourceId = "";
  let aSheetQuestionId = "";
  let aAttemptId = "";
  let aDraftAnnotationId = "";

  it("actor A opens a sheet, writes a draft note and seals it into attempts (vocab_app path)", async () => {
    aSheetSourceId = randomUUID();
    await adminPool.query(
      `INSERT INTO l3_sources (id, user_id, source_type, title)
       VALUES ($1, $2, 'article', 'RLS sheet source')`,
      [aSheetSourceId, ACTOR_A],
    );
    aSheetQuestionId = randomUUID();
    await adminPool.query(
      `INSERT INTO l3_questions (id, user_id, source_id, space, question_type, stem)
       VALUES ($1, $2, $3, '阅读', 'reading_choice', 'RLS sheet question')`,
      [aSheetQuestionId, ACTOR_A, aSheetSourceId],
    );

    aSheetId = randomUUID();
    aAttemptId = randomUUID();
    aDraftAnnotationId = randomUUID();
    await inTx(ACTOR_A, async (_repo, tx) => {
      // 开纸（draft，answers 在写）
      await tx.query(
        `INSERT INTO l3_submissions
           (id, user_id, scope, scope_key, source_id, question_type, status, answers)
         VALUES ($1, $2, 'file', $3, $4, 'reading_choice', 'draft', $5::jsonb)`,
        [aSheetId, ACTOR_A, `file:${aSheetSourceId}:reading_choice`, aSheetSourceId,
          JSON.stringify({ [aSheetQuestionId]: { choice: "B" } })],
      );
      // 草稿注记挂题纸（stage='draft'）
      await tx.query(
        `INSERT INTO l3_question_annotations (id, user_id, question_id, note, stage, sheet_id)
         VALUES ($1, $2, $3, 'draft judgement', 'draft', $4)`,
        [aDraftAnnotationId, ACTOR_A, aSheetQuestionId, aSheetId],
      );
      // 定格：物化 attempt → 注记升格 → sheet sealed + answers 清空
      await tx.query(
        `INSERT INTO l3_question_attempts (id, user_id, question_id, sheet_id, venue, answer)
         VALUES ($1, $2, $3, $4, 'file', $5::jsonb)`,
        [aAttemptId, ACTOR_A, aSheetQuestionId, aSheetId, JSON.stringify({ choice: "B" })],
      );
      const promoted = await tx.query(
        `UPDATE l3_question_annotations SET stage = 'submitted', updated_at = now()
         WHERE sheet_id = $1 AND stage = 'draft' AND status = 'active' RETURNING id`,
        [aSheetId],
      );
      expect(promoted.rows).toHaveLength(1);
      const sealed = await tx.query(
        `UPDATE l3_submissions SET status = 'sealed', seal_mode = 'full', sealed_at = now(),
           answers = '{}'::jsonb, updated_at = now()
         WHERE id = $1 AND status = 'draft' RETURNING id`,
        [aSheetId],
      );
      expect(sealed.rows).toHaveLength(1);
    });

    const sheet = await adminPool.query<{ status: string; answers: unknown }>(
      "SELECT status, answers FROM l3_submissions WHERE id = $1", [aSheetId],
    );
    expect(sheet.rows[0]!.status).toBe("sealed");
    expect(sheet.rows[0]!.answers).toEqual({});
    const attempt = await adminPool.query<{ answer: unknown }>(
      "SELECT answer FROM l3_question_attempts WHERE id = $1", [aAttemptId],
    );
    expect(attempt.rows[0]!.answer).toEqual({ choice: "B" });
    const promotedStage = await adminPool.query<{ stage: string }>(
      "SELECT stage FROM l3_question_annotations WHERE id = $1", [aDraftAnnotationId],
    );
    expect(promotedStage.rows[0]!.stage).toBe("submitted");
  });

  it("actor B cannot read actor A's sheet, attempts or sheet-scoped notes", async () => {
    await inTx(ACTOR_B, async (_repo, tx) => {
      const counts = await tx.query<{ sheets: number; attempts: number }>(
        `SELECT
           (SELECT count(*)::int FROM l3_submissions) AS sheets,
           (SELECT count(*)::int FROM l3_question_attempts) AS attempts`,
      );
      expect(counts.rows[0]).toEqual({ sheets: 0, attempts: 0 });
      const bySheet = await tx.query(
        "SELECT id FROM l3_submissions WHERE id = $1", [aSheetId],
      );
      expect(bySheet.rows).toHaveLength(0);
    });
  });

  it("actor B mutations on actor A's sheet/attempts are no-ops", async () => {
    await inTx(ACTOR_B, async (_repo, tx) => {
      const patched = await tx.query(
        `UPDATE l3_submissions SET answers = '{"hijack": true}'::jsonb, updated_at = now()
         WHERE id = $1 AND status = 'draft' RETURNING id`,
        [aSheetId],
      );
      expect(patched.rows).toHaveLength(0);
      const softDeleted = await tx.query(
        `UPDATE l3_question_attempts SET status = 'deleted', deleted_at = now()
         WHERE id = $1 RETURNING id`,
        [aAttemptId],
      );
      expect(softDeleted.rows).toHaveLength(0);
    });
    const still = await adminPool.query<{ status: string }>(
      "SELECT status FROM l3_question_attempts WHERE id = $1", [aAttemptId],
    );
    expect(still.rows[0]!.status).toBe("active");
  });

  it("rejects actor B inserting sheets/attempts attributed to actor A (RLS WITH CHECK)", async () => {
    await expect(inTx(ACTOR_B, async (_repo, tx) => {
      await tx.query(
        `INSERT INTO l3_submissions (id, user_id, scope, scope_key, source_id, question_type)
         VALUES ($1, $2, 'file', $3, $4, 'reading_choice')`,
        [randomUUID(), ACTOR_A, `file:${aSheetSourceId}:reading_choice`, aSheetSourceId],
      );
    })).rejects.toThrow(/row-level security/i);
    await expect(inTx(ACTOR_B, async (_repo, tx) => {
      await tx.query(
        `INSERT INTO l3_question_attempts (id, user_id, question_id, venue, answer)
         VALUES ($1, $2, $3, 'file', '{}'::jsonb)`,
        [randomUUID(), ACTOR_A, aSheetQuestionId],
      );
    })).rejects.toThrow(/row-level security/i);
  });

  it("keeps the sealed sheet read-only: answers updates behind the draft predicate are no-ops", async () => {
    await inTx(ACTOR_A, async (_repo, tx) => {
      const updated = await tx.query(
        `UPDATE l3_submissions SET answers = '{"late": true}'::jsonb, updated_at = now()
         WHERE id = $1 AND status = 'draft' RETURNING id`,
        [aSheetId],
      );
      expect(updated.rows).toHaveLength(0);
    });
    const answers = await adminPool.query<{ answers: unknown }>(
      "SELECT answers FROM l3_submissions WHERE id = $1", [aSheetId],
    );
    expect(answers.rows[0]!.answers).toEqual({});
  });

  // ── 0035 批次二增补：评析区（一题一条 upsert）的行级隔离 ──
  let aAssessSourceId = "";
  let aAssessQuestionId = "";

  it("actor A upserts a question assessment via vocab_app (ON CONFLICT path)", async () => {
    aAssessSourceId = randomUUID();
    await adminPool.query(
      `INSERT INTO l3_sources (id, user_id, source_type, title)
       VALUES ($1, $2, 'article', 'RLS assessment source')`,
      [aAssessSourceId, ACTOR_A],
    );
    aAssessQuestionId = randomUUID();
    await adminPool.query(
      `INSERT INTO l3_questions (id, user_id, source_id, space, question_type, stem)
       VALUES ($1, $2, $3, '阅读', 'reading_choice', 'RLS assessment question')`,
      [aAssessQuestionId, ACTOR_A, aAssessSourceId],
    );
    await inTx(ACTOR_A, async (_repo, tx) => {
      await tx.query(
        `INSERT INTO l3_question_assessments (id, user_id, question_id, content_md, last_editor)
         VALUES ($1, $2, $3, 'owner 首写', 'owner')
         ON CONFLICT (user_id, question_id)
         DO UPDATE SET content_md = EXCLUDED.content_md, last_editor = EXCLUDED.last_editor, updated_at = now()`,
        [randomUUID(), ACTOR_A, aAssessQuestionId],
      );
      // 覆盖写（latest-wins；last_editor 留痕）
      await tx.query(
        `INSERT INTO l3_question_assessments (id, user_id, question_id, content_md, last_editor)
         VALUES ($1, $2, $3, 'agent 覆写', 'agent')
         ON CONFLICT (user_id, question_id)
         DO UPDATE SET content_md = EXCLUDED.content_md, last_editor = EXCLUDED.last_editor, updated_at = now()`,
        [randomUUID(), ACTOR_A, aAssessQuestionId],
      );
    });
    const rows = await adminPool.query<{ content_md: string; last_editor: string }>(
      "SELECT content_md, last_editor FROM l3_question_assessments WHERE question_id = $1",
      [aAssessQuestionId],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toEqual({ content_md: "agent 覆写", last_editor: "agent" });
  });

  it("actor B cannot read or mutate actor A's assessment", async () => {
    await inTx(ACTOR_B, async (_repo, tx) => {
      const read = await tx.query(
        "SELECT id FROM l3_question_assessments WHERE question_id = $1", [aAssessQuestionId],
      );
      expect(read.rows).toHaveLength(0);
      const patched = await tx.query(
        "UPDATE l3_question_assessments SET content_md = 'hijack' WHERE question_id = $1 RETURNING id",
        [aAssessQuestionId],
      );
      expect(patched.rows).toHaveLength(0);
    });
    const still = await adminPool.query<{ content_md: string }>(
      "SELECT content_md FROM l3_question_assessments WHERE question_id = $1", [aAssessQuestionId],
    );
    expect(still.rows[0]!.content_md).toBe("agent 覆写");
  });

  it("rejects actor B inserting an assessment attributed to actor A (RLS WITH CHECK)", async () => {
    await expect(inTx(ACTOR_B, async (_repo, tx) => {
      await tx.query(
        `INSERT INTO l3_question_assessments (id, user_id, question_id, content_md, last_editor)
         VALUES ($1, $2, $3, '越权', 'agent')`,
        [randomUUID(), ACTOR_A, aAssessQuestionId],
      );
    })).rejects.toThrow(/row-level security/i);
  });

  // ── 0036 批次三①：评卷结果（l3_grading_results）/ review 白名单写入的行级隔离 ──

  it("actor A upserts grading results with latest-wins overwrite (vocab_app path)", async () => {
    await inTx(ACTOR_A, async (_repo, tx) => {
      await tx.query(
        `INSERT INTO l3_grading_results (id, user_id, sheet_id, question_id, verdict, analysis_md, graded_by)
         VALUES ($1, $2, $3, $4, 'wrong', '定位偏移。', 'agent-a')
         ON CONFLICT (sheet_id, question_id)
         DO UPDATE SET verdict = EXCLUDED.verdict, analysis_md = EXCLUDED.analysis_md,
                       graded_by = EXCLUDED.graded_by, graded_at = now()`,
        [randomUUID(), ACTOR_A, aSheetId, aSheetQuestionId],
      );
      // 改判覆写（同键 latest-wins；无历史版本）。
      await tx.query(
        `INSERT INTO l3_grading_results (id, user_id, sheet_id, question_id, verdict, analysis_md, graded_by)
         VALUES ($1, $2, $3, $4, 'partial', '再看是部分对。', 'agent-b')
         ON CONFLICT (sheet_id, question_id)
         DO UPDATE SET verdict = EXCLUDED.verdict, analysis_md = EXCLUDED.analysis_md,
                       graded_by = EXCLUDED.graded_by, graded_at = now()`,
        [randomUUID(), ACTOR_A, aSheetId, aSheetQuestionId],
      );
    });
    const rows = await adminPool.query<{ verdict: string; graded_by: string }>(
      "SELECT verdict, graded_by FROM l3_grading_results WHERE sheet_id = $1 AND question_id = $2",
      [aSheetId, aSheetQuestionId],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toEqual({ verdict: "partial", graded_by: "agent-b" });
  });

  it("actor B cannot read or mutate actor A's grading rows", async () => {
    await inTx(ACTOR_B, async (_repo, tx) => {
      const read = await tx.query("SELECT id FROM l3_grading_results WHERE sheet_id = $1", [aSheetId]);
      expect(read.rows).toHaveLength(0);
      const updated = await tx.query(
        "UPDATE l3_grading_results SET verdict = 'correct' WHERE sheet_id = $1 RETURNING id",
        [aSheetId],
      );
      expect(updated.rows).toHaveLength(0);
    });
    const still = await adminPool.query<{ verdict: string }>(
      "SELECT verdict FROM l3_grading_results WHERE sheet_id = $1",
      [aSheetId],
    );
    expect(still.rows[0]!.verdict).toBe("partial");
  });

  it("rejects actor B inserting a grading row attributed to actor A (RLS WITH CHECK)", async () => {
    await expect(inTx(ACTOR_B, async (_repo, tx) => {
      await tx.query(
        `INSERT INTO l3_grading_results (id, user_id, sheet_id, question_id, verdict, graded_by)
         VALUES ($1, $2, $3, $4, 'correct', 'agent-b')`,
        [randomUUID(), ACTOR_A, aSheetId, aSheetQuestionId],
      );
    })).rejects.toThrow(/row-level security/i);
  });

  it("review white-list write flips submitted→confirmed without touching the note", async () => {
    const before = await adminPool.query<{ note: string; excerpt: string; entry_tags: unknown; stage: string }>(
      "SELECT note, excerpt, entry_tags, stage FROM l3_question_annotations WHERE id = $1",
      [aDraftAnnotationId],
    ).then((r) => r.rows[0]!);
    expect(before.stage).toBe("submitted");

    await inTx(ACTOR_A, async (_repo, tx) => {
      // 与 L3AnnotationRepository.applyAnnotationReview 同款白名单 SQL（SET 只触 review/stage）。
      await tx.query(
        `UPDATE l3_question_annotations
            SET review = $2::jsonb, stage = $3, updated_at = now()
          WHERE user_id = $1::uuid AND id = $4::uuid
            AND status = 'active' AND stage <> 'draft'`,
        [ACTOR_A, JSON.stringify({ verdict: "sound", comment: "锚点准确" }), "confirmed", aDraftAnnotationId],
      );
    });

    const after = await adminPool.query<{ note: string; excerpt: string; entry_tags: unknown; stage: string; review: unknown }>(
      "SELECT note, excerpt, entry_tags, stage, review FROM l3_question_annotations WHERE id = $1",
      [aDraftAnnotationId],
    ).then((r) => r.rows[0]!);
    expect(after.stage).toBe("confirmed");
    expect(after.review).toEqual({ verdict: "sound", comment: "锚点准确" });
    // 白名单红线：note / excerpt / entry_tags 一字不动（不可篡改性由 SQL 形态保证）。
    expect(after.note).toBe(before.note);
    expect(after.excerpt).toBe(before.excerpt);
    expect(after.entry_tags).toEqual(before.entry_tags);

    // actor B 对同一行执行白名单 SQL → RLS 空转，review 不被劫持。
    await inTx(ACTOR_B, async (_repo, tx) => {
      const hijacked = await tx.query(
        `UPDATE l3_question_annotations
            SET review = '{"verdict":"wrong"}'::jsonb, stage = 'draft', updated_at = now()
          WHERE id = $1 RETURNING id`,
        [aDraftAnnotationId],
      );
      expect(hijacked.rows).toHaveLength(0);
    });
    const untouched = await adminPool.query<{ review: unknown }>(
      "SELECT review FROM l3_question_annotations WHERE id = $1",
      [aDraftAnnotationId],
    );
    expect(untouched.rows[0]!.review).toEqual({ verdict: "sound", comment: "锚点准确" });
  });
});
