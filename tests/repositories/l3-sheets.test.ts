import { describe, it, expect, vi } from "vitest";
import type { PoolClient } from "pg";
import type { L3QuestionAttemptRow, L3SubmissionRow } from "@/domain";
import { L3SheetRepository } from "@/repositories/l3-sheets.repository";

const USER = "00000000-0000-4000-8000-000000000001";
const SHEET = "00000000-0000-4000-8000-000000000401";
const SOURCE = "00000000-0000-4000-8000-000000000302";
const QUESTION = "00000000-0000-4000-8000-000000000101";
const QUESTION_B = "00000000-0000-4000-8000-000000000102";

function submission(overrides: Partial<L3SubmissionRow> = {}): L3SubmissionRow {
  return {
    id: SHEET,
    user_id: USER,
    scope: "file",
    scope_key: `file:${SOURCE}:reading_choice`,
    source_id: SOURCE,
    question_type: "reading_choice",
    paper_id: null,
    writing_task_id: null,
    parent_sheet_id: null,
    revision_no: null,
    draft_version: 0,
    question_ids: null,
    status: "draft",
    answers: {},
    seal_mode: null,
    summary: null,
    sealed_at: null,
    created_at: "2026-09-17T00:00:00.000Z",
    updated_at: "2026-09-17T00:00:00.000Z",
    ...overrides,
  };
}

function attempt(overrides: Partial<L3QuestionAttemptRow> = {}): L3QuestionAttemptRow {
  return {
    id: "00000000-0000-4000-8000-000000000501",
    user_id: USER,
    question_id: QUESTION,
    sheet_id: SHEET,
    venue: "file",
    answer: { choice: "B" },
    self_assessment: null,
    status: "active",
    deleted_at: null,
    created_at: "2026-09-17T01:00:00.000Z",
    ...overrides,
  };
}

/** seal/promote 等要求事务的方法通过伪 client 仅用其存在性。 */
function txRepo(): L3SheetRepository {
  return new L3SheetRepository({} as PoolClient);
}

describe("L3SheetRepository.findDraftByScopeKey", () => {
  it("looks up the single draft row for the (user, scope_key) pair", async () => {
    const repo = new L3SheetRepository();
    vi.spyOn(repo as any, "queryOne").mockResolvedValue(submission());
    const result = await repo.findDraftByScopeKey(USER, `file:${SOURCE}:reading_choice`);
    expect(result?.id).toBe(SHEET);
    const [sql, params] = (repo as any).queryOne.mock.calls[0];
    expect(sql).toContain("status = 'draft'");
    expect(sql).toContain("scope_key = $2");
    expect(params).toEqual([USER, `file:${SOURCE}:reading_choice`]);
  });
});

describe("L3SheetRepository.openSheet", () => {
  it("inserts with an ON CONFLICT draft-index guard and reports creation", async () => {
    const repo = new L3SheetRepository();
    vi.spyOn(repo as any, "queryOne").mockResolvedValue(submission());
    const result = await repo.openSheet({
      user_id: USER,
      scope: "file",
      scope_key: `file:${SOURCE}:reading_choice`,
      source_id: SOURCE,
      question_type: "reading_choice",
      paper_id: null,
      question_ids: null,
    });
    expect(result.created).toBe(true);
    expect(result.row.id).toBe(SHEET);
    const [sql] = (repo as any).queryOne.mock.calls[0];
    expect(sql).toContain("INSERT INTO l3_submissions");
    expect(sql).toContain("ON CONFLICT (user_id, scope_key) WHERE status = 'draft'");
    expect(sql).toContain("DO NOTHING");
  });

  it("reuses the existing draft row on a conflict (idempotent open)", async () => {
    const repo = new L3SheetRepository();
    const queryOne = vi.spyOn(repo as any, "queryOne");
    queryOne.mockResolvedValueOnce(null); // INSERT ... DO NOTHING 撞唯一索引
    const lookup = vi.spyOn(repo as any, "findDraftByScopeKey").mockResolvedValue(submission());
    const result = await repo.openSheet({
      user_id: USER,
      scope: "file",
      scope_key: `file:${SOURCE}:reading_choice`,
      source_id: SOURCE,
      question_type: "reading_choice",
      paper_id: null,
      question_ids: null,
    });
    expect(result.created).toBe(false);
    expect(lookup).toHaveBeenCalledWith(USER, `file:${SOURCE}:reading_choice`);
  });

  it("fails closed when neither insert nor reuse yields a row", async () => {
    const repo = new L3SheetRepository();
    vi.spyOn(repo as any, "queryOne").mockResolvedValue(null);
    vi.spyOn(repo as any, "findDraftByScopeKey").mockResolvedValue(null);
    await expect(repo.openSheet({
      user_id: USER, scope: "paper", scope_key: "paper:x", source_id: null,
      question_type: null, paper_id: "00000000-0000-4000-8000-000000000302",
      question_ids: null,
    })).rejects.toThrow("sheet insert returned no row");
  });
});

