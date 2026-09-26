import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConflictError, NotFoundError, ValidationError } from "@/errors";
import type { L3PaperRow, L3QuestionRow, L3SourceRow } from "@/domain";
import type { IRepositories, IL3ContextRepository, IL3PaperRepository } from "@/repositories/interfaces";
import { L3PaperService } from "@/services/l3-paper.service";
import { PAPER_PAYLOAD_VERSION } from "@/domain/l3-question-types";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const SOURCE_ID = "00000000-0000-4000-8000-000000000002";

function questionRow(overrides: Partial<L3QuestionRow> = {}): L3QuestionRow {
  return {
    id: overrides.id ?? "00000000-0000-4000-8000-000000000101",
    user_id: USER_ID,
    source_id: null,
    file_key: null,
    space: "阅读",
    question_type: "reading_choice",
    ordinal: 0,
    stem: "题干",
    options: [{ key: "A", text: "选项 A" }],
    answer: { choice: "A" },
    explanation: null,
    evidence: [],
    status: "active",
    created_by: "owner",
    input_hash: null,
    created_at: "2026-09-16T00:00:00Z",
    updated_at: "2026-09-16T00:00:00Z",
    ...overrides,
  };
}

function makePaperRepo(overrides: Partial<IL3PaperRepository> = {}): IL3PaperRepository {
  return {
    insertQuestion: vi.fn(async (input) => questionRow({
      id: `q-${input.question_type}-${input.ordinal}`,
      space: input.space as L3QuestionRow["space"],
      question_type: input.question_type as L3QuestionRow["question_type"],
      source_id: input.source_id,
      file_key: input.file_key,
      ordinal: input.ordinal,
      stem: input.stem,
    })),
    findQuestionById: vi.fn(async () => questionRow()),
    updateQuestion: vi.fn(async () => questionRow()),
    countQuestionAttempts: vi.fn(async () => 0),
    findActiveQuestionsByIds: vi.fn(async () => []),
    listActiveQuestionsForFile: vi.fn(async () => []),
    listPracticeFiles: vi.fn(async () => ({ items: [], total: 0, limit: 50, offset: 0 })),
    deleteQuestion: vi.fn(async () => true),
    listActivePaperRefsWithPayload: vi.fn(async () => []),
    listWritingTaskRefs: vi.fn(async () => []),
    insertPaper: vi.fn(async (input) => ({
      id: "paper-1",
      user_id: USER_ID,
      title: input.title,
      direction: input.direction as L3PaperRow["direction"],
      metadata: input.metadata as L3PaperRow["metadata"],
      payload: input.payload as L3PaperRow["payload"],
      payload_version: input.payload_version,
      status: input.status as L3PaperRow["status"],
      created_by: "owner",
      input_hash: null,
      created_at: "2026-09-16T00:00:00Z",
      updated_at: "2026-09-16T00:00:00Z",
    })),
    findPaperById: vi.fn(async () => null),
    updatePaper: vi.fn(async () => null),
    listPapers: vi.fn(async () => ({ items: [], total: 0, limit: 50, offset: 0 })),
    ...overrides,
  };
}

