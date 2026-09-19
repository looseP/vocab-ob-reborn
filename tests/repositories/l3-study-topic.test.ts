/**
 * L3StudyTopicRepository 单元测试（fake PoolClient，无真实 DB）：
 * create/get/lock/updateIfVersion/list/listMembers/insertMember/deleteMember/
 * replaceMemberPositions（0..n-1 批重排）/countMembers。
 * SQL 形态与参数顺序断言（真实 PG 行为见集成测试）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import { L3StudyTopicRepository } from "@/repositories/l3-study-topics.repository";

const USER = "00000000-0000-4000-8000-0000000000a1";
const TOPIC = "00000000-0000-4000-8000-000000000111";
const NOTE = "00000000-0000-4000-8000-000000000101";
const NOTE_B = "00000000-0000-4000-8000-000000000102";
const REQUEST = "00000000-0000-4000-8000-000000000121";

function fakeClient(): PoolClient {
  return { query: vi.fn(async () => ({ rows: [] as unknown[] })) } as unknown as PoolClient;
}

function topicRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: TOPIC, user_id: USER, question_type: "reading_choice", title: "专题", status: "active",
    version: 1, create_request_id: REQUEST, create_input_hash: "a".repeat(64),
    last_write_request_id: null, last_write_hash: null,
    created_at: "2026-09-19T00:00:00Z", updated_at: "2026-09-19T00:00:00Z",
    ...overrides,
  };
}

let client: PoolClient;
let repo: L3StudyTopicRepository;
let querySpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  client = fakeClient();
  querySpy = client.query as unknown as ReturnType<typeof vi.fn>;
  repo = new L3StudyTopicRepository(client);
});

describe("create / get / lock", () => {
  it("create INSERT 全列并 RETURNING *", async () => {
    querySpy.mockImplementation(async () => ({ rows: [topicRow()] }));
    await repo.create({
      id: TOPIC, user_id: USER, question_type: "reading_choice", title: "专题", status: "active",
      version: 1, create_request_id: REQUEST, create_input_hash: "a".repeat(64),
    });
    const [text, params] = querySpy.mock.calls[0]!;
    expect(text).toContain("INSERT INTO l3_study_topics");
    expect(text).toContain("RETURNING *");
    expect(params).toEqual([TOPIC, USER, "reading_choice", "专题", "active", 1, REQUEST, "a".repeat(64)]);
  });

  it("get 按 (id, user_id)；lock 带 FOR UPDATE 且 requireTx", async () => {
    querySpy.mockImplementation(async () => ({ rows: [topicRow()] }));
    await repo.get(USER, TOPIC);
    expect(querySpy.mock.calls[0]![0]).toContain("id = $1::uuid AND user_id = $2::uuid");
    await repo.lock(USER, TOPIC);
    expect(querySpy.mock.calls[1]![0]).toContain("FOR UPDATE");
    const noTx = new L3StudyTopicRepository();
    await expect(noTx.lock(USER, TOPIC)).rejects.toThrow(/requires an active transaction/);
  });
});

describe("updateIfVersion（CAS + 幂等列）", () => {
  it("version 参与 WHERE 并 +1，last_write 两列同写", async () => {
    querySpy.mockImplementation(async () => ({ rows: [topicRow({ version: 2 })] }));
    await repo.updateIfVersion(USER, TOPIC, 1, {
      title: "改名", status: "archived",
      last_write_request_id: REQUEST, last_write_hash: "d".repeat(64),
    });
    const [text, params] = querySpy.mock.calls[0]!;
    expect(text).toContain("UPDATE l3_study_topics");
    expect(text).toContain("version = version + 1");
    expect(text).toContain("version = $3::integer");
    expect(params).toEqual([TOPIC, USER, 1, "改名", "archived", REQUEST, "d".repeat(64)]);
  });
});

describe("list", () => {
  it("venue + status 过滤与 (updated_at,id) keyset", async () => {
    querySpy.mockImplementation(async (text: string) => {
      if ((text as string).includes("count(*)")) return { rows: [{ total: "1" }] };
      return { rows: [topicRow()] };
    });
    await repo.list({
      userId: USER, questionType: "reading_choice", status: "active",
      cursor: { updatedAt: "2026-09-19T00:00:00Z", id: TOPIC }, limit: 21,
    });
    const text = querySpy.mock.calls.map((c) => c[0]).join("\n");
    expect(text).toContain("t.user_id = $1::uuid");
    expect(text).toContain("t.question_type = $2");
    expect(text).toContain("t.status = $3");
    expect(text).toContain("(t.updated_at, t.id) <");
  });
});

describe("members", () => {
  it("listMembers 按 (position, note_id) 升序", async () => {
    querySpy.mockImplementation(async () => ({ rows: [{ note_id: NOTE, position: 0 }] }));
    const members = await repo.listMembers(USER, TOPIC);
    const [text, params] = querySpy.mock.calls[0]!;
    expect(text).toContain("ORDER BY position ASC, note_id ASC");
    expect(params).toEqual([TOPIC, USER]);
    expect(members[0]).toEqual({ note_id: NOTE, position: 0 });
  });

  it("countMembers 返回计数", async () => {
    querySpy.mockImplementation(async () => ({ rows: [{ n: "7" }] }));
    const n = await repo.countMembers(USER, TOPIC);
    expect(querySpy.mock.calls[0]![0]).toContain("count(*)");
    expect(n).toBe(7);
  });

  it("insertMember 落到 (topic_id, note_id, user_id, position)", async () => {
    querySpy.mockImplementation(async () => ({ rows: [] }));
    await repo.insertMember({ topicId: TOPIC, noteId: NOTE, userId: USER, position: 3 });
    const [text, params] = querySpy.mock.calls[0]!;
    expect(text).toContain("INSERT INTO l3_study_topic_notes");
    expect(params).toEqual([TOPIC, NOTE, USER, 3]);
  });

  it("deleteMember 返回是否删除（owner 条件不可省）", async () => {
    querySpy.mockImplementation(async () => ({ rows: [], rowCount: 1 }));
    const deleted = await repo.deleteMember(USER, TOPIC, NOTE);
    const [text, params] = querySpy.mock.calls[0]!;
    expect(text).toContain("DELETE FROM l3_study_topic_notes");
    expect(text).toContain("topic_id = $1::uuid AND note_id = $2::uuid AND user_id = $3::uuid");
    expect(params).toEqual([TOPIC, NOTE, USER]);
    expect(deleted).toBe(true);
  });

  it("replaceMemberPositions：WITH ORDINALITY 批重排 0..n-1", async () => {
    querySpy.mockImplementation(async () => ({ rows: [] }));
    await repo.replaceMemberPositions(USER, TOPIC, [NOTE_B, NOTE]);
    const [text, params] = querySpy.mock.calls[0]!;
    expect(text).toContain("WITH ORDINALITY AS o(note_id, ord)");
    expect(text).toContain("SET position = o.ord - 1");
    expect(text).toContain("AND tn.note_id = o.note_id");
    expect(params).toEqual([TOPIC, USER, [NOTE_B, NOTE]]);
  });

  it("写操作在无事务时拒绝（requireTx：insertMember/deleteMember/replaceMemberPositions）", async () => {
    const noTx = new L3StudyTopicRepository();
    await expect(noTx.insertMember({ topicId: TOPIC, noteId: NOTE, userId: USER, position: 0 }))
      .rejects.toThrow(/requires an active transaction/);
    await expect(noTx.deleteMember(USER, TOPIC, NOTE)).rejects.toThrow(/requires an active transaction/);
    await expect(noTx.replaceMemberPositions(USER, TOPIC, [])).rejects.toThrow(/requires an active transaction/);
  });
});

describe("补齐：幂等回查 / 版本推进 / 批量计数 / 边界早退", () => {
  it("findByCreateRequestId 按 (user_id, create_request_id)", async () => {
    querySpy.mockImplementation(async () => ({ rows: [topicRow()] }));
    const row = await repo.findByCreateRequestId(USER, REQUEST);
    const [text, params] = querySpy.mock.calls[0]!;
    expect(text).toContain("user_id = $1::uuid AND create_request_id = $2::uuid");
    expect(params).toEqual([USER, REQUEST]);
    expect(row?.id).toBe(TOPIC);
  });

  it("bumpVersion：仅推进版本与幂等列（不动 title/status）；version 参与 WHERE", async () => {
    querySpy.mockImplementation(async () => ({ rows: [topicRow({ version: 3 })] }));
    const row = await repo.bumpVersion(USER, TOPIC, 2, REQUEST, "c".repeat(64));
    const [text, params] = querySpy.mock.calls[0]!;
    expect(text).toContain("version = version + 1");
    expect(text).toContain("version = $3::integer");
    expect(text).not.toContain("title =");
    expect(params).toEqual([TOPIC, USER, 2, REQUEST, "c".repeat(64)]);
    expect(row?.version).toBe(3);
  });

  it("countMembersForTopics 聚合返回；空输入不产生查询", async () => {
    querySpy.mockImplementation(async () => ({
      rows: [{ topic_id: TOPIC, n: "5" }, { topic_id: "00000000-0000-4000-8000-000000000222", n: "2" }],
    }));
    const map = await repo.countMembersForTopics(USER, [TOPIC, "00000000-0000-4000-8000-000000000222"]);
    expect(map.get(TOPIC)).toBe(5);
    expect(map.get("00000000-0000-4000-8000-000000000222")).toBe(2);

    const callsBefore = querySpy.mock.calls.length;
    const empty = await repo.countMembersForTopics(USER, []);
    expect(empty.size).toBe(0);
    expect(querySpy.mock.calls.length).toBe(callsBefore);
  });

  it("replaceMemberPositions 空列表不产生写入", async () => {
    querySpy.mockImplementation(async () => ({ rows: [] }));
    await repo.replaceMemberPositions(USER, TOPIC, []);
    expect(querySpy.mock.calls.length).toBe(0);
  });
});
