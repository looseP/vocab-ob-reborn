/**
 * 错题库统一投影 · **真实 PostgreSQL** 参数编号回归测试（2026-09-28）。
 *
 * 为什么需要这个文件：`tests/repositories/l3-error-book.test.ts` 全部 mock 掉
 * `query` / `queryOne`，只断言 SQL **文本**包含什么，从不让 PostgreSQL 真正解析它。
 * 于是两处参数编号缺陷在单测层面完全不可见，直到生产 500 才暴露：
 *
 *   缺陷 1（`there is no parameter $1`）：count 查询传 `[]`，而腿内 SQL 含 $1..$N。
 *   缺陷 2（静默错数据，更危险）：rows 查询的 `LIMIT $1 OFFSET $2` 与腿内
 *          `$1(userId)` / `$2(space)` / `$3(direction)` **撞号**。撞号不报错——
 *          PostgreSQL 把它当类型错误抛出，或把 userId 当 limit 静默返回错页。
 *
 * 本测试的口径：**mock 零层**，真实 client 发 SQL，让数据库当裁判。
 * 断言「SQL 能被真实解析且参数按序绑定」，而不是「SQL 文本长什么样」。
 *
 * 隔离纪律（沿 `l3-study-note-export.integration.test.ts`）：
 *  - 只在显式指定的验收库运行，`TEST_DATABASE_URL` 缺失即失败——**不 skip**；
 *  - fixture owner 为随机 UUID，清理限定本文件记录，**不 truncate 业务表**；
 *  - 顺带锁住纯读纪律：错题库是派生视图，全程无 INSERT/UPDATE/DELETE。
 *
 * 运行：
 *   TEST_DATABASE_URL=postgresql://vocab_migration:...@host:5432/<accept_db>
 *   TEST_APP_DATABASE_URL=postgresql://vocab_app:...@host:5432/<accept_db>
 *   npx --no-install vitest run --config vitest.integration.config.ts \
 *     tests/l3-error-book-params.integration.test.ts --maxWorkers=1
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { L3ErrorBookRepository } from "@/repositories/l3-error-book.repository";
import type { L3ErrorBookLookup } from "@/repositories/interfaces";

const adminUrl = process.env.TEST_DATABASE_URL;
if (!adminUrl) {
  throw new Error(
    "TEST_DATABASE_URL is required — this suite must run against a real PostgreSQL acceptance database (no skip).",
  );
}

const OWNER = randomUUID();
const SOURCE = randomUUID();
const CONTEXT = randomUUID();
const QUESTION = randomUUID();
const SESSION = randomUUID();
const SHEET = randomUUID();

const client = new Client({ connectionString: adminUrl });
const repo = new L3ErrorBookRepository();

/** 逐条记录真实发出的 SQL 与参数，用于编号断言。 */
interface Captured {
  text: string;
  params: unknown[];
}
const captured: Captured[] = [];