function makeContextRepo(overrides: Partial<IL3ContextRepository> = {}): IL3ContextRepository {
  return {
    findSourceById: vi.fn(async () => ({
      id: SOURCE_ID,
      user_id: USER_ID,
      wordbook_id: null,
      source_type: "article",
      title: "2023 英语一 Text 1",
      author: null,
      url: null,
      language: null,
      metadata: {},
      content_text: null,
      content_hash: null,
      created_at: "2026-09-16T00:00:00Z",
      updated_at: "2026-09-16T00:00:00Z",
    })),
    ensureSourceSpaces: vi.fn(async () => undefined),
    replaceSourceSpaces: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as IL3ContextRepository;
}

/** 学习笔记引用向的窄 fake（N1）：默认无 blocker、lockTargets 空实现。 */
function makeStudyRefRepo(overrides: Record<string, unknown> = {}) {
  return {
    lockTargets: vi.fn(async () => undefined),
    getQuestionDeleteBlockers: vi.fn(async () => []),
    ...overrides,
  };
}

let studyRefRepo: Record<string, unknown>;

/** F1：deleteQuestion 的 FK 兜底需要事务连接可用（SAVEPOINT/ROLLBACK TO/RELEASE）。 */
function makeTx() {
  return { query: vi.fn(async () => ({})) } as never;
}

function makeService(
  paperRepo: IL3PaperRepository,
  contextRepo: IL3ContextRepository,
): L3PaperService {
  return new L3PaperService(
    paperRepo,
    contextRepo,
    async (callback) => callback(makeTx()),
    () => ({ l3Paper: paperRepo, l3Context: contextRepo, studyReferences: studyRefRepo } as unknown as IRepositories),
  );
}

/** 证据越界检查需要材料正文长度：就地造一个带 content_text 的 context 仓储。 */
function withContent(contentText: string): IL3ContextRepository {
  const base = makeContextRepo();
  return {
    ...base,
    findSourceById: vi.fn(async () => ({ ...(await base.findSourceById(USER_ID, SOURCE_ID))!, content_text: contentText })),
  } as IL3ContextRepository;
}

let paperRepo: IL3PaperRepository;
let contextRepo: IL3ContextRepository;
let service: L3PaperService;

beforeEach(() => {
  paperRepo = makePaperRepo();
  contextRepo = makeContextRepo();
  studyRefRepo = makeStudyRefRepo();
  service = makeService(paperRepo, contextRepo);
});

describe("updateQuestion（改题面 2026-09-26）", () => {
  const QUESTION_ID = "00000000-0000-4000-8000-000000000101";

  function body(overrides: Record<string, unknown> = {}) {
    return {
      userId: USER_ID,
      questionId: QUESTION_ID,
      stem: "  改过的题干  ",
      options: [{ key: "A", text: "选项 A" }],
      answer: { choice: "A" },
      explanation: "  因为原文如此  ",
      evidence: [] as Array<{ start: number; end: number; label: string }>,
      ...overrides,
    };
  }

  it("改成功：题干/解析 trim 后落库，input_hash 沿用原值", async () => {
    const updateQuestion = vi.fn(async () => questionRow({ id: QUESTION_ID, stem: "改过的题干" }));
    paperRepo = makePaperRepo({ updateQuestion: updateQuestion as never });
    service = makeService(paperRepo, contextRepo);

    const { question } = await service.updateQuestion(body());
    expect(question.stem).toBe("改过的题干");
    const call = (updateQuestion.mock.calls as unknown as Array<[Record<string, unknown>]>)[0]![0];
    expect(call.stem).toBe("改过的题干");
    expect(call.explanation).toBe("因为原文如此");
    expect(call.input_hash).toBeNull(); // 原行沿用，不换身份指纹
  });

  it("护栏①：已有作答历史 → 409（答案历史不可改写），且不写库", async () => {
    const updateQuestion = vi.fn(async () => questionRow());
    paperRepo = makePaperRepo({
      findQuestionById: vi.fn(async () => questionRow({ id: QUESTION_ID })),
      countQuestionAttempts: vi.fn(async () => 3),
      updateQuestion: updateQuestion as never,
    });
    service = makeService(paperRepo, contextRepo);

    await expect(service.updateQuestion(body())).rejects.toBeInstanceOf(ConflictError);
    expect(updateQuestion).not.toHaveBeenCalled();
  });

  it("护栏②：被作文任务引用 → 409（题面冻结 = 新任务）", async () => {
    const updateQuestion = vi.fn(async () => questionRow());
    paperRepo = makePaperRepo({
      findQuestionById: vi.fn(async () => questionRow({ id: QUESTION_ID })),
      listWritingTaskRefs: vi.fn(async () => [{ id: "t-1", title: "大作文 2019" }]),
      updateQuestion: updateQuestion as never,
    });
    service = makeService(paperRepo, contextRepo);

    await expect(service.updateQuestion(body())).rejects.toBeInstanceOf(ConflictError);
    expect(updateQuestion).not.toHaveBeenCalled();
  });

  it("护栏③：被学习笔记引用**不**拦（field_hash → changed 机制正是为此存在）", async () => {
    const updateQuestion = vi.fn(async () => questionRow({ id: QUESTION_ID }));
    paperRepo = makePaperRepo({
      findQuestionById: vi.fn(async () => questionRow({ id: QUESTION_ID })),
      getQuestionDeleteBlockers: vi.fn(async () => [{ note_id: "n-1", title: "阅读笔记", status: "active", reference_count: 1 }]),
      updateQuestion: updateQuestion as never,
    } as never);
    studyRefRepo = makeStudyRefRepo({
      getQuestionDeleteBlockers: vi.fn(async () => [{ note_id: "n-1", title: "阅读笔记", status: "active", reference_count: 1 }]),
    });
    service = makeService(paperRepo, contextRepo);

    await expect(service.updateQuestion(body())).resolves.toBeTruthy();
    expect(updateQuestion).toHaveBeenCalledTimes(1);
  });

  it("非 active 题 → 409（不给改 pending/rejected 的题）", async () => {
    paperRepo = makePaperRepo({
      findQuestionById: vi.fn(async () => questionRow({ id: QUESTION_ID, status: "pending" })),
    });
    service = makeService(paperRepo, contextRepo);
    await expect(service.updateQuestion(body())).rejects.toBeInstanceOf(ConflictError);
  });

  it("404：题不存在或非属主", async () => {
    paperRepo = makePaperRepo({ findQuestionById: vi.fn(async () => null) });
    service = makeService(paperRepo, contextRepo);
    await expect(service.updateQuestion(body())).rejects.toBeInstanceOf(NotFoundError);
  });

  it("证据越界 → 422 并带出正文长度（不静默丢弃用户填的锚点）", async () => {
    paperRepo = makePaperRepo({
      findQuestionById: vi.fn(async () => questionRow({ id: QUESTION_ID, source_id: SOURCE_ID })),
      updateQuestion: vi.fn(async () => questionRow()),
    });
    contextRepo = withContent("短正文");
    service = makeService(paperRepo, contextRepo);

    await expect(service.updateQuestion(body({
      evidence: [{ start: 0, end: 9999, label: "官方证据" }],
    }))).rejects.toBeInstanceOf(ValidationError);
  });

  it("证据合法 → 放行；畸形锚点被归一剔除（end<=start / 负 start / 空 label）", async () => {
    const updateQuestion = vi.fn(async () => questionRow({ id: QUESTION_ID }));
    paperRepo = makePaperRepo({
      findQuestionById: vi.fn(async () => questionRow({ id: QUESTION_ID, source_id: SOURCE_ID })),
      updateQuestion: updateQuestion as never,
    });
    contextRepo = withContent("0123456789");
    service = makeService(paperRepo, contextRepo);

    await service.updateQuestion(body({
      evidence: [
        { start: 0, end: 4, label: " 证据A " },
        { start: 0, end: 4, label: "证据A" }, // 去重
        { start: 5, end: 5, label: "空区间" },  // end<=start → 剔除
        { start: -1, end: 3, label: "负起点" }, // 负 start → 剔除
        { start: 2, end: 6, label: "  " },      // 空 label → 剔除
      ],
    }));
    const call = (updateQuestion.mock.calls as unknown as Array<[{ evidence: unknown }]>)[0]![0];
    expect(call.evidence).toEqual([{ start: 0, end: 4, label: "证据A" }]);
  });

  it("条件 UPDATE 落空 → 二次判别（并发下状态已变）", async () => {
    paperRepo = makePaperRepo({
      findQuestionById: vi.fn(async () => questionRow({ id: QUESTION_ID, status: "pending" })),
      updateQuestion: vi.fn(async () => null),
    });
    service = makeService(paperRepo, contextRepo);
    await expect(service.updateQuestion(body())).rejects.toBeInstanceOf(ConflictError);
  });

  it("stem 必填（空题干 → 422）", async () => {
    service = makeService(paperRepo, contextRepo);
    await expect(service.updateQuestion(body({ stem: "   " }))).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("updatePaper（改卷 2026-09-26）", () => {
  const PAPER_ID = "00000000-0000-4000-8000-000000000201";
  const Q1 = "00000000-0000-4000-8000-000000000101";
  const Q2 = "00000000-0000-4000-8000-000000000102";

  function paperRow(overrides: Record<string, unknown> = {}) {
    return {
      id: PAPER_ID,
      user_id: USER_ID,
      title: "2023 模拟卷",
      direction: "考研",
      metadata: {},
      payload: { version: 1, sections: [] },
      payload_version: 1,
      status: "active",
      created_by: "owner",
      input_hash: null,
      created_at: "2026-09-16T00:00:00Z",
      updated_at: "2026-09-16T00:00:00Z",
      ...overrides,
    };
  }

  function body(overrides: Record<string, unknown> = {}) {
    return {
      userId: USER_ID,
      paperId: PAPER_ID,
      title: "  2023 模拟卷（修订）  ",
      direction: "考研" as const,
      sections: [
        { key: "s1", title: "Text 2", questionType: "reading_choice" as const, sourceId: SOURCE_ID, questionIds: [Q1, Q2] },
      ],
      ...overrides,
    };
  }

  function withPaper(overrides: Partial<IL3PaperRepository> = {}) {
    paperRepo = makePaperRepo({
      findPaperById: vi.fn(async () => paperRow() as never),
      findActiveQuestionsByIds: vi.fn(async () => [questionRow({ id: Q1 }), questionRow({ id: Q2 })] as never),
      updatePaper: vi.fn(async () => paperRow({ title: "2023 模拟卷（修订）" }) as never),
      ...overrides,
    });
    service = makeService(paperRepo, contextRepo);
  }

  it("改成功：题单引用可换（把一道题从卷里拿掉），标题 trim", async () => {
    withPaper();
    const { paper } = await service.updatePaper(body());
    expect(paper.title).toBe("2023 模拟卷（修订）");
    const call = (paperRepo.updatePaper as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { payload: { sections: Array<{ questionIds: string[] }> } };
    expect(call.payload.sections[0]!.questionIds).toEqual([Q1, Q2]);
  });

  it("引用了不属主/非 active 的题 → 422（别人的题 id 猜到也塞不进来）", async () => {
    withPaper({ findActiveQuestionsByIds: vi.fn(async () => [questionRow({ id: Q1 })] as never) });
    await expect(service.updatePaper(body())).rejects.toBeInstanceOf(ValidationError);
  });

  it("空 sections → 422（卷不能没有 section）", async () => {
    withPaper();
    await expect(service.updatePaper(body({ sections: [] }))).rejects.toBeInstanceOf(ValidationError);
  });

  it("非 active 卷 → 409", async () => {
    withPaper({ findPaperById: vi.fn(async () => paperRow({ status: "archived" }) as never) });
    await expect(service.updatePaper(body())).rejects.toBeInstanceOf(ConflictError);
  });

  it("404：卷不存在或非属主", async () => {
    withPaper({ findPaperById: vi.fn(async () => null) as never });
    await expect(service.updatePaper(body())).rejects.toBeInstanceOf(NotFoundError);
  });

  it("条件 UPDATE 落空 → 二次判别", async () => {
    withPaper({
      findPaperById: vi.fn(async () => paperRow({ status: "archived" }) as never),
      updatePaper: vi.fn(async () => null) as never,
    });
    await expect(service.updatePaper(body())).rejects.toBeInstanceOf(ConflictError);
  });
});

describe("createPaper", () => {
  it("creates questions in one transaction, assembles the v1 payload and auto-tags sources", async () => {
    const result = await service.createPaper({
      userId: USER_ID,
      title: "2023 英语一真题",
      direction: "考研",
      sections: [
        {
          title: "Text 1",
          questionType: "reading_choice",
          sourceId: SOURCE_ID,
          questions: [
            { stem: "第 21 题", options: [{ key: "A", text: "甲" }], answer: { choice: "A" } },
            { stem: "第 22 题" },
          ],
        },
        {
          title: "Part C 翻译",
          questionType: "sentence_translation",
          fileKey: "trans-2023-1",
          questions: [{ stem: "46) 划线句…" }],
        },
      ],
    });

    expect(result.questionCount).toBe(3);
    expect(paperRepo.insertQuestion).toHaveBeenCalledTimes(3);
    const inserted = vi.mocked(paperRepo.insertQuestion).mock.calls;
    expect(inserted[0][0]).toMatchObject({
      source_id: SOURCE_ID,
      file_key: null,
      space: "阅读",
      question_type: "reading_choice",
      ordinal: 0,
    });
    expect(inserted[2][0]).toMatchObject({
      source_id: null,
      file_key: "trans-2023-1",
      space: "翻译",
      question_type: "sentence_translation",
    });

    expect(paperRepo.insertPaper).toHaveBeenCalledTimes(1);
    const paperInput = vi.mocked(paperRepo.insertPaper).mock.calls[0][0];
    expect(paperInput.payload_version).toBe(PAPER_PAYLOAD_VERSION);
    expect(paperInput.status).toBe("active");
    const payload = paperInput.payload as { version: number; sections: unknown[] };
    expect(payload).toEqual({
      version: 1,
      sections: [
        {
          key: "s1",
          title: "Text 1",
          questionType: "reading_choice",
          sourceId: SOURCE_ID,
          fileKey: null,
          questionIds: ["q-reading_choice-0", "q-reading_choice-1"],
        },
        {
          key: "s2",
          title: "Part C 翻译",
          questionType: "sentence_translation",
          sourceId: null,
          fileKey: "trans-2023-1",
          questionIds: ["q-sentence_translation-0"],
        },
      ],
    });
    expect(contextRepo.ensureSourceSpaces).toHaveBeenCalledWith(USER_ID, SOURCE_ID, ["阅读"]);
  });

  it("rejects reading-type sections without a source and sourceless sections without fileKey", async () => {
    await expect(service.createPaper({
      userId: USER_ID,
      title: "坏卷",
      sections: [{ title: "Text 1", questionType: "reading_choice", questions: [{ stem: "x" }] }],
    })).rejects.toBeInstanceOf(ValidationError);
    expect(paperRepo.insertQuestion).not.toHaveBeenCalled();

    await expect(service.createPaper({
      userId: USER_ID,
      title: "坏卷",
      sections: [{ title: "翻译", questionType: "sentence_translation", questions: [{ stem: "x" }] }],
    })).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects unknown question types, empty sections and non-owned sources", async () => {
    const foreignContext = makeContextRepo({ findSourceById: vi.fn(async () => null) });
    const foreignService = makeService(paperRepo, foreignContext);
    await expect(foreignService.createPaper({
      userId: USER_ID,
      title: "挂他人材料",
      sections: [{
        title: "Text 1", questionType: "reading_choice", sourceId: SOURCE_ID,
        questions: [{ stem: "x" }],
      }],
    })).rejects.toBeInstanceOf(NotFoundError);
    expect(paperRepo.insertQuestion).not.toHaveBeenCalled();

    await expect(service.createPaper({
      userId: USER_ID, title: "空卷", sections: [],
    })).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("createQuestion", () => {
  it("inserts a sourceless essay question into a file_key group", async () => {
    await service.createQuestion({
      userId: USER_ID,
      questionType: "long_essay",
      fileKey: "essay-2023",
      stem: "图画作文题面",
    });
    expect(paperRepo.insertQuestion).toHaveBeenCalledWith(expect.objectContaining({
      source_id: null,
      file_key: "essay-2023",
      space: "作文",
    }));
    expect(contextRepo.ensureSourceSpaces).not.toHaveBeenCalled();
  });

  it("requires a source for reading questions and 404s on non-owned sources", async () => {
    await expect(service.createQuestion({
      userId: USER_ID,
      questionType: "cloze",
      stem: "第 1 空",
    })).rejects.toBeInstanceOf(ValidationError);

    const foreignContext = makeContextRepo({ findSourceById: vi.fn(async () => null) });
    const foreignService = makeService(paperRepo, foreignContext);
    await expect(foreignService.createQuestion({
      userId: USER_ID,
      questionType: "cloze",
      sourceId: SOURCE_ID,
      stem: "第 1 空",
    })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("tags the source space when the question hangs off a source", async () => {
    await service.createQuestion({
      userId: USER_ID,
      questionType: "grammar_blank",
      sourceId: SOURCE_ID,
      stem: "语法填空",
    });
    expect(paperRepo.insertQuestion).toHaveBeenCalledWith(expect.objectContaining({
      source_id: SOURCE_ID,
      space: "语法",
    }));
    expect(contextRepo.ensureSourceSpaces).toHaveBeenCalledWith(USER_ID, SOURCE_ID, ["语法"]);
  });
});

describe("deleteQuestion", () => {
  it("404s when the question does not exist", async () => {
    const repo = makePaperRepo({ findQuestionById: vi.fn(async () => null) });
    await expect(makeService(repo, contextRepo).deleteQuestion({
      userId: USER_ID, questionId: "q-missing",
    })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("blocks deletion with a localized paper blocker list when referenced by an active paper", async () => {
    const qid = "00000000-0000-4000-8000-000000000201";
    const repo = makePaperRepo({
      findQuestionById: vi.fn(async () => questionRow({ id: qid })),
      listActivePaperRefsWithPayload: vi.fn(async () => [{
        id: "paper-9",
        title: "2023 英语一",
        payload: { version: 1, sections: [{ key: "s1", questionIds: [qid] }] },
      }]),
    });
    await expect(makeService(repo, contextRepo).deleteQuestion({
      userId: USER_ID, questionId: qid,
    })).rejects.toBeInstanceOf(ConflictError);
    expect(repo.deleteQuestion).not.toHaveBeenCalled();
  });

  it("blocks deletion with a writing-task blocker when referenced by an active writing task", async () => {
    const qid = "00000000-0000-4000-8000-000000000301";
    const repo = makePaperRepo({
      findQuestionById: vi.fn(async () => questionRow({ id: qid })),
      listWritingTaskRefs: vi.fn(async () => [{ id: "wt-1", title: "我的写作任务" }]),
    });
    await expect(makeService(repo, contextRepo).deleteQuestion({
      userId: USER_ID, questionId: qid,
    })).rejects.toMatchObject({
      httpStatus: 409,
      meta: { blockers: { writingTasks: [{ id: "wt-1", title: "我的写作任务" }] } },
    });
    expect(repo.deleteQuestion).not.toHaveBeenCalled();
  });

  it("blocks deletion with a study-note blocker when referenced by a learning note (N1)，并先取 capture 同款 advisory 锁", async () => {
    const qid = "00000000-0000-4000-8000-000000000401";
    const repo = makePaperRepo({ findQuestionById: vi.fn(async () => questionRow({ id: qid })) });
    studyRefRepo = makeStudyRefRepo({
      getQuestionDeleteBlockers: vi.fn(async () => [
        { note_id: "note-1", title: "我的学习笔记", status: "active", reference_count: 2 },
      ]),
    });
    await expect(makeService(repo, contextRepo).deleteQuestion({
      userId: USER_ID, questionId: qid,
    })).rejects.toMatchObject({
      httpStatus: 409,
      meta: {
        blockers: {
          studyNotes: [{ id: "note-1", title: "我的学习笔记", status: "active", referenceCount: 2 }],
        },
      },
    });
    expect(studyRefRepo.lockTargets).toHaveBeenCalledWith(USER_ID, [{ kind: "question", id: qid }]);
    expect(repo.deleteQuestion).not.toHaveBeenCalled();
  });

  it("FK RESTRICT 并发兜底：删除报 23503 → 重查 blocker 转 409；无 blocker 原样透传", async () => {
    const qid = "00000000-0000-4000-8000-000000000402";
    const repo = makePaperRepo({
      findQuestionById: vi.fn(async () => questionRow({ id: qid })),
      deleteQuestion: vi.fn(async () => {
        throw Object.assign(new Error("fk violation"), { code: "23503" });
      }),
    });
    studyRefRepo = makeStudyRefRepo({
      getQuestionDeleteBlockers: vi.fn(async () => [
        { note_id: "note-3", title: "题笔记", status: "active", reference_count: 1 },
      ]),
    });
    await expect(makeService(repo, contextRepo).deleteQuestion({
      userId: USER_ID, questionId: qid,
    })).rejects.toMatchObject({
      httpStatus: 409,
      meta: { blockers: { studyNotes: [expect.objectContaining({ id: "note-3" })] } },
    });

    studyRefRepo = makeStudyRefRepo({ getQuestionDeleteBlockers: vi.fn(async () => []) });
    await expect(makeService(repo, contextRepo).deleteQuestion({
      userId: USER_ID, questionId: qid,
    })).rejects.toThrow("fk violation");
  });

  it("F1：DELETE 报 23503 后先回滚保存点再重查 blocker（顺序留证；不落 25P02）", async () => {
    const qid = "00000000-0000-4000-8000-000000000413";
    let poisoned = false;
    let blockerCalls = 0;
    const events: string[] = [];
    const tx = {
      query: vi.fn(async (sql: string) => {
        const text = String(sql);
        events.push(`tx:${text}`);
        if (text.trim().toUpperCase().startsWith("ROLLBACK TO SAVEPOINT")) poisoned = false;
        return {};
      }),
    };
    const txRunner = (async (cb: (t: unknown) => Promise<unknown>) => cb(tx)) as never;
    const repo = makePaperRepo({
      findQuestionById: vi.fn(async () => questionRow({ id: qid })),
      deleteQuestion: vi.fn(async () => {
        poisoned = true; // 模拟真实 PG：FK 异常中止当前事务
        throw Object.assign(new Error("fk violation"), { code: "23503" });
      }),
    });
    studyRefRepo = makeStudyRefRepo({
      getQuestionDeleteBlockers: vi.fn(async () => {
        events.push("blocker-query");
        if (poisoned) throw Object.assign(new Error("current transaction is aborted"), { code: "25P02" });
        blockerCalls += 1;
        // 预检查（第 1 次）：并发引用尚不可见 → 空；恢复后重查（第 2 次）：命中真实 blocker
        return blockerCalls === 1
          ? []
          : [{ note_id: "note-3", title: "题笔记", status: "active", reference_count: 1 }];
      }),
    });
    const service = new L3PaperService(
      repo,
      contextRepo,
      txRunner,
      () => ({ l3Paper: repo, l3Context: contextRepo, studyReferences: studyRefRepo } as unknown as IRepositories),
    );

    await expect(service.deleteQuestion({ userId: USER_ID, questionId: qid })).rejects.toMatchObject({
      httpStatus: 409,
      meta: { blockers: { studyNotes: [expect.objectContaining({ id: "note-3" })] } },
    });
    expect(events).toContain("tx:SAVEPOINT study_note_delete");
    expect(events).toContain("tx:RELEASE SAVEPOINT study_note_delete");
    expect(events.indexOf("tx:ROLLBACK TO SAVEPOINT study_note_delete"))
      .toBeLessThan(events.lastIndexOf("blocker-query"));
    expect(events.lastIndexOf("blocker-query"))
      .toBeGreaterThan(events.indexOf("tx:RELEASE SAVEPOINT study_note_delete"));
  });

  it("F1：无 blocker 的原错误透传路径同样先恢复保存点（不伪造笔记阻塞）", async () => {
    const qid = "00000000-0000-4000-8000-000000000414";
    let poisoned = false;
    const events: string[] = [];
    const tx = {
      query: vi.fn(async (sql: string) => {
        const text = String(sql);
        events.push(`tx:${text}`);
        if (text.trim().toUpperCase().startsWith("ROLLBACK TO SAVEPOINT")) poisoned = false;
        return {};
      }),
    };
    const txRunner = (async (cb: (t: unknown) => Promise<unknown>) => cb(tx)) as never;
    const repo = makePaperRepo({
      findQuestionById: vi.fn(async () => questionRow({ id: qid })),
      deleteQuestion: vi.fn(async () => {
        poisoned = true;
        throw Object.assign(new Error("fk violation"), { code: "23503" });
      }),
    });
    studyRefRepo = makeStudyRefRepo({
      getQuestionDeleteBlockers: vi.fn(async () => {
        if (poisoned) throw Object.assign(new Error("current transaction is aborted"), { code: "25P02" });
        return [];
      }),
    });
    const service = new L3PaperService(
      repo,
      contextRepo,
      txRunner,
      () => ({ l3Paper: repo, l3Context: contextRepo, studyReferences: studyRefRepo } as unknown as IRepositories),
    );

    await expect(service.deleteQuestion({ userId: USER_ID, questionId: qid }))
      .rejects.toThrow("fk violation");
    expect(events).toContain("tx:ROLLBACK TO SAVEPOINT study_note_delete");
  });

  it("deletes an unreferenced question", async () => {
    await service.deleteQuestion({
      userId: USER_ID, questionId: "00000000-0000-4000-8000-000000000101",
    });
    expect(paperRepo.deleteQuestion).toHaveBeenCalledWith(
      USER_ID, "00000000-0000-4000-8000-000000000101",
    );
  });
});

describe("getPaper assembly degradation", () => {
  const buildPaperRow = (sections: L3PaperRow["payload"]["sections"]): L3PaperRow => ({
    id: "paper-1",
    user_id: USER_ID,
    title: "2023 英语一",
    direction: "考研",
    metadata: {},
    payload: { version: PAPER_PAYLOAD_VERSION, sections },
    payload_version: 1,
    status: "active",
    created_by: "owner",
    input_hash: null,
    created_at: "2026-09-16T00:00:00Z",
    updated_at: "2026-09-16T00:00:00Z",
  });

  it("marks a section missing when its source vanished but keeps other sections", async () => {
    const q1 = questionRow({ id: "q1" });
    const paper = buildPaperRow([
      {
        key: "s1", title: "Text 1", questionType: "reading_choice",
        sourceId: SOURCE_ID, fileKey: null, questionIds: ["q1"],
      },
      {
        key: "s2", title: "Text 2", questionType: "reading_choice",
        sourceId: "00000000-0000-4000-8000-000000000099", fileKey: null, questionIds: ["q2"],
      },
    ]);
    const repo = makePaperRepo({
      findPaperById: vi.fn(async () => paper),
      findActiveQuestionsByIds: vi.fn(async () => [q1]),
    });
    // 仅 SOURCE_ID 归属本用户：第二个 section 引用的材料已删除 → source 降级。
    const scopedSource: L3SourceRow = {
      id: SOURCE_ID,
      user_id: USER_ID,
      wordbook_id: null,
      source_type: "article",
      title: "2023 英语一 Text 1",
      author: null,
      url: null,
      language: null,
      metadata: {},
      content_text: null,
      content_hash: null,
      created_at: "2026-09-16T00:00:00Z",
      updated_at: "2026-09-16T00:00:00Z",
    };
    const scopedContext = makeContextRepo({
      findSourceById: vi.fn(async (_userId: string, id: string) =>
        id === SOURCE_ID ? scopedSource : null),
    });
    const detail = await makeService(repo, scopedContext).getPaper(USER_ID, "paper-1");
    expect(detail.sections[0].missing).toBe(false);
    expect(detail.sections[0].questions).toHaveLength(1);
    expect(detail.sections[0].source_title).toBe("2023 英语一 Text 1");
    expect(detail.sections[1]).toMatchObject({ missing: true, missing_reason: "source" });
  });

  it("marks a section missing when referenced questions vanish, preserving payload order", async () => {
    const q1 = questionRow({ id: "q1" });
    const paper = buildPaperRow([
      {
        key: "s1", title: "Text 1", questionType: "reading_choice",
        sourceId: SOURCE_ID, fileKey: null, questionIds: ["q1", "q-gone"],
      },
    ]);
    const repo = makePaperRepo({
      findPaperById: vi.fn(async () => paper),
      findActiveQuestionsByIds: vi.fn(async () => [q1]),
    });
    const detail = await makeService(repo, contextRepo).getPaper(USER_ID, "paper-1");
    expect(detail.sections[0]).toMatchObject({ missing: true, missing_reason: "questions" });
    expect(detail.sections[0].questions.map((q) => q.id)).toEqual(["q1"]);
  });

  it("404s for an unknown paper", async () => {
    await expect(service.getPaper(USER_ID, "nope")).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("getPracticeFile（file venue 数据源）", () => {
  it("透传 source 正文（做题表面文栏渲染所需）", async () => {
    const repo = makePaperRepo({ listActiveQuestionsForFile: vi.fn(async () => [questionRow()]) });
    const withText = makeContextRepo({
      findSourceById: vi.fn(async () => ({
        id: SOURCE_ID,
        user_id: USER_ID,
        wordbook_id: null,
        source_type: "article" as const,
        title: "2025 英语二 · Text 1 小费文化",
        author: null,
        url: null,
        language: null,
        metadata: {},
        content_text: "The passage.",
        content_hash: null,
        created_at: "2026-09-16T00:00:00Z",
        updated_at: "2026-09-16T00:00:00Z",
      })),
    });
    const detail = await makeService(repo, withText).getPracticeFile({
      userId: USER_ID,
      questionType: "reading_choice",
      sourceId: SOURCE_ID,
    });
    expect(detail.source).toEqual({ id: SOURCE_ID, title: "2025 英语二 · Text 1 小费文化" });
    expect(detail.source_content).toBe("The passage.");
    expect(detail.questions).toHaveLength(1);
    expect(detail.file_key).toBeNull();
  });

  it("fileKey 型文件（无 source）返回 source_content: null 与题组键", async () => {
    const repo = makePaperRepo({ listActiveQuestionsForFile: vi.fn(async () => [questionRow()]) });
    const detail = await makeService(repo, contextRepo).getPracticeFile({
      userId: USER_ID,
      questionType: "sentence_translation",
      fileKey: "translation-group-1",
    });
    expect(detail.source).toBeNull();
    expect(detail.source_content).toBeNull();
    expect(detail.file_key).toBe("translation-group-1");
    expect(detail.questions).toHaveLength(1);
  });
});
