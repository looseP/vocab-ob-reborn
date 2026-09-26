/**
 * L3PaperRepository 单测（作文子空间 W2 增量）：内部写作题排除（双条件 SQL 层）
 * 与写作任务引用查询（删题护栏数据源）。mock executor，无真实 DB。
 */
import { describe, expect, it, vi } from "vitest";
import { L3PaperRepository } from "@/repositories/l3-paper.repository";

const USER = "00000000-0000-4000-8000-000000000001";

describe("L3PaperRepository.listPracticeFiles（内部写作题排除）", () => {
  it("WHERE 同时含 NOT 双条件子句与 owner/active 限定；分页参数位于末两位", async () => {
    const repo = new L3PaperRepository();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const querySpy = vi.spyOn(repo as any, "query").mockResolvedValue([]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const countSpy = vi.spyOn(repo as any, "queryOne").mockResolvedValue({ total: "1" });
    const page = await repo.listPracticeFiles({ userId: USER, questionType: null, direction: null, q: null, limit: 20, offset: 0 });
    const sql = [...countSpy.mock.calls, ...querySpy.mock.calls].map((call) => call[0]).join("\n");
    expect(sql).toContain("NOT (q.file_key LIKE 'writing:%' AND EXISTS (SELECT 1 FROM l3_writing_tasks wt WHERE wt.question_id = q.id AND wt.user_id = q.user_id))");
    expect(sql).toContain("q.user_id = $1::uuid AND q.status = 'active'");
    expect(sql).toContain("ORDER BY latest_created_at DESC");
    expect(querySpy.mock.calls[0]![1]).toEqual([USER, 20, 0]);
    expect(page.total).toBe(1);
    expect(page.items).toEqual([]);
  });

  it("questionType/direction/q 组合追加参数（q 转义 % _）且计数映射为 number", async () => {
    const repo = new L3PaperRepository();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const querySpy = vi.spyOn(repo as any, "query").mockResolvedValue([{ question_count: "2", question_type: "reading_choice" }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(repo as any, "queryOne").mockResolvedValue({ total: "1" });
    const page = await repo.listPracticeFiles({ userId: USER, questionType: "reading_choice", direction: "通用", q: "50%_x", limit: 10, offset: 5 });
    const [sql, params] = querySpy.mock.calls[0]!;
    expect(sql).toContain("q.question_type = $2");
    expect(sql).toContain("s.direction = $3");
    expect(sql).toContain("ILIKE $4");
    expect(params).toEqual([USER, "reading_choice", "通用", "%50\\%\\_x%", 10, 5]);
    expect(page.items[0]!.question_count).toBe(2);
  });

  it("R3：sourceId/fileKey 精确过滤追加 WHERE（精确读面，不依赖 limit 扫描）", async () => {
    const repo = new L3PaperRepository();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const querySpy = vi.spyOn(repo as any, "query").mockResolvedValue([]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(repo as any, "queryOne").mockResolvedValue({ total: "0" });
    await repo.listPracticeFiles({
      userId: USER, sourceId: "00000000-0000-4000-8000-0000000000d2", fileKey: null,
      questionType: "short_essay", direction: null, q: null, limit: 1, offset: 0,
    });
    const [sql, params] = querySpy.mock.calls[0]!;
    expect(sql).toContain("q.source_id = $3");
    expect(params).toEqual([USER, "short_essay", "00000000-0000-4000-8000-0000000000d2", 1, 0]);

    const repo2 = new L3PaperRepository();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const spy2 = vi.spyOn(repo2 as any, "query").mockResolvedValue([]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(repo2 as any, "queryOne").mockResolvedValue({ total: "0" });
    await repo2.listPracticeFiles({
      userId: USER, sourceId: null, fileKey: "k-1",
      questionType: "short_essay", direction: null, q: null, limit: 1, offset: 0,
    });
    const [sql2, params2] = spy2.mock.calls[0]!;
    expect(sql2).toContain("q.file_key = $3");
    expect(params2).toEqual([USER, "short_essay", "k-1", 1, 0]);
  });
});

describe("L3PaperRepository.listWritingTaskRefs / deleteQuestion", () => {
  it("listWritingTaskRefs owner 作用域 + 确定性排序；返回 id/title", async () => {
    const repo = new L3PaperRepository();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const spy = vi.spyOn(repo as any, "query").mockResolvedValue([{ id: "t-1", title: "标题" }]);
    const refs = await repo.listWritingTaskRefs(USER, "q-1");
    const [sql, params] = spy.mock.calls[0]!;
    expect(sql).toContain("FROM l3_writing_tasks t");
    expect(sql).toContain("t.question_id = $1::uuid AND t.user_id = $2::uuid");
    expect(sql).toContain("ORDER BY t.created_at ASC");
    expect(params).toEqual(["q-1", USER]);
    expect(refs).toEqual([{ id: "t-1", title: "标题" }]);
  });

  it("deleteQuestion owner 限定的 DELETE…RETURNING（true/false 两态）", async () => {
    const repo = new L3PaperRepository();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const spy = vi.spyOn(repo as any, "queryOne").mockResolvedValue({ id: "q-1" });
    expect(await repo.deleteQuestion(USER, "q-1")).toBe(true);
    expect(spy.mock.calls[0]![0]).toContain("DELETE FROM l3_questions WHERE id = $1::uuid AND user_id = $2::uuid RETURNING id");
    spy.mockResolvedValue(null);
    expect(await repo.deleteQuestion(USER, "q-1")).toBe(false);
  });
});

/**
 * PATCH 落库层（2026-09-26）。
 *
 * 为什么要仓储级单测：service 测试把 repository 换成了 stub，HTTP 测试走内存假件，
 * 于是 updateQuestion/updatePaper 的 **SQL 文本与参数序** 谁都没验过。参数序错位在
 * 这里不会报错，只会把 stem 写进 answer 列 —— 线上才发现题面被清空。护栏条件
 * （owner + status='active'）同理：漏一个就是越权改别人的题。
 */
describe("L3PaperRepository.updateQuestion（PATCH 落库）", () => {
  const PATCH = {
    question_id: "00000000-0000-4000-8000-0000000000aa",
    user_id: USER,
    stem: "新题干",
    options: [{ key: "A", text: "甲" }],
    answer: { choice: "A" },
    explanation: "官方解析",
    evidence: [{ start: 0, end: 24, label: "首句" }],
    ordinal: 3,
    input_hash: "hash-1",
    // ADR-0037：可改状态集合是 UPDATE 谓词的一部分，由 service 按角色给出。
    editable_statuses: ["active", "pending"],
  };

  it("参数序 stem/options/answer/explanation/evidence/ordinal/input_hash 逐位对齐", async () => {
    const repo = new L3PaperRepository();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const spy = vi.spyOn(repo as any, "queryOne").mockResolvedValue(null);
    await repo.updateQuestion(PATCH);
    const [sql, params] = spy.mock.calls[0]!;
    expect(sql).toContain("SET stem = $3, options = $4::jsonb, answer = $5::jsonb, explanation = $6,");
    expect(sql).toContain("evidence = $7::jsonb, ordinal = $8, input_hash = $9, updated_at = now()");
    // 护栏：owner + 状态集合谓词（ADR-0037：不再写死 active，否则 agent 无处可改、
    // owner 也修不了待录题）。集合由 service 的 editableQuestionStatuses 给出。
    expect(sql).toContain("WHERE id = $1::uuid AND user_id = $2::uuid AND status = ANY($10::text[])");
    expect(params).toEqual([
      PATCH.question_id,
      USER,
      "新题干",
      JSON.stringify(PATCH.options),
      JSON.stringify(PATCH.answer),
      "官方解析",
      JSON.stringify(PATCH.evidence),
      3,
      "hash-1",
      ["active", "pending"],
    ]);
  });

  it("可选列缺省写 null / 空数组（清空语义显式，不留旧值）", async () => {
    const repo = new L3PaperRepository();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const spy = vi.spyOn(repo as any, "queryOne").mockResolvedValue(null);
    await repo.updateQuestion({ ...PATCH, explanation: null, evidence: [], input_hash: null });
    const [, params] = spy.mock.calls[0]! as [string, unknown[]];
    expect(params[5]).toBeNull();
    expect(params[6]).toBe("[]");
    expect(params[8]).toBeNull();
  });

  it("options/answer/evidence 传 undefined 时落空值（`?? []` 右臂，不写 undefined 进 jsonb）", async () => {
    const repo = new L3PaperRepository();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const spy = vi.spyOn(repo as any, "queryOne").mockResolvedValue(null);
    await repo.updateQuestion({
      ...PATCH, options: undefined, answer: undefined, evidence: undefined,
    });
    const [, params] = spy.mock.calls[0]! as [string, unknown[]];
    // jsonb 列收 undefined 会直接报错，所以必须由仓储兜成 [] / {}
    expect(params[3]).toBe("[]");
    expect(params[4]).toBe("{}");
    expect(params[6]).toBe("[]");
  });

  it("RETURNING 行经 mapQuestionRow 归一（ordinal 转 number、evidence 非数组归 [])", async () => {
    const repo = new L3PaperRepository();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(repo as any, "queryOne").mockResolvedValue({
      id: PATCH.question_id, user_id: USER, stem: "新题干", question_type: "reading_choice",
      source_id: null, file_key: null, section_title: null,
      options: [{ key: "A", text: "甲" }], answer: { choice: "A" },
      explanation: "官方解析", evidence: { 坏形状: true }, ordinal: "3",
      input_hash: "hash-1", status: "active", created_at: "t0", updated_at: "t1",
    });
    const row = await repo.updateQuestion(PATCH);
    expect(row).toMatchObject({ ordinal: 3, evidence: [] });
    // 无 RETURNING 行 = 题不存在/非 active/非 owner，一律 null（不抛）
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (repo as any).queryOne.mockResolvedValue(null);
    expect(await repo.updateQuestion(PATCH)).toBeNull();
  });
});

describe("L3PaperRepository.updatePaper / countQuestionAttempts（PATCH 落库）", () => {
  it("updatePaper 写 title/direction/metadata/payload 且带 owner + active 护栏", async () => {
    const repo = new L3PaperRepository();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const spy = vi.spyOn(repo as any, "queryOne").mockResolvedValue(null);
    await repo.updatePaper({
      paper_id: "00000000-0000-4000-8000-0000000000bb",
      user_id: USER,
      title: "新卷名",
      direction: "考研",
      metadata: { note: "m" },
      payload: { version: 1, sections: [] },
      input_hash: null,
    });
    const [sql, params] = spy.mock.calls[0]!;
    expect(sql).toContain("UPDATE l3_papers");
    expect(sql).toContain("SET title = $3, direction = $4, metadata = $5::jsonb, payload = $6::jsonb,");
    expect(sql).toContain("WHERE id = $1::uuid AND user_id = $2::uuid AND status = 'active'");
    expect(params).toEqual([
      "00000000-0000-4000-8000-0000000000bb", USER, "新卷名", "考研",
      JSON.stringify({ note: "m" }), JSON.stringify({ version: 1, sections: [] }), null,
    ]);
  });

  it("direction/metadata 缺省 → null / {}（`?? ` 右臂）", async () => {
    const repo = new L3PaperRepository();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const spy = vi.spyOn(repo as any, "queryOne").mockResolvedValue(null);
    await repo.updatePaper({
      paper_id: "00000000-0000-4000-8000-0000000000bb", user_id: USER, title: "卷",
      direction: null, metadata: undefined, payload: { version: 1, sections: [] }, input_hash: null,
    });
    const [, params] = spy.mock.calls[0]! as [string, unknown[]];
    expect(params[3]).toBeNull();
    expect(params[4]).toBe("{}");
  });

  it("RETURNING 行经 mapPaperRow 归一（无行 → null）", async () => {
    const repo = new L3PaperRepository();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(repo as any, "queryOne").mockResolvedValue({
      id: "00000000-0000-4000-8000-0000000000bb", user_id: USER, title: "新卷名",
      direction: "考研", metadata: { note: "m" }, payload: { version: 1, sections: [] },
      payload_version: 1, status: "active", created_by: "owner", input_hash: null,
      created_at: "t0", updated_at: "t1",
    });
    const row = await repo.updatePaper({
      paper_id: "00000000-0000-4000-8000-0000000000bb", user_id: USER, title: "新卷名",
      direction: "考研", metadata: { note: "m" }, payload: { version: 1, sections: [] }, input_hash: null,
    });
    expect(row).toMatchObject({ id: "00000000-0000-4000-8000-0000000000bb", title: "新卷名" });
  });

  it("countQuestionAttempts 按 owner + question_id 计数，bigint 字符串转 number", async () => {
    const repo = new L3PaperRepository();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const spy = vi.spyOn(repo as any, "queryOne").mockResolvedValue({ count: "3" });
    expect(await repo.countQuestionAttempts(USER, "q-1")).toBe(3);
    const [sql, params] = spy.mock.calls[0]!;
    expect(sql).toContain("FROM l3_question_attempts");
    expect(sql).toContain("WHERE user_id = $1::uuid AND question_id = $2::uuid");
    expect(params).toEqual([USER, "q-1"]);
    // count(*) 恒有行；仍按 0 兜底（mock/驱动异常时 service 会误判成"无作答可改"）
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (repo as any).queryOne.mockResolvedValue(null);
    expect(await repo.countQuestionAttempts(USER, "q-1")).toBe(0);
  });
});

/**
 * 待录 / 采纳的落库层（ADR-0037）。
 *
 * 关键不变量：**谓词里必须带 `status='pending'`**。若写成 `status <> 'rejected'`
 * 或干脆无状态条件，重复采纳会把已驳回的题捞回来、并发采纳会覆盖别人的处置 ——
 * 这类错误在 service 的逐条复判里看不出来（service 只知道 UPDATE 返回了几行）。
 */
describe("L3PaperRepository 待录/采纳（ADR-0037）", () => {
  it("listPendingQuestions 只取 pending，按 created_at/ordinal/id 稳定排序", async () => {
    const repo = new L3PaperRepository();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const querySpy = vi.spyOn(repo as any, "query").mockResolvedValue([]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(repo as any, "queryOne").mockResolvedValue({ total: "2" });
    const page = await repo.listPendingQuestions({ user_id: USER, limit: 50, offset: 0 });
    const [countSql, countParams] = (repo as any).queryOne.mock.calls[0];
    expect(countSql).toContain("WHERE user_id = $1::uuid AND status = 'pending'");
    expect(countParams).toEqual([USER]);
    const [sql, params] = querySpy.mock.calls[0]!;
    expect(sql).toContain("ORDER BY created_at ASC, ordinal ASC, id ASC");
    expect(params).toEqual([USER, 50, 0]);
    expect(page.total).toBe(2);
  });

  it("acceptPendingQuestions 谓词含 pending + owner，返回被改到的 id", async () => {
    const repo = new L3PaperRepository();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const spy = vi.spyOn(repo as any, "query").mockResolvedValue([{ id: "q-1" }]);
    const accepted = await repo.acceptPendingQuestions(USER, ["q-1", "q-2"]);
    const [sql, params] = spy.mock.calls[0]!;
    expect(sql).toContain("SET status = 'active', updated_at = now()");
    expect(sql).toContain("WHERE user_id = $1::uuid AND status = 'pending' AND id = ANY($2::uuid[])");
    expect(params).toEqual([USER, ["q-1", "q-2"]]);
    // 只返回真正改到的（q-2 未 pending → 不在结果里，由 service 复判原因）
    expect(accepted).toEqual(["q-1"]);
  });

  it("acceptPendingQuestions 空数组直接返回，不发查询（无谓打库）", async () => {
    const repo = new L3PaperRepository();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const spy = vi.spyOn(repo as any, "query");
    expect(await repo.acceptPendingQuestions(USER, [])).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("rejectPendingQuestion 只动 pending（rejected 是终态，不可回收）", async () => {
    const repo = new L3PaperRepository();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const spy = vi.spyOn(repo as any, "queryOne").mockResolvedValue({ id: "q-1" });
    expect(await repo.rejectPendingQuestion(USER, "q-1")).toBe(true);
    const [sql, params] = spy.mock.calls[0]!;
    expect(sql).toContain("SET status = 'rejected', updated_at = now()");
    expect(sql).toContain("WHERE id = $1::uuid AND user_id = $2::uuid AND status = 'pending'");
    expect(params).toEqual(["q-1", USER]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (repo as any).queryOne.mockResolvedValue(null);
    expect(await repo.rejectPendingQuestion(USER, "q-1")).toBe(false);
  });
});
