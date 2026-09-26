/**
 * L3StudyReferenceRepository 单元测试（fake PoolClient，无真实 DB）：
 * listForNote/replaceForNote（DELETE+INSERT）/searchTargets（单 kind、q 转义、
 * createdAt keyset、摘要白名单）/loadTargets（批量、白名单字段）/
 * lockTargets（source FOR SHARE 稳定顺序 + question advisory 锁）/
 * listBacklinks（按 note 去重聚合）/删除 blockers（直接 + 子题引用去重）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import { ValidationError } from "@/errors";
import { L3StudyReferenceRepository } from "@/repositories/l3-study-references.repository";

const USER = "00000000-0000-4000-8000-0000000000a1";
const NOTE = "00000000-0000-4000-8000-000000000101";
const REF = "00000000-0000-4000-8000-000000000001";
const SOURCE = "00000000-0000-4000-8000-000000000201";
const OTHER_QUESTION = "00000000-0000-4000-8000-000000000212";
const SOURCE_B = "00000000-0000-4000-8000-000000000202";
const QUESTION = "00000000-0000-4000-8000-000000000211";

function fakeClient(): PoolClient {
  return { query: vi.fn(async () => ({ rows: [] as unknown[] })) } as unknown as PoolClient;
}

function refRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: REF, note_id: NOTE, user_id: USER, kind: "source_quote",
    source_id: SOURCE, question_id: null, assessment_id: null, target_note_id: null, option_key: null,
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
  it("整组替换：DELETE 本 note 全部引用后 jsonb_to_recordset 批量 INSERT（note_id/user_id 由参数注入，captured_at 随行——keep 保留原时间）", async () => {
    querySpy.mockImplementation(async () => ({ rows: [] }));
    await repo.replaceForNote(USER, NOTE, [
      {
        id: REF, kind: "source_quote",
        source_id: SOURCE, question_id: null, assessment_id: null, target_note_id: null,
        submission_id: null, submission_revision_no: null, attempt_id: null, option_key: null,
        start_offset: 0, end_offset: 3, quote_snapshot: "The",
        field_hash: "a".repeat(64), display_snapshot: { kind: "source_quote" },
        captured_at: "2026-09-19T00:00:00.000Z",
      },
    ]);
    const text = querySpy.mock.calls.map((c) => c[0]).join("\n");
    expect(text).toContain("DELETE FROM l3_study_note_references WHERE note_id = $1::uuid AND user_id = $2::uuid");
    expect(text).toContain("INSERT INTO l3_study_note_references");
    expect(text).toContain("jsonb_to_recordset($3::jsonb)");
    expect(text).not.toContain("now()");
    const insertCall = querySpy.mock.calls.find((c) => (c[0] as string).includes("INSERT INTO"))!;
    expect(insertCall[1]![0]).toBe(NOTE);
    expect(insertCall[1]![1]).toBe(USER);
    const payload = JSON.parse(insertCall[1]![2] as string) as Record<string, unknown>[];
    expect(payload).toEqual([{
      id: REF, kind: "source_quote", source_id: SOURCE, question_id: null, assessment_id: null,
      // N2 第三条链：新三列对所有既有 kind 恒 null（载荷形状同步扩展）。
      target_note_id: null, submission_id: null, submission_revision_no: null, attempt_id: null,
      option_key: null,
      start_offset: 0, end_offset: 3, quote_snapshot: "The",
      field_hash: "a".repeat(64), display_snapshot: { kind: "source_quote" },
      captured_at: "2026-09-19T00:00:00.000Z",
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

  it("question kind：venue 过滤题型且摘要不含 answer/explanation/evidence；仅 active 题进入搜索（F3）", async () => {
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
    expect(text).toContain("status = 'active'"); // F3：非 active 目标不得进入搜索
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
    expect(questionText).toContain("status = 'active'"); // F3：非 active 目标不可装载（capture/resolve 同断）
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

  it("grading kind：只取白名单字段，且**必须**是 sealed 题纸（ADR-0039 决策 4）", async () => {
    querySpy.mockImplementation(async () => ({
      rows: [{
        sheet_id: "sheet-1", question_id: QUESTION, verdict: "wrong",
        analysis_md: "限定词读错", graded_by: "agent-1", graded_at: "2026-09-26T00:00:00Z",
        question_ordinal: 2, question_type: "reading_choice", source_title: "来源",
      }],
    }));
    const map = await repo.loadTargets(USER, [{ kind: "grading", id: `sheet-1:${QUESTION}` }]);
    const sql = querySpy.mock.calls[0]![0] as string;
    // 决策 4：未定格题纸引不到评卷。谓词必须落在 SQL 里（而非 service 后置过滤），
    // 否则 draft 行会先被读进内存再丢弃，与 ①② 快照口径不同源。
    expect(sql).toContain("l3_submissions");
    expect(sql).toMatch(/status\s*=\s*'sealed'/);
    // 白名单：判定与分析进 hash，归属事实（评卷人/时间/题序/来源）只进快照。
    for (const col of ["verdict", "analysis_md", "graded_by", "graded_at", "question_ordinal", "source_title"]) {
      expect(sql).toContain(col);
    }
    // 复合身份在 SQL 层展开，不能让 id 里的 `:` 混进 uuid 比较。
    expect(sql).toContain("sheet_id");
    expect(map.get(`grading:sheet-1:${QUESTION}`)).toMatchObject({ kind: "grading", verdict: "wrong" });
    // 行里的复合键必须与请求键一致，否则忠实装载在生产环境取不到（K5 同款坑）。
    expect(map.size).toBe(1);
  });

  it("grading：行里多出来的复合键被挡在 map 外（sheet 级取数 + 客户端侧 wanted 过滤）", async () => {
    // 取数是「按 sheet 批量取」（SQL 的 = ANY($2) 只吃 sheetId），所以数据库可能
    // 回传这张题纸上**别的**题的评卷行。装载必须按请求的复合键过滤，否则一次
    // capture 会把整张卷的评卷都写进引用集。
    querySpy.mockImplementation(async () => ({
      rows: [
        {
          sheet_id: "sheet-1", question_id: QUESTION, sheet_status: "sealed", verdict: "wrong",
          analysis_md: null, graded_by: "agent-1", graded_at: "2026-09-26T00:00:00Z",
          question_ordinal: 2, question_type: "reading_choice", source_title: null,
        },
        {
          sheet_id: "sheet-1", question_id: OTHER_QUESTION, sheet_status: "sealed", verdict: "correct",
          analysis_md: null, graded_by: "agent-1", graded_at: "2026-09-26T00:00:00Z",
          question_ordinal: 3, question_type: "reading_choice", source_title: null,
        },
      ],
    }));
    const map = await repo.loadTargets(USER, [{ kind: "grading", id: `sheet-1:${QUESTION}` }]);
    expect([...map.keys()]).toEqual([`grading:sheet-1:${QUESTION}`]);
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

  it("F5：question 大写 → advisory 键规范为小写（与 capture/删除两端同键）；source 混合大小写去重为单一规范值", async () => {
    querySpy.mockImplementation(async () => ({ rows: [] }));
    await repo.lockTargets(USER, [
      { kind: "question", id: "BEEFCAFE-2345-4789-8ABC-000000000211" },
      { kind: "source", id: "ABCDEFAB-2345-4789-8ABC-000000000201" },
      { kind: "source", id: "abcdefab-2345-4789-8abc-000000000201" },
    ]);
    const calls = querySpy.mock.calls;
    const sourceCall = calls.find((c) => (c[0] as string).includes("FROM l3_sources"))!;
    expect(sourceCall[1]).toEqual([USER, ["abcdefab-2345-4789-8abc-000000000201"]]);
    const lockCalls = calls.filter((c) => (c[0] as string).includes("pg_advisory_xact_lock"));
    expect(lockCalls.length).toBe(1);
    expect(lockCalls[0]![1]).toEqual(["l3_question:beefcafe-2345-4789-8abc-000000000211"]);
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

describe("补齐：引用归属回查 / 搜索与反向引用游标", () => {
  it("findReferenceOwners 返回 id→note 映射（归一为小写）；空输入不查询", async () => {
    querySpy.mockImplementation(async () => ({
      rows: [{ id: REF.toUpperCase(), note_id: NOTE }],
    }));
    const owners = await repo.findReferenceOwners(USER, [REF]);
    const [text, params] = querySpy.mock.calls[0]!;
    expect(text).toContain("id = ANY($2::uuid[])");
    expect(params).toEqual([USER, [REF]]);
    expect(owners.get(REF)).toBe(NOTE);

    const callsBefore = querySpy.mock.calls.length;
    const empty = await repo.findReferenceOwners(USER, []);
    expect(empty.size).toBe(0);
    expect(querySpy.mock.calls.length).toBe(callsBefore);
  });

  it("searchTargets（question kind）带 cursor 生成 (created_at,id) 键集", async () => {
    querySpy.mockImplementation(async (text: string) => {
      if ((text as string).includes("count(*)")) return { rows: [{ total: "1" }] };
      return { rows: [{ id: QUESTION, stem: "Q", question_type: "reading_choice", created_at: "2026-09-19T00:00:00Z" }] };
    });
    await repo.searchTargets({
      userId: USER, kind: "question", q: null, venue: null,
      cursor: { createdAt: "2026-09-19T00:00:00Z", id: QUESTION }, limit: 21,
    });
    const listCall = querySpy.mock.calls.find((c) => (c[0] as string).includes("ORDER BY"))!;
    expect(listCall[0]).toContain("(created_at, id) <");
    expect(listCall[0]).toContain("::timestamptz");
  });

  it("listBacklinks 带 cursor 生成 (n.updated_at, n.id) 键集且返回 updated_at", async () => {
    querySpy.mockImplementation(async (text: string) => {
      if ((text as string).includes("count(DISTINCT")) return { rows: [{ total: "1" }] };
      return {
        rows: [{
          note_id: NOTE, title: "T", status: "active", reference_count: 1,
          ref_ids: [REF], updated_at: "2026-09-19T00:00:00Z",
        }],
      };
    });
    const { items } = await repo.listBacklinks({
      userId: USER, targetKind: "source", targetId: SOURCE,
      cursor: { updatedAt: "2026-09-19T00:00:00Z", id: NOTE }, limit: 21,
    });
    const listCall = querySpy.mock.calls.find((c) => (c[0] as string).includes("ORDER BY"))!;
    expect(listCall[0]).toContain("(n.updated_at, n.id) <");
    expect(items[0]!.updated_at).toBe("2026-09-19T00:00:00Z");
  });
});

describe("N2 评析目标（第一条垂直链）", () => {
  const ASSESSMENT = "00000000-0000-4000-8000-000000000221";

  it("searchTargets 拒绝 assessment：fail-closed，不退化成题目查询", async () => {
    await expect(
      repo.searchTargets({ userId: USER, kind: "assessment", q: "题眼", limit: 20 } as never),
    ).rejects.toThrow(ValidationError);
    // 不发出任何查询——退化成 question 搜索会把评析面悄悄塞进搜索结果
    expect(querySpy).not.toHaveBeenCalled();
  });

  it("loadTargets 装载评析：JOIN 所属题取上下文，键为 assessment:<id>", async () => {
    querySpy.mockImplementation(async () => ({
      rows: [{
        id: ASSESSMENT, question_id: QUESTION, content_md: "评析正文",
        updated_at: "2026-09-20T00:00:00Z", stem: "题干", question_type: "reading_choice", source_title: null,
      }],
    }));
    const map = await repo.loadTargets(USER, [{ kind: "assessment", id: ASSESSMENT }]);

    expect(map.get(`assessment:${ASSESSMENT}`)).toEqual({
      kind: "assessment", id: ASSESSMENT, question_id: QUESTION, content_md: "评析正文",
      updated_at: "2026-09-20T00:00:00Z", question_stem: "题干",
      question_type: "reading_choice", source_title: null,
    });
    const [text, params] = querySpy.mock.calls[0]!;
    expect(text).toContain("FROM l3_question_assessments a");
    // 题与评析必须同属主，否则引用可把他人评析挂到自己的题下
    expect(text).toContain("JOIN l3_questions q ON q.id = a.question_id AND q.user_id = a.user_id");
    expect(params).toEqual([USER, [ASSESSMENT]]);
  });

  it("lockTargets 对评析取 advisory 锁（l3_assessment: 前缀，与题目锁并存）", async () => {
    querySpy.mockImplementation(async () => ({ rows: [] }));
    await repo.lockTargets(USER, [
      { kind: "question", id: QUESTION },
      { kind: "assessment", id: ASSESSMENT },
    ]);
    const lockKeys = querySpy.mock.calls
      .filter((c) => (c[0] as string).includes("pg_advisory_xact_lock"))
      .map((c) => (c[1] as unknown[])[0]);
    expect(lockKeys).toEqual([`l3_question:${QUESTION}`, `l3_assessment:${ASSESSMENT}`]);
  });

  it("question 删除 blocker 计入「经评析」的引用（评析随题级联删除）", async () => {
    querySpy.mockImplementation(async () => ({
      rows: [{ note_id: NOTE, title: "T", status: "active", reference_count: 1 }],
    }));
    const blockers = await repo.getQuestionDeleteBlockers(USER, QUESTION);

    expect(blockers).toHaveLength(1);
    const [text] = querySpy.mock.calls[0]!;
    // 只按 question_id 计会漏掉子评析引用，删的时候直接撞 RESTRICT 而非给出 blocker
    expect(text).toContain("r.assessment_id IN (SELECT id FROM l3_question_assessments");
  });
});

describe("N2 笔记互链（仓储层 · 第二条垂直链）", () => {
  const TARGET_NOTE = "00000000-0000-4000-8000-000000000231";

  it("loadTargets note 分支：白名单只取 id/title/body_md/status，不按 status 过滤（归档目标仍可解析）", async () => {
    querySpy.mockImplementation(async () => ({
      rows: [{ id: TARGET_NOTE, title: "被引用笔记", body_md: "正文", status: "archived" }],
    }));
    const map = await repo.loadTargets(USER, [{ kind: "note", id: TARGET_NOTE }]);

    const [text, params] = querySpy.mock.calls[0]!;
    expect(text).toContain("FROM l3_study_notes");
    // 与 question 的 F3 不同：笔记目标归档后引用仍要能解析出 current/changed
    expect(text).not.toContain("status = 'active'");
    // 只展开一层：不 JOIN、不取目标笔记自身的引用集合
    expect(text).not.toContain("JOIN");
    expect(params).toEqual([USER, [TARGET_NOTE]]);
    expect(map.get(`note:${TARGET_NOTE}`)).toMatchObject({
      kind: "note",
      id: TARGET_NOTE,
      title: "被引用笔记",
      body_md: "正文",
      status: "archived",
    });
  });

  it("lockTargets note 分支：advisory 键 l3_study_note:<小写 uuid>（与 question/assessment 同款）", async () => {
    querySpy.mockImplementation(async () => ({ rows: [] }));
    await repo.lockTargets(USER, [{ kind: "note", id: "BEEFCAFE-2345-4789-8ABC-000000000231" }]);

    const lockCalls = querySpy.mock.calls.filter((c) => (c[0] as string).includes("pg_advisory_xact_lock"));
    expect(lockCalls.length).toBe(1);
    expect(lockCalls[0]![1]).toEqual(["l3_study_note:beefcafe-2345-4789-8abc-000000000231"]);
  });

  it("replaceForNote：载荷与 INSERT 列携带 target_note_id（note_id/user_id 仍由参数注入）", async () => {
    querySpy.mockImplementation(async () => ({ rows: [] }));
    await repo.replaceForNote(USER, NOTE, [{
      id: REF, kind: "note",
      source_id: null, question_id: null, assessment_id: null, target_note_id: TARGET_NOTE,
      submission_id: null, submission_revision_no: null, attempt_id: null,
      option_key: null, start_offset: null, end_offset: null, quote_snapshot: null,
      field_hash: "a".repeat(64), display_snapshot: { kind: "note" },
      captured_at: "2026-09-19T00:00:00.000Z",
    }]);

    const insertCall = querySpy.mock.calls.find((c) => (c[0] as string).includes("INSERT INTO"))!;
    expect(insertCall[0]).toContain("target_note_id");
    const payload = JSON.parse(insertCall[1]![2] as string) as Record<string, unknown>[];
    expect(payload[0]!.target_note_id).toBe(TARGET_NOTE);
    // 归属列不得出现在 JSON 载荷里
    expect(payload[0]).not.toHaveProperty("note_id");
    expect(payload[0]).not.toHaveProperty("user_id");
  });

  it("listBacklinks：note 目标走 r.target_note_id 列", async () => {
    querySpy.mockImplementation(async (text: string) => {
      if ((text as string).includes("count(DISTINCT")) return { rows: [{ total: "1" }] };
      return { rows: [{ note_id: NOTE, title: "笔记", status: "active", reference_count: 1, ref_ids: [REF] }] };
    });
    await repo.listBacklinks({
      userId: USER, targetKind: "note", targetId: TARGET_NOTE, cursor: null, limit: 21,
    });

    const text = querySpy.mock.calls.map((c) => c[0]).join("\n");
    expect(text).toContain("r.target_note_id = $2::uuid");
    expect(text).not.toContain("r.source_id = $");
  });

  it("searchTargets：note 目标不支持搜索 → fail-closed（不退化成别的 kind 查询）", async () => {
    await expect(
      repo.searchTargets({
        userId: USER, kind: "note", q: null, venue: null, cursor: null, limit: 21,
      }),
    ).rejects.toThrow(ValidationError);
    expect(querySpy.mock.calls.length).toBe(0);
  });
});

describe("N2 第三条链（仓储层 · sheet / attempt 装载与锁键）", () => {
  const SHEET = "00000000-0000-4000-8000-000000000321";
  const ATTEMPT = "00000000-0000-4000-8000-000000000331";

  it("loadTargets sheet 分支：只装载 sealed（draft/discarded 取不到）、白名单不含 answers、键为 sheet:<id>", async () => {
    querySpy.mockImplementation(async () => ({
      rows: [{ id: SHEET, scope: "file", status: "sealed", revision_no: null, summary: "小结" }],
    }));
    const map = await repo.loadTargets(USER, [{ kind: "sheet", id: SHEET }]);

    const [text, params] = querySpy.mock.calls[0]!;
    expect(text).toContain("FROM l3_submissions");
    // D1-a / K1：draft / discarded 不是合法目标
    expect(text).toContain("status = 'sealed'");
    // K7 / K14：白名单不含 answers（用户作答）与任何评卷列
    expect(text).not.toContain("answers");
    expect(params).toEqual([USER, [SHEET]]);
    expect(map.get(`sheet:${SHEET}`)).toMatchObject({
      kind: "sheet",
      id: SHEET,
      scope: "file",
      status: "sealed",
      revision_no: null,
      summary: "小结",
    });
  });

  it("loadTargets attempt 分支：只装载 active（软删取不到 → unavailable）、键为 attempt:<id>", async () => {
    querySpy.mockImplementation(async () => ({
      rows: [{ id: ATTEMPT, venue: "file", answer: { value: "A" }, status: "active" }],
    }));
    const map = await repo.loadTargets(USER, [{ kind: "attempt", id: ATTEMPT }]);

    const [text, params] = querySpy.mock.calls[0]!;
    expect(text).toContain("FROM l3_question_attempts");
    // K10：软删行不装载
    expect(text).toContain("status = 'active'");
    expect(params).toEqual([USER, [ATTEMPT]]);
    expect(map.get(`attempt:${ATTEMPT}`)).toMatchObject({
      kind: "attempt",
      id: ATTEMPT,
      venue: "file",
      status: "active",
    });
  });

  it("lockTargets：sheet 用 l3_submission:<小写 uuid>、attempt 用 l3_attempt:<小写 uuid>（K17）", async () => {
    querySpy.mockImplementation(async () => ({ rows: [] }));
    await repo.lockTargets(USER, [
      { kind: "sheet", id: "BEEFCAFE-2345-4789-8ABC-000000000321" },
      { kind: "attempt", id: "BEEFCAFE-2345-4789-8ABC-000000000331" },
    ]);

    const keys = querySpy.mock.calls
      .filter((c) => (c[0] as string).includes("pg_advisory_xact_lock"))
      .map((c) => (c[1] as unknown[])[0]);
    expect(keys).toEqual([
      "l3_submission:beefcafe-2345-4789-8abc-000000000321",
      "l3_attempt:beefcafe-2345-4789-8abc-000000000331",
    ]);
  });

  it("listBacklinks：sheet 走 r.submission_id、attempt 走 r.attempt_id（不退化成 question_id）", async () => {
    querySpy.mockImplementation(async (text: string) => {
      if ((text as string).includes("count(DISTINCT")) return { rows: [{ total: "1" }] };
      return { rows: [{ note_id: NOTE, title: "笔记", status: "active", reference_count: 1, ref_ids: [REF] }] };
    });

    await repo.listBacklinks({ userId: USER, targetKind: "sheet", targetId: SHEET, cursor: null, limit: 21 });
    const sheetText = querySpy.mock.calls.map((c) => c[0]).join("\n");
    expect(sheetText).toContain("r.submission_id = $2::uuid");
    expect(sheetText).not.toContain("r.question_id = $2");

    querySpy.mockClear();
    querySpy.mockImplementation(async (text: string) => {
      if ((text as string).includes("count(DISTINCT")) return { rows: [{ total: "1" }] };
      return { rows: [{ note_id: NOTE, title: "笔记", status: "active", reference_count: 1, ref_ids: [REF] }] };
    });
    await repo.listBacklinks({ userId: USER, targetKind: "attempt", targetId: ATTEMPT, cursor: null, limit: 21 });
    const attemptText = querySpy.mock.calls.map((c) => c[0]).join("\n");
    expect(attemptText).toContain("r.attempt_id = $2::uuid");
    expect(attemptText).not.toContain("r.question_id = $2");
  });

  it("searchTargets：sheet / attempt 不支持搜索 → fail-closed（不新增搜索面，R-2 同款纪律）", async () => {
    querySpy.mockImplementation(async () => ({ rows: [] }));
    for (const kind of ["sheet", "attempt"] as const) {
      await expect(
        repo.searchTargets({ userId: USER, kind, q: null, venue: null, cursor: null, limit: 21 }),
      ).rejects.toThrow(ValidationError);
    }
    expect(querySpy.mock.calls.length).toBe(0);
  });

  it("replaceForNote：载荷与 INSERT 列携带 submission_id / submission_revision_no / attempt_id（归属仍由参数注入）", async () => {
    querySpy.mockImplementation(async () => ({ rows: [] }));
    await repo.replaceForNote(USER, NOTE, [{
      id: REF, kind: "sheet",
      source_id: null, question_id: null, assessment_id: null, target_note_id: null,
      submission_id: SHEET, submission_revision_no: 2, attempt_id: null,
      option_key: null, start_offset: null, end_offset: null, quote_snapshot: null,
      field_hash: "a".repeat(64), display_snapshot: { kind: "sheet" },
      captured_at: "2026-09-19T00:00:00.000Z",
    }]);

    const insertCall = querySpy.mock.calls.find((c) => (c[0] as string).includes("INSERT INTO"))!;
    expect(insertCall[0]).toContain("submission_id");
    expect(insertCall[0]).toContain("submission_revision_no");
    expect(insertCall[0]).toContain("attempt_id");
    const payload = JSON.parse(insertCall[1]![2] as string) as Record<string, unknown>[];
    expect(payload[0]!.submission_id).toBe(SHEET);
    expect(payload[0]!.submission_revision_no).toBe(2);
    expect(payload[0]!.attempt_id).toBeNull();
    expect(payload[0]).not.toHaveProperty("note_id");
    expect(payload[0]).not.toHaveProperty("user_id");
  });
});

// N2 第三条垂直链：attempt 软删 blocker（M-0044 之后才有 attempt_id 列；
// 这两条是本链的**红测**——方法尚未实现，先锁死口径再动实现）。
const ATTEMPT = "00000000-0000-4000-8000-000000000221";
const NOTE_B = "00000000-0000-4000-8000-000000000102";

describe("getAttemptDeleteBlockers（N2 第三条链 · attempt 软删 blocker）", () => {
  it("按 attempt_id 聚合引用它的笔记：逐笔记计数、含归档、不含身份兜底", async () => {
    querySpy.mockImplementation(async () => ({
      rows: [
        { note_id: NOTE, title: "卷面整理", status: "active", reference_count: 2 },
        { note_id: NOTE_B, title: "作文复盘", status: "archived", reference_count: 1 },
      ],
    }));
    const blockers = await repo.getAttemptDeleteBlockers(USER, ATTEMPT);
    const [text, params] = querySpy.mock.calls[0]!;
    expect(text).toContain("FROM l3_study_note_references r");
    expect(text).toContain("r.attempt_id = $2::uuid");
    expect(text).toMatch(/count\(r\.id\)|COUNT\(r\.id\)/i);
    expect(text).toContain("GROUP BY");
    expect(params).toEqual([USER, ATTEMPT]);
    expect(blockers).toEqual([
      { note_id: NOTE, title: "卷面整理", status: "active", reference_count: 2 },
      { note_id: NOTE_B, title: "作文复盘", status: "archived", reference_count: 1 },
    ]);
  });

  it("不得按 question_id / submission_id / sheet_id 兜底计引用（attempt 身份只能是 attempt_id）", async () => {
    querySpy.mockImplementation(async () => ({ rows: [] }));
    await repo.getAttemptDeleteBlockers(USER, ATTEMPT);
    const [text] = querySpy.mock.calls[0]!;
    expect(text).not.toMatch(/r\.question_id = \$2|r\.submission_id = \$2/);
  });
});
