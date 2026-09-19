/**
 * L3StudyReferenceRepository 单元测试（fake PoolClient，无真实 DB）：
 * listForNote/replaceForNote（DELETE+INSERT）/searchTargets（单 kind、q 转义、
 * createdAt keyset、摘要白名单）/loadTargets（批量、白名单字段）/
 * lockTargets（source FOR SHARE 稳定顺序 + question advisory 锁）/
 * listBacklinks（按 note 去重聚合）/删除 blockers（直接 + 子题引用去重）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import { L3StudyReferenceRepository } from "@/repositories/l3-study-references.repository";

const USER = "00000000-0000-4000-8000-0000000000a1";
const NOTE = "00000000-0000-4000-8000-000000000101";
const REF = "00000000-0000-4000-8000-000000000001";
const SOURCE = "00000000-0000-4000-8000-000000000201";
const SOURCE_B = "00000000-0000-4000-8000-000000000202";
const QUESTION = "00000000-0000-4000-8000-000000000211";

function fakeClient(): PoolClient {
  return { query: vi.fn(async () => ({ rows: [] as unknown[] })) } as unknown as PoolClient;
}

function refRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: REF, note_id: NOTE, user_id: USER, kind: "source_quote",
    source_id: SOURCE, question_id: null, option_key: null,
    start_offset: 0, end_offset: 3, quote_snapshot: "The",
    field_hash: "a".repeat(64), display_snapshot: {}, captured_at: "2026-09-19T00:00:00Z",
    ...overrides,
  };
}

let client: PoolClient;
let repo: L3StudyReferenceRepository;
let querySpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  client = fakeClient();
  querySpy = client.query as unknown as ReturnType<typeof vi.fn>;
  repo = new L3StudyReferenceRepository(client);
});

describe("listForNote", () => {
  it("按 (note_id, user_id) 取全部引用", async () => {
    querySpy.mockImplementation(async () => ({ rows: [refRow()] }));
    const rows = await repo.listForNote(USER, NOTE);
    const [text, params] = querySpy.mock.calls[0]!;
    expect(text).toContain("FROM l3_study_note_references");
    expect(text).toContain("note_id = $1::uuid AND user_id = $2::uuid");
    expect(params).toEqual([NOTE, USER]);
    expect(rows.length).toBe(1);
  });
});

describe("replaceForNote", () => {
  it("整组替换：DELETE 本 note 全部引用后 jsonb_to_recordset 批量 INSERT（note_id/user_id 由参数注入，JSON 载荷不得覆盖）", async () => {
    querySpy.mockImplementation(async () => ({ rows: [] }));
    await repo.replaceForNote(USER, NOTE, [
      {
        id: REF, note_id: NOTE, user_id: USER, kind: "source_quote",
        source_id: SOURCE, question_id: null, option_key: null,
        start_offset: 0, end_offset: 3, quote_snapshot: "The",
        field_hash: "a".repeat(64), display_snapshot: { kind: "source_quote" },
      },
    ]);
    const text = querySpy.mock.calls.map((c) => c[0]).join("\n");
    expect(text).toContain("DELETE FROM l3_study_note_references WHERE note_id = $1::uuid AND user_id = $2::uuid");
    expect(text).toContain("INSERT INTO l3_study_note_references");
    expect(text).toContain("jsonb_to_recordset($3::jsonb)");
    const insertCall = querySpy.mock.calls.find((c) => (c[0] as string).includes("INSERT INTO"))!;
    expect(insertCall[1]![0]).toBe(NOTE);
    expect(insertCall[1]![1]).toBe(USER);
    const payload = JSON.parse(insertCall[1]![2] as string) as Record<string, unknown>[];
    expect(payload).toEqual([{
      id: REF, kind: "source_quote", source_id: SOURCE, question_id: null, option_key: null,
      start_offset: 0, end_offset: 3, quote_snapshot: "The",
      field_hash: "a".repeat(64), display_snapshot: { kind: "source_quote" },
    }]);
    // JSON 载荷不含 note_id/user_id（列值由参数注入）
    expect(payload[0]).not.toHaveProperty("note_id");
    expect(payload[0]).not.toHaveProperty("user_id");
  });

  it("空数组只 DELETE 不 INSERT", async () => {
    querySpy.mockImplementation(async () => ({ rows: [] }));
    await repo.replaceForNote(USER, NOTE, []);
    const text = querySpy.mock.calls.map((c) => c[0]).join("\n");
    expect(text).toContain("DELETE FROM");
    expect(text).not.toContain("INSERT INTO");
  });
});

describe("searchTargets", () => {
  it("source kind：title ILIKE 摘要白名单（无正文/无答案概念），(created_at,id) keyset", async () => {
    querySpy.mockImplementation(async (text: string) => {
      if ((text as string).includes("count(*)")) return { rows: [{ total: "1" }] };
      return { rows: [{ id: SOURCE, title: "来源标题", created_at: "2026-09-19T00:00:00Z" }] };
    });
    await repo.searchTargets({
      userId: USER, kind: "source", q: "50%", venue: null,
      cursor: { createdAt: "2026-09-19T00:00:00Z", id: SOURCE }, limit: 21,
    });
    const text = querySpy.mock.calls.map((c) => c[0]).join("\n");
    expect(text).toContain("FROM l3_sources");
    expect(text).toContain("title ILIKE");
    expect(text).toContain("ESCAPE '\\'");
    expect(text).toContain("(created_at, id) <");
    expect(text).not.toContain("content_text");
    expect(text).not.toContain("answer");
  });

  it("question kind：venue 过滤题型且摘要不含 answer/explanation/evidence", async () => {
    querySpy.mockImplementation(async (text: string) => {
      if ((text as string).includes("count(*)")) return { rows: [{ total: "0" }] };
      return { rows: [{ id: QUESTION, stem: "题干", question_type: "reading_choice", created_at: "2026-09-19T00:00:00Z" }] };
    });
    await repo.searchTargets({
      userId: USER, kind: "question", q: "fox", venue: "reading_choice", cursor: null, limit: 21,
    });
    const text = querySpy.mock.calls.map((c) => c[0]).join("\n");
    expect(text).toContain("FROM l3_questions");
    expect(text).toContain("stem ILIKE");
    expect(text).toContain("question_type = $");
    expect(text).not.toContain("explanation");
    expect(text).not.toContain("evidence");
    expect(text).not.toMatch(/SELECT[^;]*\banswer\b/);
  });
});

describe("loadTargets", () => {
  it("按 kind 批量加载：source 带 content_text；question 带 options/题型/来源标题（LEFT JOIN）", async () => {
    querySpy.mockImplementation(async (text: string) => {
      if ((text as string).includes("FROM l3_sources")) {
        return { rows: [{ id: SOURCE, title: "来源", content_text: "The quick brown fox." }] };
      }
      return {
        rows: [{
          id: QUESTION, stem: "Q?", options: [{ key: "A", text: "a" }],
          question_type: "reading_choice", source_id: SOURCE, source_title: "来源",
        }],
      };
    });
    const map = await repo.loadTargets(USER, [
      { kind: "source", id: SOURCE },
      { kind: "question", id: QUESTION },
    ]);
    const sourceText = querySpy.mock.calls[0]![0] as string;
    const questionText = querySpy.mock.calls[1]![0] as string;
    expect(sourceText).toContain("content_text");
    expect(questionText).toContain("LEFT JOIN l3_sources");
    expect(questionText).not.toContain("answer");
    expect(map.get(`source:${SOURCE}`)).toMatchObject({ kind: "source", content_text: "The quick brown fox." });
    expect(map.get(`question:${QUESTION}`)).toMatchObject({
      kind: "question", stem: "Q?", question_type: "reading_choice", source_title: "来源",
    });
  });

  it("空输入不产生查询", async () => {
    const map = await repo.loadTargets(USER, []);
    expect(map.size).toBe(0);
    expect(querySpy.mock.calls.length).toBe(0);
  });
});

describe("lockTargets", () => {
  it("source 组 FOR SHARE（按 id 稳定顺序）；question 组逐个 advisory 锁（l3_question: 前缀）", async () => {
    querySpy.mockImplementation(async () => ({ rows: [] }));
    await repo.lockTargets(USER, [
      { kind: "question", id: QUESTION },
      { kind: "source", id: SOURCE_B },
      { kind: "source", id: SOURCE },
    ]);
    const calls = querySpy.mock.calls;
    // source 批量一次
    const sourceCall = calls.find((c) => (c[0] as string).includes("FROM l3_sources"))!;
    expect(sourceCall[0]).toContain("FOR SHARE");
    expect(sourceCall[0]).toContain("ORDER BY id ASC");
    expect(sourceCall[1]).toEqual([USER, [SOURCE, SOURCE_B]]);
    // question 逐个（排序后）
    const lockCalls = calls.filter((c) => (c[0] as string).includes("pg_advisory_xact_lock"));
    expect(lockCalls.length).toBe(1);
    expect(lockCalls[0]![1]).toEqual([`l3_question:${QUESTION}`]);
  });

  it("无事务时拒绝（requireTx）", async () => {
    const noTx = new L3StudyReferenceRepository();
    await expect(noTx.lockTargets(USER, [{ kind: "source", id: SOURCE }]))
      .rejects.toThrow(/requires an active transaction/);
  });
});

describe("listBacklinks", () => {
  it("按 note 去重聚合：reference_count 与 ref_ids，默认不含归档", async () => {
    querySpy.mockImplementation(async (text: string) => {
      if ((text as string).includes("count(DISTINCT")) return { rows: [{ total: "2" }] };
      return {
        rows: [{
          note_id: NOTE, title: "笔记", status: "active",
          reference_count: 3, ref_ids: [REF, REF, "00000000-0000-4000-8000-000000000002"],
        }],
      };
    });
    const { items, total } = await repo.listBacklinks({
      userId: USER, targetKind: "source", targetId: SOURCE, cursor: null, limit: 21,
    });
    const text = querySpy.mock.calls.map((c) => c[0]).join("\n");
    expect(text).toContain("n.status = 'active'");
    expect(text).toContain("GROUP BY");
    expect(text).toContain("array_agg");
    expect(text).toContain("r.source_id = $");
    expect(items[0]).toMatchObject({ note_id: NOTE, reference_count: 3 });
    expect(total).toBe(2);
  });
});

describe("删除 blockers", () => {
  it("source：直接引用 + 子题引用去重 note 列表（含归档笔记）", async () => {
    querySpy.mockImplementation(async () => ({
      rows: [{ note_id: NOTE, title: "笔记", status: "archived", reference_count: 2 }],
    }));
    const blockers = await repo.getSourceDeleteBlockers(USER, SOURCE);
    const [text, params] = querySpy.mock.calls[0]!;
    expect(text).toContain("r.source_id = $2::uuid");
    expect(text).toContain("r.question_id IN (SELECT id FROM l3_questions WHERE user_id = $1::uuid AND source_id = $2::uuid)");
    expect(text).toContain("GROUP BY");
    expect(params).toEqual([USER, SOURCE]);
    expect(blockers[0]).toMatchObject({ note_id: NOTE, status: "archived", reference_count: 2 });
  });

  it("question：按 question_id 找引用其的 note（去重）", async () => {
    querySpy.mockImplementation(async () => ({
      rows: [{ note_id: NOTE, title: "笔记", status: "active", reference_count: 1 }],
    }));
    const blockers = await repo.getQuestionDeleteBlockers(USER, QUESTION);
    const [text, params] = querySpy.mock.calls[0]!;
    expect(text).toContain("r.question_id = $2::uuid");
    expect(params).toEqual([USER, QUESTION]);
    expect(blockers.length).toBe(1);
  });
});
