import { describe, it, expect, vi } from "vitest";
import type { PoolClient } from "pg";
import type { L3AnnotationTagRow, L3QuestionAnnotationRow } from "@/domain";
import { L3AnnotationRepository } from "@/repositories/l3-annotations.repository";

const USER = "00000000-0000-4000-8000-000000000001";
const QUESTION = "00000000-0000-4000-8000-000000000101";

function annotation(overrides: Partial<L3QuestionAnnotationRow> = {}): L3QuestionAnnotationRow {
  return {
    id: "00000000-0000-4000-8000-000000000201",
    user_id: USER,
    question_id: QUESTION,
    ordinal: 0,
    anchor_start: 12,
    anchor_end: 20,
    excerpt: "trap phrase",
    note: "选项 B 偷换概念",
    entry_tags: ["推断题"],
    option_tags: { B: ["偷换概念"] },
    stage: "confirmed",
    sheet_id: null,
    review: null,
    status: "active",
    created_at: "2026-09-16T00:00:00.000Z",
    updated_at: "2026-09-16T00:00:00.000Z",
    ...overrides,
  };
}

function tag(overrides: Partial<L3AnnotationTagRow> = {}): L3AnnotationTagRow {
  return {
    id: "00000000-0000-4000-8000-000000000301",
    user_id: USER,
    kind: "entry",
    label: "细节题",
    ordinal: 0,
    status: "active",
    created_at: "2026-09-16T00:00:00.000Z",
    updated_at: "2026-09-16T00:00:00.000Z",
    ...overrides,
  };
}

/** replaceTags 要求事务；伪 client 只用于通过 requireTx 断言。 */
function txRepo(): L3AnnotationRepository {
  return new L3AnnotationRepository({} as PoolClient);
}