describe("L3SheetRepository.patchAnswers", () => {
  it("merges answers atomically behind a draft-only status guard and bumps the draft version", async () => {
    const repo = new L3SheetRepository();
    const updated = submission({ answers: { [QUESTION]: { choice: "B" } }, draft_version: 3 });
    vi.spyOn(repo as any, "queryOne").mockResolvedValue(updated);
    const result = await repo.patchAnswers(USER, SHEET, { [QUESTION]: { choice: "B" } }, 2);
    expect(result?.answers).toEqual({ [QUESTION]: { choice: "B" } });
    expect(result?.draft_version).toBe(3);
    const [sql, params] = (repo as any).queryOne.mock.calls[0];
    expect(sql).toContain("answers = answers || $3::jsonb");
    expect(sql).toContain("draft_version = draft_version + 1");
    expect(sql).toContain("status = 'draft'");
    expect(sql).toContain("draft_version = $4"); // V：客户端确认版本 CAS
    expect(sql).toContain("updated_at = now()");
    expect(params).toEqual([USER, SHEET, JSON.stringify({ [QUESTION]: { choice: "B" } }), 2]);
  });

  it("returns null when the conditional update hits a non-draft, missing sheet or stale version", async () => {
    const repo = new L3SheetRepository();
    vi.spyOn(repo as any, "queryOne").mockResolvedValue(null);
    await expect(repo.patchAnswers(USER, SHEET, { [QUESTION]: null }, 5)).resolves.toBeNull();
  });
});

describe("L3SheetRepository.sealSheet", () => {
  it("flips status, records seal metadata and clears answers in one guarded update", async () => {
    const repo = txRepo();
    vi.spyOn(repo as any, "queryOne").mockResolvedValue(submission({
      status: "sealed", seal_mode: "full", sealed_at: "2026-09-17T02:00:00.000Z",
    }));
    const result = await repo.sealSheet(USER, SHEET, {
      status: "sealed", seal_mode: "full", summary: null,
    }, submission().draft_version);
    expect(result?.status).toBe("sealed");
    const [sql, params] = (repo as any).queryOne.mock.calls[0];
    expect(sql).toContain("SET status = $3");
    expect(sql).toContain("answers = '{}'::jsonb");
    expect(sql).toContain("sealed_at = now()");
    expect(sql).toContain("status = 'draft'");
    expect(sql).toContain("draft_version = $6");
    expect(params).toEqual([USER, SHEET, "sealed", "full", null, submission().draft_version]);
  });

  it("returns null when the seal guard misses (already sealed/discarded)", async () => {
    const repo = txRepo();
    vi.spyOn(repo as any, "queryOne").mockResolvedValue(null);
    await expect(repo.sealSheet(USER, SHEET, {
      status: "discarded", seal_mode: "summary", summary: "本次只留总结",
    }, submission().draft_version)).resolves.toBeNull();
  });
});

describe("L3SheetRepository.getSheet", () => {
  it("selects the owner row by id", async () => {
    const repo = new L3SheetRepository();
    vi.spyOn(repo as any, "queryOne").mockResolvedValue(submission());
    const result = await repo.getSheet(USER, SHEET);
    expect(result?.scope_key).toBe(`file:${SOURCE}:reading_choice`);
    const [sql, params] = (repo as any).queryOne.mock.calls[0];
    expect(sql).toContain("id = $2::uuid");
    expect(params).toEqual([USER, SHEET]);
  });
});

