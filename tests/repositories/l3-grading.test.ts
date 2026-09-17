import { describe, it, expect, vi } from "vitest";
import type { L3GradingResultRow } from "@/domain";
import { L3GradingRepository } from "@/repositories/l3-grading.repository";

const USER = "00000000-0000-4000-8000-000000000001";
const SHEET = "00000000-0000-4000-8000-000000000401";
const QUESTION = "00000000-0000-4000-8000-000000000101";

function gradingRow(overrides: Partial<L3GradingResultRow> = {}): L3GradingResultRow {
  return {
    id: "00000000-0000-4000-8000-000000000801",
    user_id: USER,
    sheet_id: SHEET,
    question_id: QUESTION,
    verdict: "correct",
    analysis_md: "定位准确。",
    graded_by: "agent-a",
    graded_at: "2026-09-17T00:00:00.000Z",
    ...overrides,
  };
}

describe("L3GradingRepository.listBySheet", () => {
  it("selects rows for the owner sheet ordered by question", async () => {
    const repo = new L3GradingRepository();
    vi.spyOn(repo as any, "query").mockResolvedValue([gradingRow()]);
    const rows = await repo.listBySheet(USER, SHEET);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.verdict).toBe("correct");
    const [sql, params] = (repo as any).query.mock.calls[0];
    expect(sql).toContain("FROM l3_grading_results");
    expect(sql).toContain("user_id = $1::uuid");
    expect(sql).toContain("sheet_id = $2::uuid");
    expect(sql).toContain("ORDER BY question_id, id");
    expect(params).toEqual([USER, SHEET]);
  });
});

describe("L3GradingRepository.upsertResults", () => {
  it("short-circuits on an empty input without hitting the database", async () => {
    const repo = new L3GradingRepository();
    const query = vi.spyOn(repo as any, "query");
    await expect(repo.upsertResults([])).resolves.toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it("bulk-upserts with ON CONFLICT latest-wins and graded_at refresh", async () => {
    const repo = new L3GradingRepository();
    vi.spyOn(repo as any, "query").mockResolvedValue([
      gradingRow(),
      gradingRow({ id: "00000000-0000-4000-8000-000000000802", question_id: "00000000-0000-4000-8000-000000000102", verdict: "wrong" }),
    ]);
    const rows = await repo.upsertResults([
      { user_id: USER, sheet_id: SHEET, question_id: QUESTION, verdict: "correct", analysis_md: "定位准确。", graded_by: "agent-a" },
      { user_id: USER, sheet_id: SHEET, question_id: "00000000-0000-4000-8000-000000000102", verdict: "wrong", analysis_md: null, graded_by: "agent-a" },
    ]);
    expect(rows).toHaveLength(2);
    const [sql, params] = (repo as any).query.mock.calls[0];
    expect(sql).toContain("INSERT INTO l3_grading_results");
    expect(sql).toContain("ON CONFLICT (sheet_id, question_id)");
    expect(sql).toContain("DO UPDATE SET verdict = EXCLUDED.verdict");
    expect(sql).toContain("graded_at = now()");
    expect(sql).toContain("RETURNING *");
    expect(params).toEqual([
      USER, SHEET, QUESTION, "correct", "定位准确。", "agent-a",
      USER, SHEET, "00000000-0000-4000-8000-000000000102", "wrong", null, "agent-a",
    ]);
  });
});