/** SQL 里出现的最大占位符编号（0 = 无占位符）。 */
function maxPlaceholder(sql: string): number {
  const nums = [...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
  return nums.length > 0 ? Math.max(...nums) : 0;
}

beforeAll(async () => {
  await client.connect();
  (repo as never as { tx: unknown }).tx = client;

  // fixture：owner / source / context / question / 一条句级 wrong + 一条题级 partial
  // 列与默认值严格照当前 schema（列名与 NOT NULL 集合随迁移演进，写死即过期）。
  // 依赖顺序：users → profiles(id FK → users) → l3_*(user_id FK → profiles)。
  await client.query("INSERT INTO users (id, email) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING", [
    OWNER,
    `${OWNER}@example.invalid`,
  ]);
  await client.query("INSERT INTO profiles (id, email) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING", [
    OWNER,
    `${OWNER}@example.invalid`,
  ]);
  await client.query(
    "INSERT INTO l3_sources (id, user_id, title, source_type, direction) VALUES ($1, $2, $3, 'article', $4)",
    [SOURCE, OWNER, "Fixture Source", "考研"],
  );
  await client.query(
    "INSERT INTO l3_contexts (id, user_id, source_id, context_type, text) VALUES ($1, $2, $3, 'sentence', $4)",
    [CONTEXT, OWNER, SOURCE, "A sentence that contains the target term inside it."],
  );
  await client.query(
    "INSERT INTO l3_sessions (id, user_id, type, plan) VALUES ($1, $2, 'l3_practice', $3::jsonb)",
    [SESSION, OWNER, JSON.stringify({ steps: 1 })],
  );
  await client.query(
    "INSERT INTO l3_practice_attempts (id, user_id, context_id, session_id, practice_type, outcome, payload) VALUES ($1, $2, $3, $4, 'essay_dictation', 'wrong', $5::jsonb)",
    [randomUUID(), OWNER, CONTEXT, SESSION, JSON.stringify({ text: "fixture" })],
  );
  // l3_questions_identity_check：source_id 与 file_key 二选一必填
  await client.query(
    "INSERT INTO l3_questions (id, user_id, source_id, space, question_type, ordinal, stem, options, answer, evidence, status, created_by) VALUES ($1, $2::uuid, $3::uuid, $4, 'reading_choice', 1, $5, '[]'::jsonb, '{}'::jsonb, '[]'::jsonb, 'active', $6::uuid)",
    [QUESTION, OWNER, SOURCE, "阅读", "The author implies that the term is central.", OWNER],
  );
  // l3_submissions_scope_shape_check：scope='file' ⇒ source_id + question_type 必填、paper_id 必须为 NULL
  await client.query(
    "INSERT INTO l3_submissions (id, user_id, scope, scope_key, status, answers, source_id, question_type) VALUES ($1, $2::uuid, 'file', $3, 'sealed', '[]'::jsonb, $4::uuid, 'reading_choice')",
    [SHEET, OWNER, SOURCE, SOURCE],
  );
  await client.query(
    "INSERT INTO l3_grading_results (id, user_id, question_id, sheet_id, verdict, graded_by) VALUES ($1, $2::uuid, $3::uuid, $4::uuid, 'partial', $5::uuid)",
    [randomUUID(), OWNER, QUESTION, SHEET, OWNER],
  );
});

afterAll(async () => {
  // pg.Client 无公开的 connected 标志；用 try/catch 兜住「连接已断」的情况即可。
  try {
    await client.query("SELECT 1");
  } catch {
    return;
  }
  await client.query("DELETE FROM l3_grading_results WHERE user_id = $1", [OWNER]);
  await client.query("DELETE FROM l3_questions WHERE user_id = $1", [OWNER]);
  await client.query("DELETE FROM l3_practice_attempts WHERE user_id = $1", [OWNER]);
  await client.query("DELETE FROM l3_sessions WHERE user_id = $1", [OWNER]);
  await client.query("DELETE FROM l3_contexts WHERE user_id = $1", [OWNER]);
  await client.query("DELETE FROM l3_sources WHERE user_id = $1", [OWNER]);
  await client.query("DELETE FROM users WHERE id = $1", [OWNER]);
  await client.query("DELETE FROM profiles WHERE id = $1", [OWNER]);
  await client.end();
});

/** 跑一次 listUnified，并捕获它真实发出的每条 SQL。 */
async function runAndCapture(input: L3ErrorBookLookup) {
  captured.length = 0;
  const originalQuery = client.query.bind(client);
  const patched = async (text: string, params?: unknown[]) => {
    captured.push({ text, params: params ?? [] });
    return originalQuery(text as never, params as never);
  };
  (client as never as { query: unknown }).query = patched;
  try {
    const page = await repo.listUnified(input);
    return page;
  } finally {
    (client as never as { query: unknown }).query = originalQuery;
  }
}

describe("L3ErrorBookRepository.listUnified — 真实 PostgreSQL 参数编号", () => {
  it("默认两腿合并：不抛错（缺陷 1 的直接回归：count 传 [] 会报 there is no parameter $1）", async () => {
    const page = await runAndCapture({ userId: OWNER, kind: null, limit: 20, offset: 0 });
    expect(Array.isArray(page.items)).toBe(true);
    expect(page.total).toBeGreaterThanOrEqual(2); // 句级 wrong + 题级 partial
  });

  it("每条 SQL 的占位符数都 ≤ 实际传入的参数数（缺陷 1 的通用护栏）", async () => {
    await runAndCapture({ userId: OWNER, kind: null, limit: 20, offset: 0 });
    expect(captured.length).toBeGreaterThan(0);
    for (const c of captured) {
      expect(maxPlaceholder(c.text)).toBeLessThanOrEqual(c.params.length);
    }
  });

  it("分页占位符排在腿参数之后，不与 $1(userId)/$2(space)/$3(direction) 撞号（缺陷 2）", async () => {
    await runAndCapture({ userId: OWNER, kind: null, space: "阅读", direction: "考研", limit: 20, offset: 0 });
    const paged = captured.find((c) => /ORDER BY merged\.latest_at DESC/.test(c.text));
    expect(paged).toBeDefined();
    // 3 个过滤参数 ⇒ 分页必须是 $4 / $5，且 params 尾部两位是 limit/offset
    expect(paged!.text).toContain("LIMIT $4 OFFSET $5");
    expect(paged!.params.slice(0, 3)).toEqual([OWNER, "阅读", "考研"]);
    expect(paged!.params.slice(3)).toEqual([20, 0]);
  });

  it("无轴过滤时分页占位符是 $2 / $3（参数个数随过滤条件收缩，占位符同步收缩）", async () => {
    await runAndCapture({ userId: OWNER, kind: null, limit: 10, offset: 5 });
    const paged = captured.find((c) => /ORDER BY merged\.latest_at DESC/.test(c.text));
    expect(paged!.text).toContain("LIMIT $2 OFFSET $3");
    expect(paged!.params).toEqual([OWNER, 10, 5]);
  });

  it("仅句级 / 仅题级 两条腿各自可跑（单腿也要带 userId 参数）", async () => {
    const sentence = await runAndCapture({ userId: OWNER, kind: "sentence", limit: 20, offset: 0 });
    expect(sentence.items.some((i) => i.kind === "sentence")).toBe(true);
    const question = await runAndCapture({ userId: OWNER, kind: "question", limit: 20, offset: 0 });
    expect(question.items.some((i) => i.kind === "question")).toBe(true);
  });

  it("分页真的生效：offset 越过后 total 不变、items 变少", async () => {
    const first = await runAndCapture({ userId: OWNER, kind: null, limit: 1, offset: 0 });
    expect(first.items.length).toBe(1);
    const beyond = await runAndCapture({ userId: OWNER, kind: null, limit: 1, offset: 99 });
    expect(beyond.total).toBe(first.total);
    expect(beyond.items).toHaveLength(0);
  });

  it("纯读：全程无 INSERT/UPDATE/DELETE（错题库是派生视图，不建表）", async () => {
    await runAndCapture({ userId: OWNER, kind: null, limit: 20, offset: 0 });
    for (const c of captured) {
      expect(c.text).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
    }
  });
});
