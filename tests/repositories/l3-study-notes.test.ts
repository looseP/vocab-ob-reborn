/**
 * L3StudyNoteRepository 单元测试（fake PoolClient，无真实 DB）：
 * create/get/lock/updateIfVersion CAS/replaceVenues/list（venue 过滤、q 转义、
 * topicId position 排序、unfiled 子查询、keyset、limit）/listTopicBlockers。
 * SQL 形态与参数顺序断言（真实 PG 行为见 l3-study-notes.integration.test.ts）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import { L3StudyNoteRepository } from "@/repositories/l3-study-notes.repository";

const USER = "00000000-0000-4000-8000-0000000000a1";
const NOTE = "00000000-0000-4000-8000-000000000101";
const TOPIC = "00000000-0000-4000-8000-000000000111";
const REQUEST = "00000000-0000-4000-8000-000000000121";

function fakeClient(): PoolClient {
  return { query: vi.fn(async () => ({ rows: [] as unknown[] })) } as unknown as PoolClient;
}

function noteRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: NOTE, user_id: USER, title: "标题", body_md: "正文", status: "active", pinned: false,
    version: 1, create_request_id: REQUEST, create_input_hash: "a".repeat(64),
    last_write_request_id: null, last_write_hash: null,
    created_at: "2026-09-19T00:00:00Z", updated_at: "2026-09-19T00:00:00Z",
    ...overrides,
  };
}

let client: PoolClient;
let repo: L3StudyNoteRepository;
let querySpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  client = fakeClient();
  querySpy = client.query as unknown as ReturnType<typeof vi.fn>;
  repo = new L3StudyNoteRepository(client);
});

describe("create", () => {
  it("INSERT 全列（含幂等列），RETURNING *", async () => {
    querySpy.mockImplementation(async () => ({ rows: [noteRow()] }));
    const row = await repo.create({
      id: NOTE, user_id: USER, title: "标题", body_md: "正文", status: "active", pinned: false,
      version: 1, create_request_id: REQUEST, create_input_hash: "a".repeat(64),
    });
    const [text, params] = querySpy.mock.calls[0]!;
    expect(text).toContain("INSERT INTO l3_study_notes");
    expect(text).toContain("RETURNING *");
    expect(params).toEqual([
      NOTE, USER, "标题", "正文", "active", false, 1, REQUEST, "a".repeat(64),
    ]);
    expect(row.id).toBe(NOTE);
  });
});

describe("get / lock", () => {
  it("get 按 (id, user_id) 查询（owner 隔离不可省）", async () => {
    querySpy.mockImplementation(async () => ({ rows: [noteRow()] }));
    await repo.get(USER, NOTE);
    const [text, params] = querySpy.mock.calls[0]!;
    expect(text).toContain("FROM l3_study_notes");
    expect(text).toContain("id = $1::uuid AND user_id = $2::uuid");
    expect(params).toEqual([NOTE, USER]);
  });

  it("lock 带 FOR UPDATE；未绑定事务时拒绝（requireTx）", async () => {
    querySpy.mockImplementation(async () => ({ rows: [noteRow()] }));
    await repo.lock(USER, NOTE);
    expect(querySpy.mock.calls[0]![0]).toContain("FOR UPDATE");
    const noTx = new L3StudyNoteRepository();
    await expect(noTx.lock(USER, NOTE)).rejects.toThrow(/requires an active transaction/);
  });
});

describe("updateIfVersion（CAS）", () => {
  it("version 参与 WHERE、写后 +1 并记录 last_write 两列", async () => {
    querySpy.mockImplementation(async () => ({ rows: [noteRow({ version: 4 })] }));
    const row = await repo.updateIfVersion(USER, NOTE, 3, {
      title: "新标题", body_md: "新正文", status: "active", pinned: true,
      last_write_request_id: REQUEST, last_write_hash: "b".repeat(64),
    });
    const [text, params] = querySpy.mock.calls[0]!;
    expect(text).toContain("UPDATE l3_study_notes");
    expect(text).toContain("version = version + 1");
    expect(text).toContain("version = $3::integer");
    expect(text).toContain("last_write_request_id = $8::uuid");
    expect(text).toContain("last_write_hash = $9");
    expect(text).toContain("WHERE id = $1::uuid AND user_id = $2::uuid");
    expect(params).toEqual([
      NOTE, USER, 3, "新标题", "新正文", "active", true, REQUEST, "b".repeat(64),
    ]);
    expect(row?.version).toBe(4);
  });

  it("版本不匹配返回 null（不抛错，service 层转 409）", async () => {
    querySpy.mockImplementation(async () => ({ rows: [] }));
    const row = await repo.updateIfVersion(USER, NOTE, 1, {
      title: "", body_md: "", status: "active", pinned: false,
      last_write_request_id: REQUEST, last_write_hash: "c".repeat(64),
    });
    expect(row).toBeNull();
  });

  it("未绑定事务时拒绝（requireTx）", async () => {
    const noTx = new L3StudyNoteRepository();
    await expect(
      noTx.updateIfVersion(USER, NOTE, 1, {
        title: "", body_md: "", status: "active", pinned: false,
        last_write_request_id: REQUEST, last_write_hash: "c".repeat(64),
      }),
    ).rejects.toThrow(/requires an active transaction/);
  });
});

describe("replaceVenues", () => {
  it("先 DELETE 再批量 INSERT（unnest 单语句；整体替换语义）", async () => {
    querySpy.mockImplementation(async () => ({ rows: [] }));
    await repo.replaceVenues(USER, NOTE, ["cloze", "reading_choice"]);
    const text = querySpy.mock.calls.map((c) => c[0]).join("\n");
    expect(text).toContain("DELETE FROM l3_study_note_venues WHERE note_id = $1::uuid AND user_id = $2::uuid");
    expect(text).toContain("INSERT INTO l3_study_note_venues");
    expect(text).toContain("unnest($3::text[])");
    const insertCall = querySpy.mock.calls.find((c) => (c[0] as string).includes("INSERT INTO l3_study_note_venues"))!;
    expect(insertCall[1]).toEqual([NOTE, USER, ["cloze", "reading_choice"]]);
  });
});

describe("list", () => {
  beforeEach(() => {
    querySpy.mockImplementation(async (text: string) => {
      if ((text as string).includes("count(*)")) return { rows: [{ total: "3" }] };
      return { rows: [noteRow({ id: "n-1" }), noteRow({ id: "n-2" }), noteRow({ id: "n-3" })] };
    });
  });

  it("venue 过滤（必填）与 owner 条件同时在线", async () => {
    await repo.list({
      userId: USER, venue: "reading_choice", q: null, status: null, pinned: null,
      topicId: null, unfiled: false, cursor: null, limit: 21,
    });
    const text = querySpy.mock.calls.map((c) => c[0]).join("\n");
    expect(text).toContain("n.user_id = $1::uuid");
    expect(text).toContain("v.question_type = $2");
  });

  it("q 搜索标题与正文：% _ 转义 + ESCAPE", async () => {
    await repo.list({
      userId: USER, venue: "cloze", q: "100%_x", status: null, pinned: null,
      topicId: null, unfiled: false, cursor: null, limit: 21,
    });
    const text = querySpy.mock.calls.map((c) => c[0]).join("\n");
    expect(text).toContain("n.title ILIKE");
    expect(text).toContain("n.body_md ILIKE");
    expect(text).toContain("ESCAPE '\\'");
    const qParam = querySpy.mock.calls.flatMap((c) => c[1] as unknown[]).find(
      (p) => typeof p === "string" && p.includes("100"),
    );
    expect(qParam).toBe("%100\\%\\_x%");
  });

  it("默认排序 keyset：(n.updated_at, n.id) < ($ts, $id)", async () => {
    await repo.list({
      userId: USER, venue: "cloze", q: null, status: null, pinned: null,
      topicId: null, unfiled: false,
      cursor: { sortKind: "updatedAt", lastSort: "2026-09-19T00:00:00Z", id: NOTE, filter: "0123456789abcdef" },
      limit: 21,
    });
    const text = querySpy.mock.calls.map((c) => c[0]).join("\n");
    expect(text).toContain("(n.updated_at, n.id) <");
    expect(text).toContain("::timestamptz");
    expect(text).toContain("n.updated_at DESC, n.id DESC");
  });

  it("topicId 分支：position 升序 + (tn.position, n.id) > 续页", async () => {
    await repo.list({
      userId: USER, venue: "cloze", q: null, status: null, pinned: null,
      topicId: TOPIC, unfiled: false,
      cursor: { sortKind: "position", lastSort: "5", id: NOTE, filter: "0123456789abcdef" },
      limit: 21,
    });
    const text = querySpy.mock.calls.map((c) => c[0]).join("\n");
    expect(text).toContain("JOIN l3_study_topic_notes tn");
    expect(text).toContain("tn.topic_id = $3::uuid");
    expect(text).toContain("(tn.position, n.id) >");
    expect(text).toContain("tn.position ASC, n.id ASC");
  });

  it("unfiled 分支：NOT EXISTS 仅看 active 专题（归档专题成员仍视为未整理）", async () => {
    await repo.list({
      userId: USER, venue: "cloze", q: null, status: null, pinned: null,
      topicId: null, unfiled: true, cursor: null, limit: 21,
    });
    const text = querySpy.mock.calls.map((c) => c[0]).join("\n");
    expect(text).toContain("NOT EXISTS");
    expect(text).toContain("l3_study_topic_notes");
    expect(text).toContain("t.status = 'active'");
  });

  it("status/pinned 过滤；count 为过滤条件总数（不含游标），list 含 keyset 且 limit 透传", async () => {
    const { items, total } = await repo.list({
      userId: USER, venue: "cloze", q: null, status: "archived", pinned: true,
      topicId: null, unfiled: false,
      cursor: { sortKind: "updatedAt", lastSort: "2026-09-19T00:00:00Z", id: NOTE, filter: "0123456789abcdef" },
      limit: 21,
    });
    const countCall = querySpy.mock.calls.find((c) => (c[0] as string).includes("count(*)"))!;
    expect(countCall[0]).toContain("n.status =");
    expect(countCall[0]).toContain("n.pinned =");
    expect(countCall[0]).not.toContain("(n.updated_at, n.id) <");
    // count 的参数必须恰为过滤参数（不含游标——真实 PG 会因占位符不匹配报错）
    expect(countCall[1]).toEqual([USER, "cloze", "archived", true]);
    const listCall = querySpy.mock.calls.find((c) => (c[0] as string).includes("ORDER BY"))!;
    expect(listCall[0]).toContain("(n.updated_at, n.id) <");
    expect(listCall[1]).toContain(21);
    expect(total).toBe(3);
    expect(items.length).toBe(3);
  });
});

describe("listTopicBlockers", () => {
  it("按给定题型集合列出 note 所属专题（含归档专题——成员关系仍在）", async () => {
    querySpy.mockImplementation(async () => ({ rows: [{ topic_id: TOPIC, title: "阅读专题" }] }));
    const blockers = await repo.listTopicBlockers(USER, NOTE, ["reading_choice"]);
    const [text, params] = querySpy.mock.calls[0]!;
    expect(text).toContain("FROM l3_study_topic_notes tn");
    expect(text).toContain("JOIN l3_study_topics t");
    expect(text).toContain("t.question_type = ANY($3::text[])");
    expect(params).toEqual([USER, NOTE, ["reading_choice"]]);
    expect(blockers[0]).toMatchObject({ topic_id: TOPIC, title: "阅读专题" });
  });
});

describe("补齐：幂等回查 / 归属读取 / 边界早退", () => {
  it("findByCreateRequestId 按 (user_id, create_request_id) 查询", async () => {
    querySpy.mockImplementation(async () => ({ rows: [noteRow()] }));
    const row = await repo.findByCreateRequestId(USER, REQUEST);
    const [text, params] = querySpy.mock.calls[0]!;
    expect(text).toContain("user_id = $1::uuid AND create_request_id = $2::uuid");
    expect(params).toEqual([USER, REQUEST]);
    expect(row?.id).toBe(NOTE);
  });

  it("listVenues / listVenuesForNotes 返回题型集合；空输入不产生查询", async () => {
    querySpy.mockImplementation(async () => ({ rows: [{ question_type: "cloze" }] }));
    expect(await repo.listVenues(USER, NOTE)).toEqual(["cloze"]);

    querySpy.mockImplementation(async () => ({
      rows: [
        { note_id: NOTE, question_type: "cloze" },
        { note_id: NOTE, question_type: "reading_choice" },
        { note_id: "00000000-0000-4000-8000-000000000102", question_type: "cloze" },
      ],
    }));
    const map = await repo.listVenuesForNotes(USER, [NOTE, "00000000-0000-4000-8000-000000000102"]);
    expect(map.get(NOTE)).toEqual(["cloze", "reading_choice"]);
    expect(map.get("00000000-0000-4000-8000-000000000102")).toEqual(["cloze"]);

    const callsBefore = querySpy.mock.calls.length;
    const empty = await repo.listVenuesForNotes(USER, []);
    expect(empty.size).toBe(0);
    expect(querySpy.mock.calls.length).toBe(callsBefore);
  });

  it("replaceVenues 空数组只 DELETE 不 INSERT", async () => {
    querySpy.mockImplementation(async () => ({ rows: [] }));
    await repo.replaceVenues(USER, NOTE, []);
    const text = querySpy.mock.calls.map((c) => c[0]).join("\n");
    expect(text).toContain("DELETE FROM l3_study_note_venues");
    expect(text).not.toContain("INSERT INTO");
  });
});

// ── F1（补修批次）：幂等创建（ON CONFLICT DO NOTHING，不使事务失败）──────────

describe("createIfAbsent（F1）", () => {
  it("仅对 (user_id, create_request_id) 执行 ON CONFLICT DO NOTHING + RETURNING *；0 行返回 null", async () => {
    querySpy.mockImplementation(async () => ({ rows: [] }));
    const result = await repo.createIfAbsent({
      id: NOTE, user_id: USER, title: "", body_md: "", status: "active", pinned: false,
      version: 1, create_request_id: REQUEST, create_input_hash: "a".repeat(64),
    });
    expect(result).toBeNull();
    const [text, params] = querySpy.mock.calls[0]!;
    expect(text).toContain("INSERT INTO l3_study_notes");
    expect(text).toContain("ON CONFLICT (user_id, create_request_id) DO NOTHING");
    expect(text).toContain("RETURNING *");
    expect(params).toEqual([
      NOTE, USER, "", "", "active", false, 1, REQUEST, "a".repeat(64),
    ]);
  });

  it("插入成功返回整行（与普通 create 同参数口径）", async () => {
    querySpy.mockImplementation(async () => ({ rows: [noteRow({ title: "" })] }));
    const row = await repo.createIfAbsent({
      id: NOTE, user_id: USER, title: "", body_md: "", status: "active", pinned: false,
      version: 1, create_request_id: REQUEST, create_input_hash: "a".repeat(64),
    });
    expect(row).toMatchObject({ id: NOTE, create_request_id: REQUEST });
  });
});
