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
