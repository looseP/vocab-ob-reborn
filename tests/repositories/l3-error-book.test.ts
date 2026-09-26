/**
 * 错题库统一投影（2026-09-26）仓储测试。
 *
 * 锁死三件最容易悄悄坏掉的事：
 *  1. 两腿口径：句级 = practice_attempts.outcome='wrong'；题级 = grading_results
 *     verdict IN ('wrong','partial')——partial 也算错，correct 不进。
 *  2. 只读：不 INSERT/UPDATE/DELETE 任何表（错题库是派生视图，不建表）。
 *  3. 轴过滤各走各的权威：句级 l3_source_spaces EXISTS、题级 l3_questions.space。
 */
import { describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import { L3ErrorBookRepository } from "@/repositories/l3-error-book.repository";

const USER = "00000000-0000-4000-8000-000000000001";
const SOURCE = "00000000-0000-4000-8000-000000000302";
const CONTEXT = "00000000-0000-4000-8000-000000000501";
const ATTEMPT = "00000000-0000-4000-8000-000000000601";
const QUESTION = "00000000-0000-4000-8000-000000000101";
const GRADING = "00000000-0000-4000-8000-000000000701";
const SHEET = "00000000-0000-4000-8000-000000000401";

interface Captured {
  text: string;
  params: unknown[];
}

function makeRepo(responses: { rows?: unknown[]; total?: string } = {}) {
  const calls: Captured[] = [];
  const repo = new L3ErrorBookRepository();
  const query = vi.spyOn(repo as never as { query: (t: string, p: unknown[]) => Promise<unknown[]> }, "query")
    .mockImplementation(async (text: string, params: unknown[]) => {
      calls.push({ text, params });
      return (responses.rows ?? []) as never;
    });
  const queryOne = vi.spyOn(repo as never as { queryOne: (t: string, p: unknown[]) => Promise<unknown> }, "queryOne")
    .mockImplementation(async (text: string, params: unknown[]) => {
      calls.push({ text, params });
      return { total: responses.total ?? "0" } as never;
    });
  // 事务占位（BaseRepository 惯例：仓储不自己开事务）
  (repo as never as { tx?: PoolClient }).tx = undefined;
  return { repo, calls, query, queryOne };
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    kind: "sentence",
    record_id: ATTEMPT,
    target_id: CONTEXT,
    target_label: "The acid was neutralized by the base.",
    target_secondary: null,
    source_id: SOURCE,
    source_title: "2023 Text2",
    question_type: null,
    space: "阅读",
    direction: "考研",
    sheet_id: null,
    practice_type: "essay_dictation",
    wrong_count: 2,
    latest_outcome: "wrong",
    latest_at: "2026-09-20T00:00:00.000Z",
    created_at: "2026-09-20T00:00:00.000Z",
    ...overrides,
  };
}

