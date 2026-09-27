import { describe, expect, it, vi } from "vitest";
import { NotFoundError } from "@/errors";
import type { L3QuestionAssessmentRow, L3QuestionRow } from "@/domain";
import type { IRepositories, IL3AssessmentRepository, IL3PaperRepository } from "@/repositories/interfaces";
import { L3AssessmentService } from "@/services/l3-assessments.service";

const USER = "00000000-0000-4000-8000-000000000001";
const QUESTION = "00000000-0000-4000-8000-000000000101";

function assessmentRow(overrides: Partial<L3QuestionAssessmentRow> = {}): L3QuestionAssessmentRow {
  return {
    id: "00000000-0000-4000-8000-000000000701",
    user_id: USER,
    question_id: QUESTION,
    content_md: "判据梳理正文",
    last_editor: "owner",
    created_at: "2026-09-17T00:00:00Z",
    updated_at: "2026-09-17T00:00:00Z",
    ...overrides,
  };
}

function questionRow(): L3QuestionRow {
  return {
    id: QUESTION,
    user_id: USER,
    source_id: null,
    file_key: "file-1",
    space: "阅读",
    question_type: "reading_choice",
    ordinal: 0,
    stem: "题干",
    options: [],
    answer: {},
    explanation: null,
    evidence: [],
    status: "active",
    created_by: "owner",
    input_hash: null,
    created_at: "2026-09-16T00:00:00Z",
    updated_at: "2026-09-16T00:00:00Z",
  };
}

function makeRepo(overrides: Partial<IL3AssessmentRepository> = {}): IL3AssessmentRepository {
  return {
    findByQuestion: vi.fn(async () => null),
    listByQuestions: vi.fn(async () => []),
    upsert: vi.fn(async () => assessmentRow()),
    ...overrides,
  };
}

function makePaperRepo(question: L3QuestionRow | null): IL3PaperRepository {
  return { findQuestionById: vi.fn(async () => question) } as unknown as IL3PaperRepository;
}

function makeService(
  repo: IL3AssessmentRepository,
  paperRepo: IL3PaperRepository,
): L3AssessmentService {
  return new L3AssessmentService(
    repo,
    paperRepo,
    async (callback) => callback({} as never),
    () => ({ l3Assessments: repo, l3Paper: paperRepo } as unknown as IRepositories),
  );
}

describe("L3AssessmentService", () => {
  it("getAssessment returns the 空态 item:null when no row exists", async () => {
    const service = makeService(makeRepo(), makePaperRepo(questionRow()));
    await expect(service.getAssessment(USER, QUESTION)).resolves.toEqual({ item: null });
  });

  it("getAssessment returns the existing row", async () => {
    const row = assessmentRow({ last_editor: "agent" });
    const service = makeService(makeRepo({ findByQuestion: vi.fn(async () => row) }), makePaperRepo(questionRow()));
    await expect(service.getAssessment(USER, QUESTION)).resolves.toEqual({ item: row });
  });

  it("404s when the question is missing/not owned", async () => {
    const service = makeService(makeRepo(), makePaperRepo(null));
    await expect(service.getAssessment(USER, QUESTION)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("putAssessment upserts with the actor editor and returns the row", async () => {
    const repo = makeRepo({ upsert: vi.fn(async () => assessmentRow({ last_editor: "owner" })) });
    const service = makeService(repo, makePaperRepo(questionRow()));
    const result = await service.putAssessment({
      userId: USER, questionId: QUESTION, contentMd: "owner 写的评析", editor: "owner",
    });
    expect(result.item.last_editor).toBe("owner");
    expect(repo.upsert).toHaveBeenCalledWith({
      user_id: USER, question_id: QUESTION, content_md: "owner 写的评析", last_editor: "owner",
    });
  });

  it("putAssessment records last_editor=agent when an agent overwrites（留痕覆写）", async () => {
    const repo = makeRepo({
      findByQuestion: vi.fn(async () => assessmentRow({ last_editor: "owner" })),
      upsert: vi.fn(async () => assessmentRow({ last_editor: "agent", content_md: "agent 覆写" })),
    });
    const service = makeService(repo, makePaperRepo(questionRow()));
    const result = await service.putAssessment({
      userId: USER, questionId: QUESTION, contentMd: "agent 覆写", editor: "agent",
    });
    expect(result.item.last_editor).toBe("agent");
    expect(repo.upsert).toHaveBeenCalledWith(expect.objectContaining({ last_editor: "agent" }));
  });

  it("404s putAssessment when the question is missing/not owned", async () => {
    const repo = makeRepo();
    const service = makeService(repo, makePaperRepo(null));
    await expect(service.putAssessment({
      userId: USER, questionId: QUESTION, contentMd: "x", editor: "owner",
    })).rejects.toBeInstanceOf(NotFoundError);
    expect(repo.upsert).not.toHaveBeenCalled();
  });

  describe("listForQuestions（批量 · 2026-09-27）", () => {
    const Q2 = "00000000-0000-4000-8000-000000000102";

    it("scopes the read to the actor and returns the rows", async () => {
      const rows = [assessmentRow(), assessmentRow({ id: "00000000-0000-4000-8000-000000000702", question_id: Q2 })];
      const repo = makeRepo({ listByQuestions: vi.fn(async () => rows) });
      const service = makeService(repo, makePaperRepo(questionRow()));
      await expect(service.listForQuestions(USER, [QUESTION, Q2])).resolves.toEqual({ items: rows });
      expect(repo.listByQuestions).toHaveBeenCalledWith(USER, [QUESTION, Q2]);
    });

    it("de-dupes ids before querying（同一题在卷面里出现两次也只问一次）", async () => {
      const repo = makeRepo();
      const service = makeService(repo, makePaperRepo(questionRow()));
      await service.listForQuestions(USER, [QUESTION, QUESTION, Q2]);
      expect(repo.listByQuestions).toHaveBeenCalledWith(USER, [QUESTION, Q2]);
    });

    it("short-circuits an empty batch without a query（不为了空数组打一次库）", async () => {
      const repo = makeRepo();
      const service = makeService(repo, makePaperRepo(questionRow()));
      await expect(service.listForQuestions(USER, [])).resolves.toEqual({ items: [] });
      expect(repo.listByQuestions).not.toHaveBeenCalled();
    });

    it("caps the batch at 200 ids（schema 之外的第二道兜底）", async () => {
      const repo = makeRepo();
      const service = makeService(repo, makePaperRepo(questionRow()));
      const many = Array.from({ length: 250 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
      await service.listForQuestions(USER, many);
      expect((repo.listByQuestions as ReturnType<typeof vi.fn>).mock.calls[0][1]).toHaveLength(200);
    });

    it("does not 404 on unknown questions（批量语义：只返回读到的）", async () => {
      const repo = makeRepo({ listByQuestions: vi.fn(async () => []) });
      const service = makeService(repo, makePaperRepo(null));
      await expect(service.listForQuestions(USER, [QUESTION])).resolves.toEqual({ items: [] });
    });
  });
});
