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
 * 冒名插入被 RLS 拒绝、双用户互不可见、删除级联 + bound_sense 落库。
 */

import { createHash, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { L3ContextRepository } from "@/repositories/l3-context.repository";
import { resetPool } from "@/db/connection";
import { withTransaction } from "@/db/transaction";

const adminDatabaseUrl = process.env.TEST_DATABASE_URL;
const appDatabaseUrl = process.env.TEST_APP_DATABASE_URL;

if (!adminDatabaseUrl || !appDatabaseUrl) {
  console.log("SKIP tests/l3-rls.integration.test.ts — 需要 TEST_DATABASE_URL 与 TEST_APP_DATABASE_URL");
}
describe.skipIf(!adminDatabaseUrl || !appDatabaseUrl)("L3 RLS isolation (integration)", () => {
  const ACTOR_A = randomUUID();
  const ACTOR_B = randomUUID();
  const WORD_ID = randomUUID();
  const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
  const ORIGINAL_POOL_MAX = process.env.DB_POOL_MAX;
  const adminPool = new Pool({ connectionString: adminDatabaseUrl!, max: 1 });

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
    // 目标词（l3_occurrences.word_id FK → words）；content_hash 受 64 位 sha256 CHECK 约束
    const contentHash = createHash("sha256").update(WORD_ID).digest("hex");
    await adminPool.query(
      `INSERT INTO words (id, slug, title, lemma, definition_md, body_md, content_hash, source_path)
       VALUES ($1, $2, 'enduring', 'enduring', 'def', 'body', $3, 'test/l3-rls')`,
      [WORD_ID, `l3rls-${WORD_ID.slice(0, 8)}`, contentHash],
    );

    // 切换到受限应用角色：表属主 vocab_migration，vocab_app 非属主 → RLS 强制
    await resetPool();
    process.env.DATABASE_URL = appDatabaseUrl!;
    process.env.DB_POOL_MAX = "1";
  });

  afterAll(async () => {
    try {
      // pg 扩展协议不允许带参多语句——逐条执行清理
      await adminPool.query("DELETE FROM l3_occurrences WHERE user_id = ANY($1::uuid[])", [[ACTOR_A, ACTOR_B]]);
      await adminPool.query("DELETE FROM l3_context_links WHERE user_id = ANY($1::uuid[])", [[ACTOR_A, ACTOR_B]]);
      await adminPool.query("DELETE FROM l3_contexts WHERE user_id = ANY($1::uuid[])", [[ACTOR_A, ACTOR_B]]);
      await adminPool.query("DELETE FROM l3_sources WHERE user_id = ANY($1::uuid[])", [[ACTOR_A, ACTOR_B]]);
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
});