describe("L3ErrorBookRepository.listUnified", () => {
  it("默认两腿合并：句级 wrong + 题级 wrong/partial 各出一段 SQL", async () => {
    const { repo, calls } = makeRepo({ rows: [row()], total: "1" });
    const page = await repo.listUnified({ userId: USER, kind: null, limit: 20, offset: 0 });

    const merged = calls.find((c) => c.text.includes("UNION ALL"));
    expect(merged).toBeDefined();
    expect(merged!.text).toContain("FROM l3_practice_attempts a");
    expect(merged!.text).toContain("FROM l3_grading_results g");
    expect(page.total).toBe(1);
    expect(page.items).toHaveLength(1);
  });

  it("句级口径：outcome='wrong'（correct/skip 不进错题库）", async () => {
    const { repo, calls } = makeRepo();
    await repo.listUnified({ userId: USER, kind: "sentence", limit: 20, offset: 0 });
    const leg = calls.find((c) => c.text.includes("l3_practice_attempts a"))!;
    expect(leg.text).toContain("a.outcome = 'wrong'");
    expect(leg.text).not.toContain("UNION ALL");
  });

  it("题级口径：verdict IN ('wrong','partial')，correct 不进", async () => {
    const { repo, calls } = makeRepo();
    await repo.listUnified({ userId: USER, kind: "question", limit: 20, offset: 0 });
    const leg = calls.find((c) => c.text.includes("l3_grading_results g"))!;
    expect(leg.text).toContain("g.verdict IN ('wrong', 'partial')");
  });

  it("纯读：全程没有 INSERT/UPDATE/DELETE", async () => {
    const { repo, calls } = makeRepo();
    await repo.listUnified({ userId: USER, kind: null, limit: 20, offset: 0 });
    for (const call of calls) {
      expect(call.text).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
    }
  });

  it("轴过滤各走各的权威：句级 source_spaces EXISTS / 题级 questions.space", async () => {
    const { repo, calls } = makeRepo();
    await repo.listUnified({ userId: USER, kind: null, space: "阅读", direction: "考研", limit: 20, offset: 0 });
    const leg = calls.find((c) => c.text.includes("l3_practice_attempts a"))!;
    expect(leg.text).toContain("EXISTS (SELECT 1 FROM l3_source_spaces sp");
    expect(leg.text).toContain("s.direction = $");

    const qLeg = calls.find((c) => c.text.includes("l3_grading_results g"))!;
    expect(qLeg.text).toContain("q.space = $");
    expect(qLeg.text).toContain("s.direction = $");
  });

  it("分页在合并之后（两腿先 UNION，再 ORDER BY + LIMIT/OFFSET）", async () => {
    const { repo, calls } = makeRepo({ rows: [row(), row()], total: "2" });
    const page = await repo.listUnified({ userId: USER, kind: null, limit: 20, offset: 20 });
    const paged = calls.find((c) => c.text.includes("ORDER BY merged.latest_at DESC"))!;
    expect(paged.text).toContain("LIMIT $1 OFFSET $2");
    expect(paged.params).toEqual([20, 20]);
    expect(page.offset).toBe(20);
  });

  it("total 与 items 口径一致（total 不含分页谓词）", async () => {
    const { repo, calls } = makeRepo({ rows: [row()], total: "7" });
    const page = await repo.listUnified({ userId: USER, kind: null, limit: 20, offset: 0 });
    const counted = calls.find((c) => c.text.startsWith("SELECT count(*)::bigint"))!;
    expect(counted.text).toContain("merged");
    expect(page.total).toBe(7);
    expect(page.items).toHaveLength(1);
  });

  it("kind 过滤到不存在的腿 → 空页（不发无意义 SQL）", async () => {
    const { repo, calls } = makeRepo();
    const page = await repo.listUnified({ userId: USER, kind: "sentence", limit: 20, offset: 0 });
    expect(calls.length).toBeGreaterThan(0);
    expect(page.total).toBe(0);
    expect(page.items).toEqual([]);
  });

  it("行映射：snake → camel，缺列补 null，wrong_count 数字化", async () => {
    const { repo } = makeRepo({
      rows: [row({ wrong_count: "3", target_secondary: null, sheet_id: null })],
      total: "1",
    });
    const page = await repo.listUnified({ userId: USER, kind: null, limit: 20, offset: 0 });
    expect(page.items[0]).toMatchObject({
      kind: "sentence",
      id: ATTEMPT,
      target_id: CONTEXT,
      wrong_count: 3,
      target_secondary: null,
      sheet_id: null,
    });
  });

  it("题级行带 question_type + sheet_id（回看深链的锚点）", async () => {
    const { repo } = makeRepo({
      rows: [row({
        kind: "question",
        record_id: GRADING,
        target_id: QUESTION,
        target_label: "The author implies that ...",
        target_secondary: "reading_choice",
        question_type: "reading_choice",
        sheet_id: SHEET,
        practice_type: null,
        latest_outcome: "partial",
      })],
      total: "1",
    });
    const page = await repo.listUnified({ userId: USER, kind: "question", limit: 20, offset: 0 });
    expect(page.items[0]).toMatchObject({
      kind: "question",
      target_id: QUESTION,
      question_type: "reading_choice",
      sheet_id: SHEET,
      latest_outcome: "partial",
    });
  });
});