describe("L3SheetRepository.insertAttempts", () => {
  it("batch-inserts materialized attempts with one statement", async () => {
    const repo = new L3SheetRepository();
    const rows = [
      attempt(),
      attempt({ id: "00000000-0000-4000-8000-000000000502", question_id: QUESTION_B, answer: { text: "译文" } }),
    ];
    vi.spyOn(repo as any, "query").mockResolvedValue(rows);
    const result = await repo.insertAttempts(USER, [
      { question_id: QUESTION, sheet_id: SHEET, venue: "file", answer: { choice: "B" }, self_assessment: null },
      { question_id: QUESTION_B, sheet_id: SHEET, venue: "file", answer: { text: "译文" }, self_assessment: null },
    ]);
    expect(result).toHaveLength(2);
    const [sql, params] = (repo as any).query.mock.calls[0];
    expect(sql).toContain("INSERT INTO l3_question_attempts");
    expect(sql).toContain("(user_id, question_id, sheet_id, venue, answer, self_assessment)");
    expect(sql).toContain("($1::uuid, $2::uuid, $3::uuid, $4, $5::jsonb, $6::jsonb)");
    expect(sql).toContain("($7::uuid, $8::uuid, $9::uuid, $10, $11::jsonb, $12::jsonb)");
    expect(params?.[0]).toBe(USER);
    expect(params?.[1]).toBe(QUESTION);
  });

  it("short-circuits on an empty attempt batch", async () => {
    const repo = new L3SheetRepository();
    const query = vi.spyOn(repo as any, "query");
    await expect(repo.insertAttempts(USER, [])).resolves.toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });
});

describe("L3SheetRepository.listForQuestions", () => {
  it("queries active history by question_id = ANY(...) (batch column-name precedent)", async () => {
    const repo = new L3SheetRepository();
    vi.spyOn(repo as any, "query").mockResolvedValue([attempt()]);
    const result = await repo.listForQuestions(USER, [QUESTION, QUESTION_B]);
    expect(result).toHaveLength(1);
    const [sql, params] = (repo as any).query.mock.calls[0];
    expect(sql).toContain("question_id = ANY($2::uuid[])");
    expect(sql).toContain("status = 'active'");
    expect(sql).toContain("ORDER BY question_id, created_at, id");
    expect(params).toEqual([USER, [QUESTION, QUESTION_B]]);
  });

  it("short-circuits on an empty id list", async () => {
    const repo = new L3SheetRepository();
    const query = vi.spyOn(repo as any, "query");
    await expect(repo.listForQuestions(USER, [])).resolves.toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });
});

describe("L3SheetRepository.softDeleteAttempt", () => {
  it("soft-deletes an active attempt and reports true", async () => {
    const repo = new L3SheetRepository();
    vi.spyOn(repo as any, "queryOne").mockResolvedValue({ id: "00000000-0000-4000-8000-000000000501" });
    await expect(repo.softDeleteAttempt(USER, "00000000-0000-4000-8000-000000000501")).resolves.toBe(true);
    const [sql, params] = (repo as any).queryOne.mock.calls[0];
    expect(sql).toContain("SET status = 'deleted'");
    expect(sql).toContain("deleted_at = now()");
    expect(sql).toContain("status = 'active'");
    expect(params).toEqual([USER, "00000000-0000-4000-8000-000000000501"]);
  });

  it("returns false when the attempt is missing or already deleted (re-delete → 404)", async () => {
    const repo = new L3SheetRepository();
    vi.spyOn(repo as any, "queryOne").mockResolvedValue(null);
    await expect(repo.softDeleteAttempt(USER, "00000000-0000-4000-8000-000000000501")).resolves.toBe(false);
  });

  it("excludes writing attempts at the SQL layer（写作正文清理只走专用事务，含 feedback 同事务删除）", async () => {
    const repo = new L3SheetRepository();
    vi.spyOn(repo as any, "queryOne").mockResolvedValue(null);
    await expect(repo.softDeleteAttempt(USER, "00000000-0000-4000-8000-000000000502")).resolves.toBe(false);
    const [sql] = (repo as any).queryOne.mock.calls[0];
    expect(sql).toContain("venue <> 'writing'");
  });
});

describe("L3SheetRepository.listBySheet", () => {
  it("returns the full derived row set including deleted (result-page placeholder split)", async () => {
    const repo = new L3SheetRepository();
    vi.spyOn(repo as any, "query").mockResolvedValue([
      attempt(),
      attempt({ id: "00000000-0000-4000-8000-000000000503", status: "deleted", deleted_at: "2026-09-17T03:00:00.000Z" }),
    ]);
    const result = await repo.listBySheet(USER, SHEET);
    expect(result).toHaveLength(2);
    const [sql, params] = (repo as any).query.mock.calls[0];
    expect(sql).toContain("sheet_id = $2::uuid");
    expect(sql).not.toContain("status = 'active'");
    expect(sql).toContain("ORDER BY created_at, id");
    expect(params).toEqual([USER, SHEET]);
  });
});

