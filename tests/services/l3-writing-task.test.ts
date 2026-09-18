/**
 * L3WritingTaskService 单元测试（注入 in-memory 假 repo，无真实 DB）。
 * 覆盖：幂等重放 / 并发唯一冲突重读 / 直接开始内部题 / 选题校验与复用 /
 * 归档 409 / 恢复不建稿 / 列表 keyset 分页与 q 转义 + 单 owner 作用域。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { ConflictError, NotFoundError, ValidationError } from "@/errors";
import type { IL3PaperRepository } from "@/repositories/interfaces";
import type { IL3WritingRepository } from "@/repositories/l3-writing.repository";
import type { L3WritingTaskRow } from "@/repositories/l3-writing.types";
import type {
  L3QuestionRow,
  L3SubmissionRow,
  WritingDirection,
  WritingKind,
} from "@/domain";
import {
  L3WritingTaskService,
  type WritingRepos,
} from "@/services/l3-writing-task.service";
import type { WritingTaskCreateInput } from "@/domain/l3-writing";

const OWNER_A = "00000000-0000-4000-8000-0000000000a1";
const OWNER_B = "00000000-0000-4000-8000-0000000000b2";

function nowIso(offsetMs = 0): string {
  return new Date(Date.UTC(2026, 8, 18, 0, 0, 0) + offsetMs).toISOString();
}

function questionRow(overrides: Partial<L3QuestionRow> = {}): L3QuestionRow {
  return {
    id: overrides.id ?? randomUUID(),
    user_id: OWNER_A,
    source_id: null,
    file_key: null,
    space: "作文",
    question_type: "long_essay",
    ordinal: 0,
    stem: "题面",
    options: [],
    answer: {},
    explanation: null,
    evidence: [],
    status: "active",
    created_by: "owner",
    input_hash: null,
    created_at: nowIso(),
    updated_at: nowIso(),
    ...overrides,
  };
}

class FakePaperRepository {
  constructor(private readonly questions: Map<string, L3QuestionRow>) {}

  async insertQuestion(input: Parameters<IL3PaperRepository["insertQuestion"]>[0]): Promise<L3QuestionRow> {
    const row = questionRow({
      id: randomUUID(),
      user_id: input.user_id,
      source_id: input.source_id,
      file_key: input.file_key,
      space: input.space as L3QuestionRow["space"],
      question_type: input.question_type as L3QuestionRow["question_type"],
      ordinal: input.ordinal,
      stem: input.stem,
      options: (input.options as unknown as L3QuestionRow["options"]) ?? [],
      answer: (input.answer as L3QuestionRow["answer"]) ?? {},
      explanation: input.explanation ?? null,
      evidence: (input.evidence as unknown as L3QuestionRow["evidence"]) ?? [],
      status: (input.status as L3QuestionRow["status"]) ?? "active",
      created_by: input.created_by ?? "owner",
      input_hash: input.input_hash ?? null,
    });
    this.questions.set(row.id, row);
    return row;
  }

  async findQuestionById(userId: string, questionId: string): Promise<L3QuestionRow | null> {
    const q = this.questions.get(questionId);
    if (!q || q.user_id !== userId) return null;
    return q;
  }
}

class FakeWritingRepository implements IL3WritingRepository {
  private tasks = new Map<string, L3WritingTaskRow>();
  private submissions = new Map<string, L3SubmissionRow>();
  /** 并发竞态模拟：这些 requestId 在首次 findTaskByRequestId 时被隐藏（视为检查后才提交）。 */
  readonly raceHidden = new Set<string>();

  constructor(private readonly questions: Map<string, L3QuestionRow>) {}

  get taskCount(): number { return this.tasks.size; }

  async insertTask(input: Parameters<IL3WritingRepository["insertTask"]>[0]): Promise<L3WritingTaskRow> {
    for (const t of this.tasks.values()) {
      if (t.user_id === input.user_id && t.create_request_id === input.create_request_id) {
        const err = new Error("duplicate key value violates unique constraint") as Error & { code: string };
        err.code = "23505";
        throw err;
      }
    }
    const row: L3WritingTaskRow = {
      id: input.id,
      user_id: input.user_id,
      question_id: input.question_id,
      title: input.title,
      kind: input.kind,
      direction: input.direction,
      status: input.status,
      create_request_id: input.create_request_id,
      create_input_hash: input.create_input_hash,
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    this.tasks.set(row.id, row);
    return row;
  }

  async findTaskById(userId: string, taskId: string): Promise<L3WritingTaskRow | null> {
    const t = this.tasks.get(taskId);
    return t && t.user_id === userId ? t : null;
  }

  async findTaskByRequestId(userId: string, requestId: string): Promise<L3WritingTaskRow | null> {
    if (this.raceHidden.has(requestId)) {
      this.raceHidden.delete(requestId);
      return null;
    }
    for (const t of this.tasks.values()) {
      if (t.user_id === userId && t.create_request_id === requestId) return t;
    }
    return null;
  }

  async findActiveTaskByQuestion(
    userId: string,
    questionId: string,
    kind: WritingKind,
    direction: WritingDirection,
  ): Promise<L3WritingTaskRow | null> {
    let found: L3WritingTaskRow | null = null;
    for (const t of this.tasks.values()) {
      if (t.user_id === userId && t.question_id === questionId
        && t.kind === kind && t.direction === direction && t.status === "active") {
        if (!found || t.created_at > found.created_at) found = t;
      }
    }
    return found;
  }

  async lockTask(userId: string, taskId: string): Promise<L3WritingTaskRow | null> {
    return this.findTaskById(userId, taskId);
  }

  async lockQuestion(userId: string, questionId: string): Promise<L3QuestionRow | null> {
    const q = this.questions.get(questionId);
    return q && q.user_id === userId ? q : null;
  }

  async updateTaskTitle(userId: string, taskId: string, title: string): Promise<L3WritingTaskRow | null> {
    const t = this.tasks.get(taskId);
    if (!t || t.user_id !== userId) return null;
    this.tasks.set(taskId, { ...t, title, updated_at: nowIso() });
    return this.tasks.get(taskId)!;
  }

  async setTaskStatus(
    userId: string,
    taskId: string,
    status: L3WritingTaskRow["status"],
  ): Promise<L3WritingTaskRow | null> {
    const t = this.tasks.get(taskId);
    if (!t || t.user_id !== userId) return null;
    this.tasks.set(taskId, { ...t, status, updated_at: nowIso() });
    return this.tasks.get(taskId)!;
  }

  async touchTask(): Promise<void> { /* no-op for unit */ }

  async insertDraft(input: Parameters<IL3WritingRepository["insertDraft"]>[0]): Promise<L3SubmissionRow> {
    const row: L3SubmissionRow = {
      id: randomUUID(),
      user_id: input.user_id,
      scope: "writing",
      scope_key: `writing:${input.task_id}`,
      source_id: null,
      question_type: null,
      paper_id: null,
      writing_task_id: input.task_id,
      parent_sheet_id: null,
      revision_no: null,
      draft_version: 0,
      status: "draft",
      answers: {},
      seal_mode: null,
      summary: null,
      sealed_at: null,
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    this.submissions.set(row.id, row);
    return row;
  }

  async findDraftByTask(userId: string, taskId: string): Promise<L3SubmissionRow | null> {
    for (const s of this.submissions.values()) {
      if (s.user_id === userId && s.writing_task_id === taskId && s.status === "draft") return s;
    }
    return null;
  }

  async countSealedByTask(userId: string, taskId: string): Promise<number> {
    let n = 0;
    for (const s of this.submissions.values()) {
      if (s.user_id === userId && s.writing_task_id === taskId && s.status === "sealed") n += 1;
    }
    return n;
  }

  async findLatestSealedByTask(userId: string, taskId: string): Promise<L3SubmissionRow | null> {
    let found: L3SubmissionRow | null = null;
    for (const s of this.submissions.values()) {
      if (s.user_id === userId && s.writing_task_id === taskId && s.status === "sealed") {
        if (!found || (s.revision_no ?? 0) > (found.revision_no ?? 0)) found = s;
      }
    }
    return found;
  }

  async listTasks(input: Parameters<IL3WritingRepository["listTasks"]>[0]): Promise<{ items: any[]; total: number }> {
    const q = input.q && input.q.trim() ? input.q.trim().toLowerCase() : null;
    let matched = [...this.tasks.values()].filter((t) => t.user_id === input.userId);
    if (input.status) matched = matched.filter((t) => t.status === input.status);
    if (q) {
      matched = matched.filter((t) => {
        const stem = this.questions.get(t.question_id)?.stem.toLowerCase() ?? "";
        return t.title.toLowerCase().includes(q) || stem.includes(q);
      });
    }
    const total = matched.length;
    matched.sort((a, b) => {
      if (a.updated_at !== b.updated_at) return a.updated_at < b.updated_at ? 1 : -1;
      return a.id < b.id ? 1 : -1;
    });
    if (input.cursor) {
      matched = matched.filter((t) => {
        if (t.updated_at !== input.cursor!.updatedAt) return t.updated_at < input.cursor!.updatedAt;
        return t.id < input.cursor!.id;
      });
    }
    const items = matched.slice(0, input.limit).map((t) => {
      const stem = this.questions.get(t.question_id)?.stem ?? "";
      const draft = [...this.submissions.values()].find(
        (s) => s.writing_task_id === t.id && s.status === "draft",
      );
      const sealed = [...this.submissions.values()].find(
        (s) => s.writing_task_id === t.id && s.status === "sealed",
      );
      return {
        ...t, prompt: stem,
        draft_sheet_id: draft?.id ?? null,
        last_sheet_id: sealed?.id ?? null,
        latest_revision_no: sealed?.revision_no ?? null,
      };
    });
    return { items, total };
  }

  /** 测试辅助：将某任务的 draft 替换为 sealed（模拟“已提交无 draft”场景）。 */
  submitDraft(taskId: string, revisionNo: number): void {
    for (const s of this.submissions.values()) {
      if (s.writing_task_id === taskId && s.status === "draft") {
        this.submissions.delete(s.id);
      }
    }
    const sealed: L3SubmissionRow = {
      id: randomUUID(),
      user_id: OWNER_A,
      scope: "writing",
      scope_key: `writing:${taskId}`,
      source_id: null,
      question_type: null,
      paper_id: null,
      writing_task_id: taskId,
      parent_sheet_id: null,
      revision_no: revisionNo,
      draft_version: 1,
      status: "sealed",
      answers: {},
      seal_mode: "full",
      summary: null,
      sealed_at: nowIso(),
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    this.submissions.set(sealed.id, sealed);
  }

  // ── W3 sheet 域方法：任务域单测不触及（W3 自带专用 fake；此处防误用）────────

  private notUsed(): never {
    throw new Error("FakeWritingRepository: sheet-domain method not stubbed for task tests");
  }
  async lockSheet(): Promise<never> { return this.notUsed(); }
  async findSheetById(): Promise<never> { return this.notUsed(); }
  async findSealedSheetById(): Promise<never> { return this.notUsed(); }
  async casSaveDraft(): Promise<never> { return this.notUsed(); }
  async findWritingAttempt(): Promise<never> { return this.notUsed(); }
  async insertWritingAttempt(): Promise<never> { return this.notUsed(); }
  async createWritingDraft(): Promise<never> { return this.notUsed(); }
  async sealWritingSheet(): Promise<never> { return this.notUsed(); }
  async discardWritingDraft(): Promise<never> { return this.notUsed(); }
  async findMaxRevisionNo(): Promise<never> { return this.notUsed(); }
  async listRevisions(): Promise<never> { return this.notUsed(); }
  async softDeleteWritingAttempt(): Promise<never> { return this.notUsed(); }
}

interface Fakes {
  questions: Map<string, L3QuestionRow>;
  writing: FakeWritingRepository;
  paper: FakePaperRepository;
}

function makeFakes(): Fakes {
  const questions = new Map<string, L3QuestionRow>();
  const writing = new FakeWritingRepository(questions);
  const paper = new FakePaperRepository(questions);
  return { questions, writing, paper };
}

function makeService(fakes: Fakes): L3WritingTaskService {
  const repos: WritingRepos = {
    l3Writing: fakes.writing as unknown as IL3WritingRepository,
    l3Paper: fakes.paper as unknown as IL3PaperRepository,
    l3Context: undefined,
  };
  return new L3WritingTaskService(
    () => repos,
    async (cb) => cb({} as never),
  );
}

const baseInput = (overrides: Partial<WritingTaskCreateInput> = {}): WritingTaskCreateInput => ({
  requestId: randomUUID(),
  kind: "whole",
  direction: "通用",
  forceNew: false,
  ...overrides,
});

let fakes: Fakes;
let service: L3WritingTaskService;
let seedQuestionId: string;

beforeEach(async () => {
  fakes = makeFakes();
  service = makeService(fakes);
  const q = await fakes.paper.insertQuestion({
    user_id: OWNER_A, source_id: null, file_key: null, space: "作文",
    question_type: "short_essay", ordinal: 0, stem: "既有小作文题面",
  });
  seedQuestionId = q.id;
});

describe("create — 直接开始", () => {
  it("同事务建内部题（long_essay, file_key=writing:<taskId>）与首空 draft，并返回 draft", async () => {
    const input = baseInput({ prompt: "我的第一段自由写作", title: "我的标题" });
    const result = await service.create(OWNER_A, input);
    expect(result.created).toBe(true);
    expect(result.draft).not.toBeNull();
    expect(result.draft?.status).toBe("draft");
    expect(result.draft?.taskId).toBe(result.task.id);
    const question = fakes.questions.get(result.task.questionId);
    expect(question).toBeDefined();
    expect(question?.question_type).toBe("long_essay");
    expect(question?.file_key).toBe(`writing:${result.task.id}`);
    expect(question?.stem).toBe("我的第一段自由写作");
  });

  it("prompt 缺省时题面=服务端生成「自由写作」", async () => {
    const result = await service.create(OWNER_A, baseInput());
    const question = fakes.questions.get(result.task.questionId);
    expect(question?.stem).toBe("自由写作");
  });

  it("title 缺省时取题面首 24 个 Unicode code point（emoji 按 code point 截断）", async () => {
    const stem = "𠮷".repeat(30);
    const result = await service.create(OWNER_A, baseInput({ prompt: stem }));
    expect(result.task.title).toBe("𠮷".repeat(24));
  });
});

describe("create — 幂等", () => {
  it("相同 requestId 重放返回同 task 与首稿（created=false）", async () => {
    const input = baseInput({ kind: "free", direction: "雅思", prompt: "重放测试" });
    const first = await service.create(OWNER_A, input);
    const replay = await service.create(OWNER_A, input);
    expect(replay.task.id).toBe(first.task.id);
    expect(replay.draft?.id).toBe(first.draft?.id);
    expect(replay.created).toBe(false);
  });

  it("同 requestId 不同规范化输入 → 409 IDEMPOTENCY_CONFLICT", async () => {
    const requestId = randomUUID();
    await service.create(OWNER_A, baseInput({ requestId, kind: "whole", direction: "通用", prompt: "A" }));
    await expect(
      service.create(OWNER_A, baseInput({ requestId, kind: "paragraph", direction: "通用", prompt: "A" })),
    ).rejects.toMatchObject({ httpStatus: 409, meta: { code: "IDEMPOTENCY_CONFLICT" } });
  });

  it("并发唯一冲突整体回滚，重读既有行返回（created=false，未多建任务）", async () => {
    const requestId = randomUUID();
    // 用不同 question 预置“并发已提交”的任务，确保走 insertTask 23505 → 重读路径（而非同题复用）。
    const otherQ = await fakes.paper.insertQuestion({
      user_id: OWNER_A, source_id: null, file_key: null, space: "作文",
      question_type: "long_essay", ordinal: 0, stem: "并发题",
    });
    const preSeededId = randomUUID();
    await fakes.writing.insertTask({
      id: preSeededId, user_id: OWNER_A, question_id: otherQ.id,
      title: "并发已建", kind: "whole", direction: "通用", status: "active",
      create_request_id: requestId, create_input_hash: "x",
    });
    fakes.writing.raceHidden.add(requestId); // 首次 find 时隐藏（模拟我们检查后才提交的并发行）
    const before = fakes.writing.taskCount;
    const result = await service.create(OWNER_A, baseInput({
      requestId, kind: "whole", direction: "通用", questionId: seedQuestionId,
    }));
    expect(result.created).toBe(false);
    expect(result.task.id).toBe(preSeededId); // 重读既有行返回
    expect(fakes.writing.taskCount).toBe(before); // 未多建任务（真实 DB 由事务回滚去孤立内部题）
  });
});

describe("create — 选题路径", () => {
  it("forceNew=false 同题复用活跃同款任务（created=false）", async () => {
    const input = baseInput({ kind: "whole", direction: "通用", questionId: seedQuestionId });
    const first = await service.create(OWNER_A, input);
    const reuse = await service.create(OWNER_A, baseInput({ kind: "whole", direction: "通用", questionId: seedQuestionId }));
    expect(reuse.task.id).toBe(first.task.id);
    expect(reuse.created).toBe(false);
  });

  it("forceNew=true 对同一 requestId 重试不重复建任务", async () => {
    const requestId = randomUUID();
    const first = await service.create(OWNER_A, baseInput({ requestId, kind: "whole", direction: "通用", questionId: seedQuestionId, forceNew: true }));
    const second = await service.create(OWNER_A, baseInput({ requestId, kind: "whole", direction: "通用", questionId: seedQuestionId, forceNew: true }));
    expect(second.task.id).toBe(first.task.id);
  });

  it("题型非 essay → 422", async () => {
    const cloze = await fakes.paper.insertQuestion({
      user_id: OWNER_A, source_id: null, file_key: null, space: "阅读",
      question_type: "reading_choice", ordinal: 0, stem: "选择题",
    });
    await expect(
      service.create(OWNER_A, baseInput({ kind: "whole", direction: "通用", questionId: cloze.id })),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("另一 owner 的题 → 404", async () => {
    const other = await fakes.paper.insertQuestion({
      user_id: OWNER_B, source_id: null, file_key: null, space: "作文",
      question_type: "long_essay", ordinal: 0, stem: "别人的题",
    });
    await expect(
      service.create(OWNER_A, baseInput({ kind: "whole", direction: "通用", questionId: other.id })),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("复用已提交且无 draft 的任务 → draft=null（禁止偷偷新建）", async () => {
    const first = await service.create(OWNER_A, baseInput({ kind: "whole", direction: "通用", questionId: seedQuestionId }));
    fakes.writing.submitDraft(first.task.id, 1);
    const reuse = await service.create(OWNER_A, baseInput({ kind: "whole", direction: "通用", questionId: seedQuestionId }));
    expect(reuse.created).toBe(false);
    expect(reuse.draft).toBeNull();
  });
});

describe("get / list — 权限与作用域", () => {
  it("其他 owner 读任务 → 404", async () => {
    const created = await service.create(OWNER_A, baseInput({ prompt: "私有" }));
    await expect(service.get(OWNER_B, created.task.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("get 返回 draft 摘要、提交稿计数与最新提交稿 id；题面经 question 取回", async () => {
    const created = await service.create(OWNER_A, baseInput({ prompt: "详情" }));
    const detail = await service.get(OWNER_A, created.task.id);
    expect(detail.draftSummary?.id).toBe(created.draft?.id);
    expect(detail.revisionCount).toBe(0);
    expect(detail.latestSubmittedSheetId).toBeNull();
    expect(detail.task.prompt).toBe("详情");
  });
});

describe("list — keyset 分页 / 转义 / 单 owner", () => {
  it("25 个 ownerA 任务分页逐页无重复/漏项，total 正确", async () => {
    for (let i = 0; i < 50; i += 1) {
      const owner = i < 25 ? OWNER_A : OWNER_B;
      // eslint-disable-next-line no-await-in-loop
      await service.create(owner, baseInput({ prompt: `p${i}` }));
    }
    const collected = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;
    do {
      // eslint-disable-next-line no-await-in-loop
      const page = await service.list(OWNER_A, { limit: 10, cursor });
      for (const s of page.items) {
        expect(collected.has(s.task.id)).toBe(false);
        collected.add(s.task.id);
      }
      expect(page.items.length).toBeLessThanOrEqual(10);
      cursor = page.nextCursor;
      pages += 1;
      if (pages > 10) break;
    } while (cursor);
    expect(collected.size).toBe(25);
    const first = await service.list(OWNER_A, { limit: 10 });
    expect(first.total).toBe(25);
  });

  it("q 搜索标题/题面，% _ 不变通配，只搜当前 owner", async () => {
    await service.create(OWNER_A, baseInput({ prompt: "折扣50% 限时" }));
    await service.create(OWNER_A, baseInput({ prompt: "普通说明" }));
    await service.create(OWNER_B, baseInput({ prompt: "折扣50% 别人的" }));
    const page = await service.list(OWNER_A, { q: "50%", limit: 50 });
    // summary.task 不含 prompt；仅校验命中数与作用域
    expect(page.items.length).toBe(1);
    expect(page.total).toBe(1);
    // 题面含字面 % 的题应被精确匹配：ownerA 的“折扣50% 限时”命中，ownerB 的同名被作用域排除
    const allA = await service.list(OWNER_A, { limit: 50 });
    expect(allA.items.length).toBe(2);
  });

  it("limit 默认 20、最大 50", async () => {
    for (let i = 0; i < 60; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await service.create(OWNER_A, baseInput({ prompt: `lim${i}` }));
    }
    const def = await service.list(OWNER_A, {});
    expect(def.items.length).toBe(20);
    const big = await service.list(OWNER_A, { limit: 999 });
    expect(big.items.length).toBe(50);
  });
});

describe("archive / restore", () => {
  it("有 draft → 409，且状态保持 active", async () => {
    const created = await service.create(OWNER_A, baseInput({ prompt: "待归档" }));
    await expect(service.archive(OWNER_A, created.task.id)).rejects.toBeInstanceOf(ConflictError);
    const after = await service.get(OWNER_A, created.task.id);
    expect(after.task.status).toBe("active");
  });

  it("无 draft 可归档；归档后仍可读；恢复不自动建稿", async () => {
    const created = await service.create(OWNER_A, baseInput({ prompt: "可归档" }));
    fakes.writing.submitDraft(created.task.id, 1);
    const archived = await service.archive(OWNER_A, created.task.id);
    expect(archived.status).toBe("archived");
    const detail = await service.get(OWNER_A, created.task.id);
    expect(detail.task.status).toBe("archived");
    expect(detail.draftSummary).toBeNull();
    const restored = await service.restore(OWNER_A, created.task.id);
    expect(restored.status).toBe("active");
    const afterRestore = await service.get(OWNER_A, created.task.id);
    expect(afterRestore.draftSummary).toBeNull();
  });

  it("归档/恢复不存在的任务 → 404", async () => {
    await expect(service.archive(OWNER_A, randomUUID())).rejects.toBeInstanceOf(NotFoundError);
    await expect(service.restore(OWNER_A, randomUUID())).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("rename", () => {
  it("改标题并刷新 updated_at，题面不复制", async () => {
    const created = await service.create(OWNER_A, baseInput({ prompt: "改名题面" }));
    const renamed = await service.rename(OWNER_A, created.task.id, { title: "新标题" });
    expect(renamed.title).toBe("新标题");
    expect(renamed.prompt).toBe("改名题面");
  });
});