describe("L3AnnotationRepository.listForQuestions", () => {
  it("short-circuits on an empty id list without hitting the database", async () => {
    const repo = new L3AnnotationRepository();
    const query = vi.spyOn(repo as any, "query");
    await expect(repo.listForQuestions(USER, [])).resolves.toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it("selects active rows for the owner ordered by question/ordinal/created_at", async () => {
    const repo = new L3AnnotationRepository();
    const rows = [annotation(), annotation({ id: "00000000-0000-4000-8000-000000000202", ordinal: 1, anchor_start: null, anchor_end: null, excerpt: null, note: "题型归因", entry_tags: ["主旨题"], option_tags: {} })];
    vi.spyOn(repo as any, "query").mockResolvedValue(rows);

    const result = await repo.listForQuestions(USER, [QUESTION]);
    expect(result).toHaveLength(2);
    const [sql, params] = (repo as any).query.mock.calls[0];
    expect(sql).toContain("status = 'active'");
    expect(sql).toContain("question_id = ANY($2::uuid[])");
    expect(sql).toContain("ORDER BY question_id, ordinal, created_at, id");
    expect(params).toEqual([USER, [QUESTION]]);
  });

  it("defends against malformed jsonb payloads", async () => {
    const repo = new L3AnnotationRepository();
    vi.spyOn(repo as any, "query").mockResolvedValue([
      annotation({ entry_tags: "nope" as unknown as string[], option_tags: null as unknown as Record<string, string[]> }),
    ]);
    const [row] = await repo.listForQuestions(USER, [QUESTION]);
    expect(row.entry_tags).toEqual([]);
    expect(row.option_tags).toEqual({});
  });
});

describe("L3AnnotationRepository.findByAnchor", () => {
  it("queries the active row by the exact (question,start,end) triple", async () => {
    const repo = new L3AnnotationRepository();
    vi.spyOn(repo as any, "queryOne").mockResolvedValue(annotation());
    const result = await repo.findByAnchor(USER, QUESTION, 12, 20);
    expect(result?.excerpt).toBe("trap phrase");
    const [sql, params] = (repo as any).queryOne.mock.calls[0];
    expect(sql).toContain("anchor_start = $3");
    expect(sql).toContain("anchor_end = $4");
    expect(sql).toContain("status = 'active'");
    expect(params).toEqual([USER, QUESTION, 12, 20]);
  });
});

describe("L3AnnotationRepository.insertAnnotation", () => {
  it("inserts jsonb payloads and returns the mapped row", async () => {
    const repo = new L3AnnotationRepository();
    vi.spyOn(repo as any, "queryOne").mockResolvedValue(annotation());
    const result = await repo.insertAnnotation({
      user_id: USER,
      question_id: QUESTION,
      anchor_start: 12,
      anchor_end: 20,
      excerpt: "trap phrase",
      note: "选项 B 偷换概念",
      entry_tags: ["推断题"],
      option_tags: { B: ["偷换概念"] },
    });
    expect(result.id).toBe("00000000-0000-4000-8000-000000000201");
    const [sql, params] = (repo as any).queryOne.mock.calls[0];
    expect(sql).toContain("INSERT INTO l3_question_annotations");
    expect(params).toContain(JSON.stringify(["推断题"]));
    expect(params).toContain(JSON.stringify({ B: ["偷换概念"] }));
    // ordinal 缺省由库内题内 max+1 分配
    expect(sql).toContain("max_ordinal");
  });

  it("fails closed when the insert returns no row", async () => {
    const repo = new L3AnnotationRepository();
    vi.spyOn(repo as any, "queryOne").mockResolvedValue(null);
    await expect(repo.insertAnnotation({
      user_id: USER, question_id: QUESTION,
      anchor_start: null, anchor_end: null, excerpt: null,
      note: "无锚点", entry_tags: [], option_tags: {},
    })).rejects.toThrow("annotation insert returned no row");
  });
});

describe("L3AnnotationRepository.updateAnnotation", () => {
  it("dynamically sets only provided columns and bumps updated_at", async () => {
    const repo = new L3AnnotationRepository();
    const updated = annotation({ note: "改后" });
    vi.spyOn(repo as any, "queryOne").mockResolvedValue(updated);

    const result = await repo.updateAnnotation(USER, updated.id, { note: "改后" });
    expect(result?.note).toBe("改后");
    const [sql, params] = (repo as any).queryOne.mock.calls[0];
    expect(sql).toContain("note = $3");
    expect(sql).toContain("updated_at = now()");
    expect(sql).not.toContain("entry_tags =");
    expect(params).toEqual([USER, updated.id, "改后"]);
  });

  it("writes explicit null anchor triple and jsonb tags when provided", async () => {
    const repo = new L3AnnotationRepository();
    vi.spyOn(repo as any, "queryOne").mockResolvedValue(
      annotation({ anchor_start: null, anchor_end: null, excerpt: null, option_tags: {} }),
    );
    await repo.updateAnnotation(USER, annotation().id, {
      anchor_start: null,
      anchor_end: null,
      excerpt: null,
      option_tags: { A: ["同义替换"] },
    });
    const [sql, params] = (repo as any).queryOne.mock.calls[0];
    expect(sql).toContain("anchor_start = $3");
    expect(sql).toContain("excerpt = $5");
    expect(sql).toContain("option_tags = $6::jsonb");
    expect(params.slice(2)).toEqual([null, null, null, JSON.stringify({ A: ["同义替换"] })]);
  });

  it("returns null when the row is not owned / already deleted", async () => {
    const repo = new L3AnnotationRepository();
    vi.spyOn(repo as any, "queryOne").mockResolvedValue(null);
    await expect(repo.updateAnnotation(USER, annotation().id, { note: "x" })).resolves.toBeNull();
  });
});

describe("L3AnnotationRepository.softDeleteAnnotation", () => {
  it("flips status to deleted on an active owned row", async () => {
    const repo = new L3AnnotationRepository();
    vi.spyOn(repo as any, "queryOne").mockResolvedValue({ id: annotation().id });
    await expect(repo.softDeleteAnnotation(USER, annotation().id)).resolves.toBe(true);
    const [sql, params] = (repo as any).queryOne.mock.calls[0];
    expect(sql).toContain("SET status = 'deleted'");
    expect(sql).toContain("status = 'active'");
    expect(params).toEqual([USER, annotation().id]);
  });

  it("returns false when nothing matched", async () => {
    const repo = new L3AnnotationRepository();
    vi.spyOn(repo as any, "queryOne").mockResolvedValue(null);
    await expect(repo.softDeleteAnnotation(USER, annotation().id)).resolves.toBe(false);
  });
});

describe("L3AnnotationRepository tags", () => {
  it("lists active tags ordered by kind then ordinal", async () => {
    const repo = new L3AnnotationRepository();
    vi.spyOn(repo as any, "query").mockResolvedValue([
      tag({ kind: "entry", label: "细节题", ordinal: 0 }),
      tag({ id: "00000000-0000-4000-8000-000000000302", kind: "option", label: "无中生有", ordinal: 0 }),
    ]);
    const rows = await repo.listTags(USER);
    expect(rows[1]!.kind).toBe("option");
    const [sql, params] = (repo as any).query.mock.calls[0];
    expect(sql).toContain("status = 'active'");
    expect(sql).toContain("ORDER BY kind, ordinal, created_at, id");
    expect(params).toEqual([USER]);
  });

  it("replaces the whole dictionary inside a transaction: soft-delete then insert", async () => {
    const repo = txRepo();
    const query = vi.spyOn(repo as any, "query").mockResolvedValue([
      tag({ kind: "entry", label: "细节题" }),
      tag({ id: "00000000-0000-4000-8000-000000000302", kind: "option", label: "无中生有" }),
    ]);

    const result = await repo.replaceTags(USER, { entry: ["细节题"], option: ["无中生有"] });
    expect(result).toHaveLength(2);

    const softDeleteCall = query.mock.calls[0]!;
    expect(softDeleteCall[0]).toContain("UPDATE l3_annotation_tags SET status = 'deleted'");
    expect(softDeleteCall[0]).toContain("status = 'active'");
    expect(softDeleteCall[1]).toEqual([USER]);

    const insertCall = query.mock.calls[1]!;
    expect(insertCall[0]).toContain("INSERT INTO l3_annotation_tags");
    expect(insertCall[0]).toContain("RETURNING *");
    expect(insertCall[1]).toEqual([
      USER, "entry", "细节题", 0,
      USER, "option", "无中生有", 0,
    ]);
  });

  it("replaceTags refuses to run without an enclosing transaction", async () => {
    const repo = new L3AnnotationRepository();
    await expect(repo.replaceTags(USER, { entry: [], option: [] })).rejects.toThrow(/requires an active transaction/);
  });
});

describe("L3AnnotationRepository batch-2 sheet helpers", () => {
  const SHEET = "00000000-0000-4000-8000-000000000401";

  it("lists draft annotations of one sheet (promotion candidates)", async () => {
    const repo = new L3AnnotationRepository();
    vi.spyOn(repo as any, "query").mockResolvedValue([
      annotation({ stage: "draft", sheet_id: SHEET }),
    ]);
    const rows = await repo.listDraftBySheet(USER, SHEET);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.stage).toBe("draft");
    const [sql, params] = (repo as any).query.mock.calls[0];
    expect(sql).toContain("sheet_id = $2::uuid");
    expect(sql).toContain("stage = 'draft'");
    expect(sql).toContain("status = 'active'");
    expect(params).toEqual([USER, SHEET]);
  });

  it("promotes draft→submitted behind the sheet+draft+active guard", async () => {
    const repo = new L3AnnotationRepository();
    vi.spyOn(repo as any, "query").mockResolvedValue([
      annotation({ stage: "submitted", sheet_id: SHEET }),
    ]);
    const rows = await repo.promoteBySheet(USER, SHEET);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.stage).toBe("submitted");
    const [sql, params] = (repo as any).query.mock.calls[0];
    expect(sql).toContain("SET stage = 'submitted'");
    expect(sql).toContain("sheet_id = $2::uuid");
    expect(sql).toContain("stage = 'draft'");
    expect(sql).toContain("status = 'active'");
    expect(params).toEqual([USER, SHEET]);
  });

  it("inserts the summary entry as a submitted no-anchor annotation pinned to the sheet", async () => {
    const repo = new L3AnnotationRepository();
    vi.spyOn(repo as any, "queryOne").mockResolvedValue(
      annotation({ stage: "submitted", sheet_id: SHEET, note: "本次全对，只留元认知", anchor_start: null, anchor_end: null, excerpt: null }),
    );
    const row = await repo.insertSummaryAnnotation({
      user_id: USER,
      question_id: QUESTION,
      sheet_id: SHEET,
      note: "本次全对，只留元认知",
    });
    expect(row.stage).toBe("submitted");
    const [sql, params] = (repo as any).queryOne.mock.calls[0];
    expect(sql).toContain("INSERT INTO l3_question_annotations");
    expect(sql).toContain("'submitted'");
    expect(sql).toContain("max_ordinal");
    expect(params).toEqual([USER, QUESTION, SHEET, "本次全对，只留元认知"]);
  });

  it("fails closed when the summary insert returns no row", async () => {
    const repo = new L3AnnotationRepository();
    vi.spyOn(repo as any, "queryOne").mockResolvedValue(null);
    await expect(repo.insertSummaryAnnotation({
      user_id: USER, question_id: QUESTION, sheet_id: SHEET, note: "总结",
    })).rejects.toThrow("summary annotation insert returned no row");
  });
});