describe("L3SheetRepository.countAnsweredBySheet", () => {
  it("counts answered question keys straight from the answers jsonb", async () => {
    const repo = new L3SheetRepository();
    vi.spyOn(repo as any, "queryOne").mockResolvedValue({ answered_count: 3 });
    await expect(repo.countAnsweredBySheet(USER, SHEET)).resolves.toBe(3);
    const [sql, params] = (repo as any).queryOne.mock.calls[0];
    expect(sql).toContain("jsonb_object_keys");
    expect(params).toEqual([USER, SHEET]);
  });

  it("returns zero when the sheet row is missing", async () => {
    const repo = new L3SheetRepository();
    vi.spyOn(repo as any, "queryOne").mockResolvedValue(null);
    await expect(repo.countAnsweredBySheet(USER, SHEET)).resolves.toBe(0);
  });
});

describe("L3SheetRepository transaction guard", () => {
  it("refuses sealSheet outside a transaction", async () => {
    const repo = new L3SheetRepository();
    await expect(repo.sealSheet(USER, SHEET, {
      status: "sealed", seal_mode: "full", summary: null,
    }, submission().draft_version)).rejects.toThrow("requires an active transaction");
  });

  it("allows sealSheet inside a transaction", async () => {
    const repo = txRepo();
    vi.spyOn(repo as any, "queryOne").mockResolvedValue(submission({ status: "sealed" }));
    await expect(repo.sealSheet(USER, SHEET, {
      status: "sealed", seal_mode: "full", summary: null,
    }, submission().draft_version)).resolves.toMatchObject({ status: "sealed" });
  });
});

describe("L3SheetRepository.listArchive（F-1 题纸档案）", () => {
  it("projects archive rows with graded_count/venue_title and draft+sealed filter, newest first", async () => {
    const repo = new L3SheetRepository();
    vi.spyOn(repo as any, "query").mockResolvedValue([{
      id: SHEET,
      scope: "file",
      source_id: SOURCE,
      question_type: "reading_choice",
      paper_id: null,
      status: "sealed",
      seal_mode: "full",
      sealed_at: "2026-09-18T00:10:00.000Z",
      created_at: "2026-09-18T00:00:00.000Z",
      graded_count: 3,
      venue_title: "WA 阅读理解文件",
    }]);
    const rows = await repo.listArchive(USER, 20);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: SHEET, status: "sealed", graded_count: 3, venue_title: "WA 阅读理解文件",
    });
    const [sql, params] = (repo as any).query.mock.calls[0];
    expect(sql).toContain("FROM l3_submissions s");
    expect(sql).toContain("LEFT JOIN l3_sources src");
    expect(sql).toContain("LEFT JOIN l3_papers p");
    expect(sql).toContain("s.status IN ('draft', 'sealed')");
    expect(sql).toContain("ORDER BY s.created_at DESC");
    expect(sql).toContain("LIMIT $2");
    expect(params).toEqual([USER, 20]);
  });

  it("coerces driver shapes (string count / null title) without leaking through", async () => {
    const repo = new L3SheetRepository();
    vi.spyOn(repo as any, "query").mockResolvedValue([{
      id: SHEET,
      scope: "paper",
      source_id: null,
      question_type: null,
      paper_id: "00000000-0000-4000-8000-000000000303",
      status: "draft",
      seal_mode: null,
      sealed_at: null,
      created_at: "2026-09-18T00:00:00.000Z",
      graded_count: "0",
      venue_title: null,
    }]);
    const rows = await repo.listArchive(USER, 50);
    expect(rows[0]!.graded_count).toBe(0);
    expect(rows[0]!.venue_title).toBeNull();
  });
});

