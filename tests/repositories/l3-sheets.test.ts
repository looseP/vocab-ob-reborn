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
    answer: { selected: "B" },
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
    })).rejects.toThrow("sheet insert returned no row");
  });
});

describe("L3SheetRepository.patchAnswers", () => {
  it("merges answers atomically behind a draft-only status guard", async () => {
    const repo = new L3SheetRepository();
    const updated = submission({ answers: { [QUESTION]: { selected: "B" } } });
    vi.spyOn(repo as any, "queryOne").mockResolvedValue(updated);
    const result = await repo.patchAnswers(USER, SHEET, { [QUESTION]: { selected: "B" } });
    expect(result?.answers).toEqual({ [QUESTION]: { selected: "B" } });
    const [sql, params] = (repo as any).queryOne.mock.calls[0];
    expect(sql).toContain("answers = answers || $3::jsonb");
    expect(sql).toContain("status = 'draft'");
    expect(sql).toContain("updated_at = now()");
    expect(params).toEqual([USER, SHEET, JSON.stringify({ [QUESTION]: { selected: "B" } })]);
  });

  it("returns null when the conditional update hits a non-draft or missing sheet", async () => {
    const repo = new L3SheetRepository();
    vi.spyOn(repo as any, "queryOne").mockResolvedValue(null);
    await expect(repo.patchAnswers(USER, SHEET, { [QUESTION]: null })).resolves.toBeNull();
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
    });
    expect(result?.status).toBe("sealed");
    const [sql, params] = (repo as any).queryOne.mock.calls[0];
    expect(sql).toContain("SET status = $3");
    expect(sql).toContain("answers = '{}'::jsonb");
    expect(sql).toContain("sealed_at = now()");
    expect(sql).toContain("status = 'draft'");
    expect(params).toEqual([USER, SHEET, "sealed", "full", null]);
  });

  it("returns null when the seal guard misses (already sealed/discarded)", async () => {
    const repo = txRepo();
    vi.spyOn(repo as any, "queryOne").mockResolvedValue(null);
    await expect(repo.sealSheet(USER, SHEET, {
      status: "discarded", seal_mode: "summary", summary: "本次只留总结",
    })).resolves.toBeNull();
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
      { question_id: QUESTION, sheet_id: SHEET, venue: "file", answer: { selected: "B" }, self_assessment: null },
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
    })).rejects.toThrow("requires an active transaction");
  });

  it("allows sealSheet inside a transaction", async () => {
    const repo = txRepo();
    vi.spyOn(repo as any, "queryOne").mockResolvedValue(submission({ status: "sealed" }));
    await expect(repo.sealSheet(USER, SHEET, {
      status: "sealed", seal_mode: "full", summary: null,
    })).resolves.toMatchObject({ status: "sealed" });
  });
});
