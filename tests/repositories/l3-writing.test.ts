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