describe("L3SheetRepository.findWritingTaskQuestionId（W3 作用域解析只读助手）", () => {
  it("只读解析写作任务的 question_id（无锁、owner 限定）；空行 null", async () => {
    const repo = new L3SheetRepository();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const spy = vi.spyOn(repo as any, "queryOne").mockResolvedValue({ question_id: "q-1" });
    expect(await repo.findWritingTaskQuestionId(USER, "00000000-0000-4000-8000-000000000601")).toBe("q-1");
    const [sql, params] = spy.mock.calls[0]!;
    expect(sql).toContain("FROM l3_writing_tasks WHERE id = $1::uuid AND user_id = $2::uuid");
    expect(sql).not.toContain("FOR UPDATE");
    expect(params).toEqual(["00000000-0000-4000-8000-000000000601", USER]);

    spy.mockResolvedValue(null);
    expect(await repo.findWritingTaskQuestionId(USER, "00000000-0000-4000-8000-000000000601")).toBeNull();
  });
});

/**
 * ADR-0038：两个新查询的仓储级断言。
 *
 * 为什么不靠 service 测试兜：service 把仓储换成了 stub，SQL 文本与谓词谁都没验过。
 * 这两条谓词正是本 ADR 的判据所在 —— 「只列 sealed 且未评完」写错一个 `status`，
 * 清单就会把 draft 题纸或已评完的题纸报成待评。
 */
describe("L3SheetRepository 待评卷清单 / 补冻结（ADR-0038）", () => {
  it("待评卷清单：只列 sealed + file/paper，且只列「已评 < 可评」的题纸", async () => {
    const repo = new L3SheetRepository();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const querySpy = vi.spyOn(repo as any, "query").mockResolvedValue([
      { id: SHEET, scope: "file", sealed_at: "2026-09-26T00:00:00Z", graded_count: "1", gradable_count: "3", question_count: "5", venue_title: "2023 英一" },
    ]);
    const rows = await repo.listPendingGradingSheets(USER, 50);
    const [sql, params] = querySpy.mock.calls[0]!;
    // draft 未定格（评卷 409）、discarded 作答已弃 → 都不得出现
    expect(sql).toContain("s.status = 'sealed'");
    expect(sql).toContain("s.scope IN ('file', 'paper')");
    // 「已评 < 可评」是「待评」的定义；可评数 = 已物化 active attempt 的题数
    expect(sql).toContain("FROM l3_grading_results g2 WHERE g2.sheet_id = s.id");
    expect(sql).toContain("FROM l3_question_attempts a3");
    expect(sql).toContain("a3.status = 'active'");
    // 最早定格优先（先做先评）
    expect(sql).toContain("ORDER BY s.sealed_at ASC");
    expect(params).toEqual([USER, 50]);
    // bigint 字符串 → number（前端拿它当分母比较，字符串会静默失效）
    expect(rows[0]).toMatchObject({ graded_count: 1, gradable_count: 3, question_count: 5 });
  });

  it("待评卷清单：只 SELECT 身份与计数，**不带题面/答案/作答列**", async () => {
    const repo = new L3SheetRepository();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const querySpy = vi.spyOn(repo as any, "query").mockResolvedValue([]);
    await repo.listPendingGradingSheets(USER, 10);
    const [sql] = querySpy.mock.calls[0]!;
    // 最小披露是授权判据的一部分（ADR-0038 决策 2）：SELECT 列表里出现题面列即越界
    for (const forbidden of ["q.stem", "q.answer", "l3_questions q", "a.answer"]) {
      expect(sql).not.toContain(forbidden);
    }
  });

  it("补冻结：谓词含 question_ids IS NULL（幂等 + 并发安全），空数组不发查询", async () => {
    const repo = new L3SheetRepository();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const queryOneSpy = vi.spyOn(repo as any, "queryOne").mockResolvedValue({ id: SHEET });
    expect(await repo.freezeQuestionIds(USER, SHEET, [QUESTION, QUESTION_B])).toBe(true);
    const [sql, params] = queryOneSpy.mock.calls[0]!;
    expect(sql).toContain("SET question_ids = $3::uuid[]");
    // 谓词含 IS NULL ⇒ 第二个调用者 0 行，不会覆写已定格快照
    expect(sql).toContain("question_ids IS NULL");
    expect(params).toEqual([SHEET, USER, [QUESTION, QUESTION_B]]);
    // 谓词含 user_id（不越权改别人的题纸）
    expect(sql).toContain("user_id = $2::uuid");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fresh = new L3SheetRepository();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const noQuery = vi.spyOn(fresh as any, "queryOne");
    expect(await fresh.freezeQuestionIds(USER, SHEET, [])).toBe(false);
    expect(noQuery).not.toHaveBeenCalled();
  });
});