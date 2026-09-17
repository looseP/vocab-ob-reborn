import { describe, expect, it, vi } from "vitest";
import type { L3QuestionAssessmentRow } from "@/domain";
import { L3AssessmentRepository } from "@/repositories/l3-assessments.repository";

const USER = "00000000-0000-4000-8000-000000000001";
const QUESTION = "00000000-0000-4000-8000-000000000101";
const ASSESSMENT = "00000000-0000-4000-8000-000000000701";

function assessment(overrides: Partial<L3QuestionAssessmentRow> = {}): L3QuestionAssessmentRow {
  return {
    id: ASSESSMENT,
    user_id: USER,
    question_id: QUESTION,
    content_md: "本题的判据梳理：B 项偷换概念。",
    last_editor: "owner",
    created_at: "2026-09-17T00:00:00Z",
    updated_at: "2026-09-17T00:00:00Z",
    ...overrides,
  };
}

describe("L3AssessmentRepository", () => {
  it("findByQuestion reads the single row for the owner", async () => {
    const repo = new L3AssessmentRepository();
    vi.spyOn(repo as any, "queryOne").mockResolvedValue(assessment());
    const row = await repo.findByQuestion(USER, QUESTION);
    expect(row?.id).toBe(ASSESSMENT);
    const [sql, params] = (repo as any).queryOne.mock.calls[0];
    expect(sql).toContain("FROM l3_question_assessments");
    expect(sql).toContain("user_id = $1::uuid");
    expect(sql).toContain("question_id = $2::uuid");
    expect(params).toEqual([USER, QUESTION]);
  });

  it("findByQuestion returns null when the question has no assessment（空态）", async () => {
    const repo = new L3AssessmentRepository();
    vi.spyOn(repo as any, "queryOne").mockResolvedValue(null);
    await expect(repo.findByQuestion(USER, QUESTION)).resolves.toBeNull();
  });

  it("upsert writes via ON CONFLICT DO UPDATE with the actor editor（latest-wins）", async () => {
    const repo = new L3AssessmentRepository();
    vi.spyOn(repo as any, "queryOne").mockResolvedValue(assessment({ last_editor: "agent" }));
    const row = await repo.upsert({
      user_id: USER,
      question_id: QUESTION,
      content_md: "agent 解读：标记与判据质量良好。",
      last_editor: "agent",
    });
    expect(row.last_editor).toBe("agent");
    const [sql, params] = (repo as any).queryOne.mock.calls[0];
    expect(sql).toContain("INSERT INTO l3_question_assessments");
    expect(sql).toContain("ON CONFLICT (user_id, question_id)");
    expect(sql).toContain("DO UPDATE SET content_md = EXCLUDED.content_md");
    expect(sql).toContain("last_editor = EXCLUDED.last_editor");
    expect(sql).toContain("updated_at = now()");
    expect(params).toEqual([USER, QUESTION, "agent 解读：标记与判据质量良好。", "agent"]);
  });

  it("upsert fails closed when the insert returns no row", async () => {
    const repo = new L3AssessmentRepository();
    vi.spyOn(repo as any, "queryOne").mockResolvedValue(null);
    await expect(repo.upsert({
      user_id: USER, question_id: QUESTION, content_md: "x", last_editor: "owner",
    })).rejects.toThrow("assessment upsert returned no row");
  });
});
