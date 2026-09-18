/**
 * L3WritingRepository 单元测试（mock pg executor，无真实 DB）。
 * 验证关键方法的 SQL 形态：参数顺序、writing scope 首稿、q 转义、keyset 游标、
 * status 过滤、FOR UPDATE 锁，以及行映射（含 prompt 投影）。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import {
  L3WritingRepository,
  type IL3WritingRepository,
} from "@/repositories/l3-writing.repository";
import type { L3WritingTaskRow } from "@/repositories/l3-writing.types";
import type { L3QuestionAttemptRow, L3SubmissionRow } from "@/domain";

const USER = "00000000-0000-4000-8000-0000000000a1";

function fakeClient(): PoolClient {
  return { query: vi.fn(async () => ({ rows: [] as unknown[] })) } as unknown as PoolClient;
}

function taskRow(overrides: Partial<L3WritingTaskRow> = {}): L3WritingTaskRow {
  return {
    id: "t-1",
    user_id: USER,
    question_id: "q-1",
    title: "标题",
    kind: "whole",
    direction: "通用",
    status: "active",
    create_request_id: "r-1",
    create_input_hash: "h-1",
    created_at: "2026-09-18T00:00:00Z",
    updated_at: "2026-09-18T00:00:00Z",
    ...overrides,
  };
}

function listRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...taskRow(),
    prompt: "题面",
    draft_sheet_id: null,
    last_sheet_id: null,
    latest_revision_no: null,
    ...overrides,
  };
}

let client: PoolClient;
let repo: IL3WritingRepository;
let querySpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  client = fakeClient();
  querySpy = client.query as unknown as ReturnType<typeof vi.fn>;
  repo = new L3WritingRepository(client);
});

describe("insertTask", () => {
  it("INSERT 9 个参数按 id,user_id,question_id,title,kind,direction,status,create_request_id,create_input_hash 顺序", async () => {
    querySpy.mockImplementation(async () => ({ rows: [taskRow()] }));
    await repo.insertTask({
      id: "t-new", user_id: USER, question_id: "q-1", title: "T", kind: "whole",
      direction: "通用", status: "active", create_request_id: "r-new", create_input_hash: "h-new",
    });
    const [text, params] = querySpy.mock.calls[0]!;
    expect(text).toContain("INSERT INTO l3_writing_tasks");
    expect(text).toContain("RETURNING *");
    expect(params).toEqual(["t-new", USER, "q-1", "T", "whole", "通用", "active", "r-new", "h-new"]);
  });
});

describe("insertDraft", () => {
  it("writing scope 首稿：scope='writing'、scope_key='writing:<taskId>'、answers='{}'、draft_version=0、writing_task_id 必填", async () => {
    querySpy.mockImplementation(async () => ({ rows: [{ id: "s-1", scope: "writing", scope_key: "writing:t-new", writing_task_id: "t-new", status: "draft", draft_version: 0 }] }));
    const row = await repo.insertDraft({ user_id: USER, task_id: "t-new", question_id: "q-1" });
    const [text, params] = querySpy.mock.calls[0]!;
    expect(text).toContain("INSERT INTO l3_submissions");
    expect(text).toContain("'writing'");
    expect(text).toContain("scope_key");
    expect(text).toContain("'{}'::jsonb");
    expect(text).toContain("draft_version");
    // params: [user_id, scope_key, task_id]
    expect(params).toEqual([USER, "writing:t-new", "t-new"]);
    expect(row.writing_task_id).toBe("t-new");
    expect(row.status).toBe("draft");
    expect(row.draft_version).toBe(0);
  });
});

describe("listTasks", () => {
  beforeEach(() => {
    querySpy.mockImplementation(async (text: string) => {
      if (text.includes("count(*)")) return { rows: [{ total: "3" }] };
      return { rows: [listRow({ id: "t-1" }), listRow({ id: "t-2" }), listRow({ id: "t-3" })] };
    });
  });

  it("q 搜索对 % _ 转义且用 ESCAPE '\\'，只搜当前 owner", async () => {
    const { items, total } = await repo.listTasks({ userId: USER, status: null, q: "50%_x", cursor: null, limit: 20 });
    const text = querySpy.mock.calls.map((c) => c[0]).join("\n");
    expect(text).toContain("ILIKE");
    expect(text).toContain("ESCAPE '\\'");
    const qParam = querySpy.mock.calls.flatMap((c) => c[1] as unknown[]).find((p) => typeof p === "string" && p.includes("50"));
    expect(qParam).toBe("%50\\%\\_x%"); // % 与 _ 被转义
    expect(total).toBe(3);
    expect(items.length).toBe(3);
    expect(items[0].prompt).toBe("题面");
  });

  it("status 过滤生成 t.status = 条件", async () => {
    await repo.listTasks({ userId: USER, status: "archived", q: null, cursor: null, limit: 20 });
    const text = querySpy.mock.calls.map((c) => c[0]).join("\n");
    expect(text).toContain("t.status =");
  });

  it("keyset 游标生成 (t.updated_at, t.id) < ($ts, $id) 续页条件", async () => {
    await repo.listTasks({
      userId: USER, status: null, q: null,
      cursor: { updatedAt: "2026-09-18T00:00:00Z", id: "t-9" }, limit: 20,
    });
    const text = querySpy.mock.calls.map((c) => c[0]).join("\n");
    expect(text).toContain("(t.updated_at, t.id) <");
    expect(text).toContain("::timestamptz");
    expect(text).toContain("::uuid");
  });
});

describe("findTaskByRequestId / lockTask", () => {
  it("findTaskByRequestId 按 create_request_id 查询", async () => {
    querySpy.mockImplementation(async () => ({ rows: [taskRow()] }));
    await repo.findTaskByRequestId(USER, "r-1");
    const [text, params] = querySpy.mock.calls[0]!;
    expect(text).toContain("create_request_id = $2");
    expect(params).toEqual([USER, "r-1"]);
  });

  it("lockTask 带 FOR UPDATE", async () => {
    querySpy.mockImplementation(async () => ({ rows: [taskRow()] }));
    const row = await repo.lockTask(USER, "t-1");
    const [text] = querySpy.mock.calls[0]!;
    expect(text).toContain("FOR UPDATE");
    expect(row?.id).toBe("t-1");
  });
});

// ── W3/W9 稿件生命周期（sheet 域）+ 任务域残余分支 ──────────────────────────

function submissionRow(overrides: Partial<L3SubmissionRow> = {}): L3SubmissionRow {
  return {
    id: "s-1",
    user_id: USER,
    scope: "writing",
    scope_key: "writing:t-1",
    source_id: null,
    question_type: null,
    paper_id: null,
    writing_task_id: "t-1",
    parent_sheet_id: null,
    revision_no: null,
    draft_version: 0,
    status: "draft",
    answers: {},
    seal_mode: null,
    summary: null,
    sealed_at: null,
    created_at: "2026-09-18T00:00:00Z",
    updated_at: "2026-09-18T00:00:00Z",
    ...overrides,
  };
}

function attemptRow(overrides: Partial<L3QuestionAttemptRow> = {}): L3QuestionAttemptRow {
  return {
    id: "a-1",
    user_id: USER,
    question_id: "q-1",
    sheet_id: "s-1",
    venue: "writing",
    answer: { text: "正文" },
    self_assessment: null,
    status: "active",
    deleted_at: null,
    created_at: "2026-09-18T00:00:00Z",
    ...overrides,
  };
}

describe("任务域残余分支（空行/异常/映射兜底）", () => {
  it("findTaskById 按 id+user 归属查询；空行返回 null", async () => {
    querySpy.mockImplementation(async () => ({ rows: [taskRow()] }));
    const row = await repo.findTaskById(USER, "t-1");
    expect(querySpy.mock.calls[0]![0]).toContain("id = $1::uuid AND user_id = $2::uuid");
    expect(row?.id).toBe("t-1");
    querySpy.mockImplementation(async () => ({ rows: [] }));
    expect(await repo.findTaskById(USER, "t-1")).toBeNull();
  });

  it("findActiveTaskByQuestion 带 kind/direction/active 与确定性排序；空行返回 null", async () => {
    querySpy.mockImplementation(async () => ({ rows: [taskRow()] }));
    const row = await repo.findActiveTaskByQuestion(USER, "q-1", "whole", "通用");
    const [text, params] = querySpy.mock.calls[0]!;
    expect(text).toContain("kind = $3 AND direction = $4 AND status = 'active'");
    expect(text).toContain("ORDER BY created_at DESC");
    expect(params).toEqual([USER, "q-1", "whole", "通用"]);
    expect(row?.id).toBe("t-1");
    querySpy.mockImplementation(async () => ({ rows: [] }));
    expect(await repo.findActiveTaskByQuestion(USER, "q-1", "whole", "通用")).toBeNull();
  });

  it("insertTask/insertDraft 空行抛错（防静默假成功）", async () => {
    querySpy.mockImplementation(async () => ({ rows: [] }));
    await expect(repo.insertTask({
      id: "t-x", user_id: USER, question_id: "q-1", title: "T", kind: "whole",
      direction: "通用", status: "active", create_request_id: "r-x", create_input_hash: "h-x",
    })).rejects.toThrow("insert returned no row");
    await expect(repo.insertDraft({ user_id: USER, task_id: "t-x", question_id: "q-1" }))
      .rejects.toThrow("insert returned no row");
  });

  it("mapSubmissionRow 对非对象 answers 兜底为 {}", async () => {
    querySpy.mockImplementation(async () => ({ rows: [{ ...submissionRow({ id: "s-2" }), answers: null }] }));
    const row = await repo.insertDraft({ user_id: USER, task_id: "t-1", question_id: "q-1" });
    expect(row.answers).toEqual({});
  });

  it("lockTask/lockQuestion 空行返回 null（requireTx 已由 client 构造满足）", async () => {
    querySpy.mockImplementation(async () => ({ rows: [] }));
    expect(await repo.lockTask(USER, "t-1")).toBeNull();
    const row = await repo.lockQuestion(USER, "q-1");
    const [text, params] = querySpy.mock.calls[1]!;
    expect(text).toContain("FROM l3_questions");
    expect(text).toContain("FOR UPDATE");
    expect(params).toEqual(["q-1", USER]);
    expect(row).toBeNull();
  });

  it("lockQuestion 命中行原样返回", async () => {
    const q = { id: "q-1", user_id: USER, stem: "题面" };
    querySpy.mockImplementation(async () => ({ rows: [q] }));
    expect(await repo.lockQuestion(USER, "q-1")).toEqual(q);
  });

  it("updateTaskTitle / setTaskStatus 空行返回 null；touchTask 走非 RETURNING UPDATE", async () => {
    querySpy.mockImplementation(async () => ({ rows: [taskRow({ title: "新题" })] }));
    const updated = await repo.updateTaskTitle(USER, "t-1", "新题");
    expect(querySpy.mock.calls[0]![0]).toContain("SET title = $3");
    expect(querySpy.mock.calls[0]![1]).toEqual(["t-1", USER, "新题"]);
    expect(updated?.title).toBe("新题");

    querySpy.mockImplementation(async () => ({ rows: [] }));
    expect(await repo.updateTaskTitle(USER, "t-1", "新题")).toBeNull();
    expect(await repo.setTaskStatus(USER, "t-1", "archived")).toBeNull();

    querySpy.mockImplementation(async () => ({ rows: [] }));
    await repo.touchTask(USER, "t-1");
    const [touchSql, touchParams] = querySpy.mock.calls.at(-1)!;
    expect(touchSql).toContain("UPDATE l3_writing_tasks SET updated_at = now()");
    expect(touchSql).not.toContain("RETURNING");
    expect(touchParams).toEqual(["t-1", USER]);
  });

  it("countSealedByTask / findLatestSealedByTask 计数与空行", async () => {
    querySpy.mockImplementation(async () => ({ rows: [{ c: "2" }] }));
    expect(await repo.countSealedByTask(USER, "t-1")).toBe(2);
    expect(querySpy.mock.calls[0]![0]).toContain("status = 'sealed'");

    querySpy.mockImplementation(async () => ({ rows: [] }));
    expect(await repo.countSealedByTask(USER, "t-1")).toBe(0);
    expect(await repo.findLatestSealedByTask(USER, "t-1")).toBeNull();

    querySpy.mockImplementation(async () => ({ rows: [submissionRow({ status: "sealed", revision_no: 3 })] }));
    const latest = await repo.findLatestSealedByTask(USER, "t-1");
    expect(querySpy.mock.calls.at(-1)![0]).toContain("ORDER BY revision_no DESC");
    expect(latest?.revision_no).toBe(3);
  });
});

describe("sheet 域：锁与读（W3）", () => {
  it("lockSheet 用 task→user→sheet 参数位次并 FOR UPDATE", async () => {
    querySpy.mockImplementation(async () => ({ rows: [submissionRow()] }));
    const row = await repo.lockSheet(USER, "t-1", "s-1");
    const [text, params] = querySpy.mock.calls[0]!;
    expect(text).toContain("WHERE id = $3::uuid AND user_id = $2::uuid AND writing_task_id = $1::uuid");
    expect(text).toContain("FOR UPDATE");
    expect(params).toEqual(["t-1", USER, "s-1"]);
    expect(row?.id).toBe("s-1");
  });

  it("findSheetById 无锁读；findSealedSheetById 附加 status='sealed'；空行返回 null", async () => {
    querySpy.mockImplementation(async () => ({ rows: [submissionRow({ status: "sealed", revision_no: 1 })] }));
    const sealed = await repo.findSealedSheetById(USER, "t-1", "s-1");
    const [text] = querySpy.mock.calls[0]!;
    expect(text).toContain("AND status = 'sealed'");
    expect(text).not.toContain("FOR UPDATE");
    expect(sealed?.status).toBe("sealed");

    querySpy.mockImplementation(async () => ({ rows: [] }));
    expect(await repo.findSheetById(USER, "t-1", "s-1")).toBeNull();
    expect(await repo.lockSheet(USER, "t-1", "s-1")).toBeNull();
  });
});

describe("sheet 域：CAS 与物化写（W3）", () => {
  it("casSaveDraft 原子 CAS：status='draft' AND draft_version=$5，递增恰一次", async () => {
    querySpy.mockImplementation(async () => ({ rows: [submissionRow({ draft_version: 2 })] }));
    const row = await repo.casSaveDraft(USER, "t-1", "s-1", 1, JSON.stringify({ q: { text: "A" } }));
    const [text, params] = querySpy.mock.calls[0]!;
    expect(text).toContain("SET answers = $4::jsonb, draft_version = draft_version + 1");
    expect(text).toContain("AND status = 'draft' AND draft_version = $5");
    expect(params).toEqual(["t-1", USER, "s-1", JSON.stringify({ q: { text: "A" } }), 1]);
    expect(row?.draft_version).toBe(2);

    querySpy.mockImplementation(async () => ({ rows: [] }));
    expect(await repo.casSaveDraft(USER, "t-1", "s-1", 1, "{}")).toBeNull();
  });

  it("sealWritingSheet：清 answers、sealed/full、稿号 $5、版本 CAS $4", async () => {
    querySpy.mockImplementation(async () => ({ rows: [submissionRow({ status: "sealed", seal_mode: "full", revision_no: 1, sealed_at: "x" })] }));
    const row = await repo.sealWritingSheet(USER, "t-1", "s-1", 1, 1);
    const [text, params] = querySpy.mock.calls[0]!;
    expect(text).toContain("SET answers = '{}'::jsonb, status = 'sealed', seal_mode = 'full'");
    expect(text).toContain("revision_no = $5, draft_version = draft_version + 1");
    expect(text).toContain("AND status = 'draft' AND draft_version = $4");
    expect(params).toEqual(["t-1", USER, "s-1", 1, 1]);
    expect(row?.revision_no).toBe(1);

    querySpy.mockImplementation(async () => ({ rows: [] }));
    expect(await repo.sealWritingSheet(USER, "t-1", "s-1", 1, 1)).toBeNull();
  });

  it("discardWritingDraft：清 answers 置 discarded；不改 draft_version、不占稿号", async () => {
    querySpy.mockImplementation(async () => ({ rows: [submissionRow({ status: "discarded" })] }));
    const row = await repo.discardWritingDraft(USER, "t-1", "s-1", 0);
    const [text, params] = querySpy.mock.calls[0]!;
    expect(text).toContain("SET answers = '{}'::jsonb, status = 'discarded'");
    expect(text).not.toContain("draft_version = draft_version + 1");
    expect(params).toEqual(["t-1", USER, "s-1", 0]);
    expect(row?.status).toBe("discarded");

    querySpy.mockImplementation(async () => ({ rows: [] }));
    expect(await repo.discardWritingDraft(USER, "t-1", "s-1", 0)).toBeNull();
  });

  it("createWritingDraft：parent 显式引用 + 初始 answers jsonb；空行抛错", async () => {
    querySpy.mockImplementation(async () => ({ rows: [submissionRow({ parent_sheet_id: "s-0", draft_version: 0 })] }));
    const row = await repo.createWritingDraft({
      user_id: USER, task_id: "t-1", question_id: "q-1", parent_sheet_id: "s-0",
      answers: { q: { text: "copy" } },
    });
    const [text, params] = querySpy.mock.calls[0]!;
    expect(text).toContain("'writing', $2");
    expect(text).toContain("$4::uuid");
    expect(text).toContain("$5::jsonb");
    expect(params).toEqual([USER, "writing:t-1", "t-1", "s-0", JSON.stringify({ q: { text: "copy" } })]);
    expect(row.parent_sheet_id).toBe("s-0");

    querySpy.mockImplementation(async () => ({ rows: [] }));
    await expect(repo.createWritingDraft({
      user_id: USER, task_id: "t-1", question_id: "q-1", parent_sheet_id: null, answers: {},
    })).rejects.toThrow("insert returned no row");
  });

  it("findMaxRevisionNo 用 max(revision_no) 而非 count；空行 0", async () => {
    querySpy.mockImplementation(async () => ({ rows: [{ m: 7 }] }));
    expect(await repo.findMaxRevisionNo(USER, "t-1")).toBe(7);
    expect(querySpy.mock.calls[0]![0]).toContain("COALESCE(max(revision_no), 0)::int");
    querySpy.mockImplementation(async () => ({ rows: [] }));
    expect(await repo.findMaxRevisionNo(USER, "t-1")).toBe(0);
  });
});

describe("sheet 域：attempt 读写与清理（W3/W9）", () => {
  it("insertWritingAttempt 以 venue='writing' 写入；空行抛错", async () => {
    querySpy.mockImplementation(async () => ({ rows: [attemptRow()] }));
    const row = await repo.insertWritingAttempt({ user_id: USER, question_id: "q-1", sheet_id: "s-1", answerJsonb: JSON.stringify({ text: "正文" }) });
    const [text, params] = querySpy.mock.calls[0]!;
    expect(text).toContain("venue, answer)");
    expect(text).toContain("'writing', $4::jsonb");
    expect(params).toEqual([USER, "q-1", "s-1", JSON.stringify({ text: "正文" })]);
    expect(row.venue).toBe("writing");

    querySpy.mockImplementation(async () => ({ rows: [] }));
    await expect(repo.insertWritingAttempt({ user_id: USER, question_id: "q-1", sheet_id: "s-1", answerJsonb: "{}" }))
      .rejects.toThrow("insert returned no row");
  });

  it("findWritingAttempt 只取 venue='writing' 的首行；空行 null", async () => {
    querySpy.mockImplementation(async () => ({ rows: [attemptRow()] }));
    const row = await repo.findWritingAttempt(USER, "s-1");
    const [text, params] = querySpy.mock.calls[0]!;
    expect(text).toContain("venue = 'writing'");
    expect(text).toContain("ORDER BY created_at ASC");
    expect(params).toEqual([USER, "s-1"]);
    expect(row?.id).toBe("a-1");

    querySpy.mockImplementation(async () => ({ rows: [] }));
    expect(await repo.findWritingAttempt(USER, "s-1")).toBeNull();
  });

  it("softDeleteWritingAttempt 仅限 writing+active；true/false 两态", async () => {
    querySpy.mockImplementation(async () => ({ rows: [{ id: "a-1" }] }));
    expect(await repo.softDeleteWritingAttempt(USER, "s-1")).toBe(true);
    const [text, params] = querySpy.mock.calls[0]!;
    expect(text).toContain("venue = 'writing'");
    expect(text).toContain("AND status = 'active'");
    expect(params).toEqual([USER, "s-1"]);

    querySpy.mockImplementation(async () => ({ rows: [] }));
    expect(await repo.softDeleteWritingAttempt(USER, "s-1")).toBe(false);
  });
});

describe("listRevisions（keyset + 派生计数）", () => {
  it("无游标：sealed/discarded 集合 + active attempt/反馈计数派生；映射后返回", async () => {
    querySpy.mockImplementation(async (text: string) => {
      if (text.includes("count(*) AS total")) return { rows: [{ total: "2" }] };
      return {
        rows: [
          { ...submissionRow({ id: "s-2", status: "sealed", revision_no: 2 }), active_attempt_count: 1, feedback_count: 1 },
          { ...submissionRow({ id: "s-1", status: "discarded" }), active_attempt_count: 0, feedback_count: 0 },
        ],
      };
    });
    const page = await repo.listRevisions(USER, "t-1", { limit: 20, cursor: null });
    const sql = querySpy.mock.calls.map((c) => c[0]).join("\n");
    expect(sql).toContain("s.status IN ('sealed', 'discarded')");
    expect(sql).toContain("venue = 'writing' AND status = 'active'");
    expect(sql).toContain("FROM l3_writing_feedback");
    expect(sql).toContain("ORDER BY s.updated_at DESC, s.id DESC");
    expect(page.total).toBe(2);
    expect(page.items).toHaveLength(2);
    expect(page.items[0]!.active_attempt_count).toBe(1);
    expect(page.items[0]!.feedback_count).toBe(1);
    expect(page.items[0]!.answers).toEqual({});
  });

  it("带游标：追加 (s.updated_at, s.id) < 条件且 limit 参数位于末位", async () => {
    querySpy.mockImplementation(async (text: string) => {
      if (text.includes("count(*) AS total")) return { rows: [{ total: "5" }] };
      return { rows: [] };
    });
    await repo.listRevisions(USER, "t-1", { limit: 10, cursor: { updatedAt: "2026-09-18T00:00:00Z", id: "s-9" } });
    const sql = querySpy.mock.calls.map((c) => c[0]).join("\n");
    expect(sql).toContain("(s.updated_at, s.id) <");
    expect(sql).toContain("::timestamptz");
    expect(sql).toContain("::uuid");
    const lastCall = querySpy.mock.calls[querySpy.mock.calls.length - 1]!;
    expect(lastCall[1]).toEqual([USER, "t-1", "2026-09-18T00:00:00Z", "s-9", 10]);
  });
});

describe("分支臂补全（三元/兜底全覆盖）", () => {
  it("findDraftByTask：draft 行映射与空行 null", async () => {
    querySpy.mockImplementation(async () => ({ rows: [submissionRow({ id: "s-draft" })] }));
    const row = await repo.findDraftByTask(USER, "t-1");
    const [text, params] = querySpy.mock.calls[0]!;
    expect(text).toContain("status = 'draft'");
    expect(text).toContain("ORDER BY created_at ASC");
    expect(params).toEqual([USER, "t-1"]);
    expect(row?.id).toBe("s-draft");

    querySpy.mockImplementation(async () => ({ rows: [] }));
    expect(await repo.findDraftByTask(USER, "t-1")).toBeNull();
  });

  it("findTaskByRequestId 空行 null 臂", async () => {
    querySpy.mockImplementation(async () => ({ rows: [] }));
    expect(await repo.findTaskByRequestId(USER, "r-1")).toBeNull();
  });

  it("setTaskStatus 命中行返回 archived 行", async () => {
    querySpy.mockImplementation(async () => ({ rows: [taskRow({ status: "archived" })] }));
    const row = await repo.setTaskStatus(USER, "t-1", "archived");
    expect(querySpy.mock.calls[0]![0]).toContain("SET status = $3");
    expect(querySpy.mock.calls[0]![1]).toEqual(["t-1", USER, "archived"]);
    expect(row?.status).toBe("archived");
  });

  it("listTasks 兜底臂：prompt 缺失归一为空串、total 缺失为 0", async () => {
    querySpy.mockImplementation(async (text: string) => {
      if (text.includes("count(*)")) return { rows: [] }; // totalRow 缺失 → 0
      return { rows: [{ ...taskRow(), prompt: undefined, draft_sheet_id: null, last_sheet_id: null, latest_revision_no: null }] };
    });
    const page = await repo.listTasks({ userId: USER, status: null, q: null, cursor: null, limit: 20 });
    expect(page.total).toBe(0);
    expect(page.items[0]!.prompt).toBe("");
  });

  it("findSheetById 命中臂 / findSealedSheetById 空行臂", async () => {
    querySpy.mockImplementation(async () => ({ rows: [submissionRow({ id: "s-9" })] }));
    const row = await repo.findSheetById(USER, "t-1", "s-9");
    expect(row?.id).toBe("s-9");

    querySpy.mockImplementation(async () => ({ rows: [] }));
    expect(await repo.findSealedSheetById(USER, "t-1", "s-9")).toBeNull();
  });

  it("listRevisions total 缺失臂为 0", async () => {
    querySpy.mockImplementation(async (text: string) => {
      if (text.includes("count(*) AS total")) return { rows: [] };
      return { rows: [] };
    });
    const page = await repo.listRevisions(USER, "t-1", { limit: 20, cursor: null });
    expect(page.total).toBe(0);
    expect(page.items).toEqual([]);
  });
});

describe("listQuestionTaskSummaries（A2：单条集合查询，JOIN 不放大）", () => {
  it("单次查询 + ANY(uuid[]) + draft/最新 sealed LATERAL + 反馈仅按 s 关联 + 归档排序", async () => {
    querySpy.mockImplementation(async () => ({ rows: [] }));
    await repo.listQuestionTaskSummaries(USER, { questionIds: ["q-1", "q-2"], kind: "whole", direction: "通用" });
    expect(querySpy).toHaveBeenCalledTimes(1); // 集合查询（无逐题 N+1）
    const [text, params] = querySpy.mock.calls[0]!;
    expect(text).toContain("t.question_id = ANY($2::uuid[])");
    expect(text).toContain("AND t.kind = $3 AND t.direction = $4");
    expect(text).toContain("status = 'draft'");
    expect(text).toContain("status = 'sealed'");
    expect(text).toContain("ORDER BY (t.status = 'archived')");
    expect(text).toContain("f.sheet_id = s.id"); // 反馈只取对应最新已提交稿
    expect(text).toContain("venue = 'writing' AND status = 'active'");
    expect(text).not.toContain("INSERT");
    expect(text).not.toContain("UPDATE");
    expect(params).toEqual([USER, ["q-1", "q-2"], "whole", "通用"]);
  });

  it("映射派生：sealed 各组（有反馈/无反馈/已清理）与无 sealed 的 null 组；归档状态透传", async () => {
    querySpy.mockImplementation(async () => ({
      rows: [
        { question_id: "q-1", task_id: "t-1", task_status: "active", draft_sheet_id: null, latest_submitted_sheet_id: "s-1", latest_revision_no: 2, revision_count: 3, feedback_id: "f-1", active_attempt_count: 1 },
        { question_id: "q-2", task_id: "t-2", task_status: "archived", draft_sheet_id: "s-d", latest_submitted_sheet_id: null, latest_revision_no: null, revision_count: 0, feedback_id: null, active_attempt_count: 0 },
        { question_id: "q-3", task_id: "t-3", task_status: "active", draft_sheet_id: null, latest_submitted_sheet_id: "s-3", latest_revision_no: 1, revision_count: 1, feedback_id: null, active_attempt_count: 1 },
        { question_id: "q-4", task_id: "t-4", task_status: "active", draft_sheet_id: null, latest_submitted_sheet_id: "s-4", latest_revision_no: 1, revision_count: 1, feedback_id: "f-stale", active_attempt_count: 0 },
      ],
    }));
    const rows = await repo.listQuestionTaskSummaries(USER, { questionIds: ["q-1", "q-2", "q-3", "q-4"], kind: "free", direction: "通用" });
    expect(rows[0]).toMatchObject({ question_id: "q-1", latestRevisionNo: 2, revisionCount: 3, feedbackState: "ready", contentStatus: "available" });
    expect(rows[1]).toMatchObject({ question_id: "q-2", taskStatus: "archived", draftSheetId: "s-d", latestRevisionNo: null, feedbackState: null, contentStatus: null });
    expect(rows[2]).toMatchObject({ question_id: "q-3", feedbackState: "pending", contentStatus: "available" });
    // 已清理（无 active attempt）→ unavailable/cleared：即便存在历史反馈行也不转显旧反馈
    expect(rows[3]).toMatchObject({ question_id: "q-4", feedbackState: "unavailable", contentStatus: "cleared" });
  });
});
