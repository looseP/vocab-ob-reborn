/**
 * L3StudyNoteService 单元测试（fake repos + fake 引用服务）：
 * 创建/保存幂等（最后一次请求语义）、版本冲突（409 只带 currentVersion）、
 * 归属 blocker、marker 集合校验、keep/capture 引用规则、快照限额、
 * 专题成员加入/移动/移除（空操作版本递增）与归档约束。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConflictError, NotFoundError, ValidationError } from "@/errors";
import {
  L3StudyNoteService,
  computeSaveRequestHash,
  type StudyNoteRepos,
} from "@/services/l3-study-notes.service";
import type { L3StudyNoteRow } from "@/repositories/l3-study-notes.repository";
import type { L3StudyTopicRow } from "@/repositories/l3-study-topics.repository";
import type { ReferenceTarget, SaveNoteInput } from "@/domain/l3-study-notes";

const USER = "00000000-0000-4000-8000-0000000000a1";
const NOTE = "00000000-0000-4000-8000-000000000101";
const TOPIC = "00000000-0000-4000-8000-000000000111";
const REQ = "00000000-0000-4000-8000-000000000121";
const REQ_B = "00000000-0000-4000-8000-000000000122";
const REF = "00000000-0000-4000-8000-000000000001";
const REF_B = "00000000-0000-4000-8000-000000000002";
const SOURCE = "00000000-0000-4000-8000-000000000201";
const QUESTION = "00000000-0000-4000-8000-000000000211";

function noteRow(overrides: Partial<L3StudyNoteRow> = {}): L3StudyNoteRow {
  return {
    id: NOTE, user_id: USER, title: "", body_md: "", status: "active", pinned: false,
    version: 1, create_request_id: REQ, create_input_hash: "a".repeat(64),
    last_write_request_id: null, last_write_hash: null,
    created_at: "2026-09-19T00:00:00Z", updated_at: "2026-09-19T00:00:00Z",
    ...overrides,
  };
}

function topicRow(overrides: Partial<L3StudyTopicRow> = {}): L3StudyTopicRow {
  return {
    id: TOPIC, user_id: USER, question_type: "reading_choice", title: "专题", status: "active",
    version: 1, create_request_id: REQ, create_input_hash: "b".repeat(64),
    last_write_request_id: null, last_write_hash: null,
    created_at: "2026-09-19T00:00:00Z", updated_at: "2026-09-19T00:00:00Z",
    ...overrides,
  };
}

function baseSaveInput(overrides: Partial<SaveNoteInput> = {}): SaveNoteInput {
  return {
    expectedVersion: 1,
    requestId: REQ,
    title: "标题",
    bodyMd: "正文",
    venues: ["reading_choice"],
    pinned: false,
    status: "active",
    references: [],
    ...overrides,
  };
}

type AnyFn = ReturnType<typeof vi.fn>;

interface FakeRepos {
  studyNotes: Record<string, AnyFn>;
  studyTopics: Record<string, AnyFn>;
  studyReferences: Record<string, AnyFn>;
}

function fakeRepos(overrides: {
  studyNotes?: Record<string, unknown>;
  studyTopics?: Record<string, unknown>;
  studyReferences?: Record<string, unknown>;
} = {}): FakeRepos {
  return {
    studyNotes: {
      create: vi.fn(async (input: Record<string, unknown>) => noteRow({ ...input, id: (input.id as string) ?? NOTE })),
      createIfAbsent: vi.fn(async (input: Record<string, unknown>) => noteRow({ ...input, id: (input.id as string) ?? NOTE })),
      get: vi.fn(async () => noteRow()),
      findByCreateRequestId: vi.fn(async () => null),
      lock: vi.fn(async () => noteRow()),
      updateIfVersion: vi.fn(async () => noteRow({ version: 2 })),
      replaceVenues: vi.fn(async () => undefined),
      listVenues: vi.fn(async () => ["reading_choice"]),
      listVenuesForNotes: vi.fn(async () => new Map()),
      list: vi.fn(async () => ({ items: [], total: 0 })),
      listTopicBlockers: vi.fn(async () => []),
      ...overrides.studyNotes,
    },
    studyTopics: {
      create: vi.fn(async (input: Record<string, unknown>) => topicRow({ ...input, id: (input.id as string) ?? TOPIC })),
      createIfAbsent: vi.fn(async (input: Record<string, unknown>) => topicRow({ ...input, id: (input.id as string) ?? TOPIC })),
      get: vi.fn(async () => topicRow()),
      findByCreateRequestId: vi.fn(async () => null),
      lock: vi.fn(async () => topicRow()),
      updateIfVersion: vi.fn(async () => topicRow({ version: 2 })),
      bumpVersion: vi.fn(async () => topicRow({ version: 2 })),
      list: vi.fn(async () => ({ items: [], total: 0 })),
      listMembers: vi.fn(async () => []),
      countMembers: vi.fn(async () => 0),
      countMembersForTopics: vi.fn(async () => new Map()),
      insertMember: vi.fn(async () => undefined),
      deleteMember: vi.fn(async () => false),
      replaceMemberPositions: vi.fn(async () => undefined),
      ...overrides.studyTopics,
    },
    studyReferences: {
      listForNote: vi.fn(async () => []),
      findReferenceOwners: vi.fn(async () => new Map()),
      replaceForNote: vi.fn(async () => undefined),
      searchTargets: vi.fn(async () => ({ items: [], total: 0 })),
      loadTargets: vi.fn(async () => new Map()),
      lockTargets: vi.fn(async () => undefined),
      listBacklinks: vi.fn(async () => ({ items: [], total: 0 })),
      getSourceDeleteBlockers: vi.fn(async () => []),
      getQuestionDeleteBlockers: vi.fn(async () => []),
      ...overrides.studyReferences,
    },
  };
}

function fakeReferenceService() {
  return {
    captureAgainst: vi.fn((target: ReferenceTarget) => ({
      kind: target.kind,
      source_id: "sourceId" in target ? target.sourceId : null,
      question_id: "questionId" in target ? target.questionId : null,
      option_key: "optionKey" in target ? target.optionKey : null,
      start_offset: "start" in target ? target.start : null,
      end_offset: "end" in target ? target.end : null,
      quote_snapshot: "quote" in target ? target.quote : null,
      field_hash: "f".repeat(64),
      display_snapshot: { kind: target.kind },
    })),
    resolve: vi.fn(async (_userId: string, rows: readonly { id: string }[]) =>
      rows.map((row) => ({
        id: row.id, target: { kind: "source", sourceId: SOURCE }, status: "current",
        capturedAt: "2026-09-19T00:00:00Z", displaySnapshot: { kind: "source" }, liveTitle: null,
      })),
    ),
  };
}

let repos: ReturnType<typeof fakeRepos>;
let referenceService: ReturnType<typeof fakeReferenceService>;
let service: L3StudyNoteService;

beforeEach(() => {
  repos = fakeRepos();
  referenceService = fakeReferenceService();
  const txRunner = (async (callback: (tx: unknown) => Promise<unknown>) => callback({})) as never;
  service = new L3StudyNoteService(
    txRunner,
    () => repos as unknown as StudyNoteRepos,
    referenceService as never,
  );
});

describe("create · 幂等与自由创建", () => {
  it("新请求创建空白笔记并挂初始题型归属（created=true；F1：走 createIfAbsent）", async () => {
    const result = await service.create(USER, { requestId: REQ, venue: "reading_choice" });
    expect(result.created).toBe(true);
    expect(repos.studyNotes.createIfAbsent).toHaveBeenCalledWith(expect.objectContaining({
      user_id: USER, title: "", body_md: "", version: 1, create_request_id: REQ,
    }));
    expect(repos.studyNotes.create).not.toHaveBeenCalled();
    expect(repos.studyNotes.replaceVenues).toHaveBeenCalledWith(USER, expect.any(String), ["reading_choice"]);
  });

  it("同 requestId 同输入重试返回当前笔记（created=false，不重置内容、不再建）", async () => {
    const existingRow = noteRow({
      title: "已编辑过的标题",
      create_input_hash: (await import("node:crypto")).createHash("sha256").update(JSON.stringify({ venue: "reading_choice" })).digest("hex"),
    });
    repos.studyNotes.findByCreateRequestId = vi.fn(async () => existingRow);
    repos.studyNotes.lock = vi.fn(async () => existingRow); // F2：复用路径先锁行再组装
    const result = await service.create(USER, { requestId: REQ, venue: "reading_choice" });
    expect(result.created).toBe(false);
    expect(result.item.title).toBe("已编辑过的标题");
    expect(repos.studyNotes.createIfAbsent).not.toHaveBeenCalled();
  });

  it("同 requestId 不同输入 → 409", async () => {
    repos.studyNotes.findByCreateRequestId = vi.fn(async () =>
      noteRow({ create_input_hash: "0".repeat(64) }),
    );
    await expect(service.create(USER, { requestId: REQ, venue: "cloze" })).rejects.toThrow(ConflictError);
  });
});

describe("save · 幂等 / 版本 / 原子", () => {
  it("相同 requestId 相同 payload 重试：返回当前结果，不二次推进版本", async () => {
    const input = baseSaveInput();
    const hash = computeSaveRequestHash(input);
    repos.studyNotes.lock = vi.fn(async () =>
      noteRow({ version: 2, last_write_request_id: REQ, last_write_hash: hash }),
    );
    const result = await service.save(USER, NOTE, input);
    expect(result.item.version).toBe(2);
    expect(repos.studyNotes.updateIfVersion).not.toHaveBeenCalled();
    expect(repos.studyNotes.replaceVenues).not.toHaveBeenCalled();
    expect(repos.studyReferences.replaceForNote).not.toHaveBeenCalled();
  });

  it("同 requestId 不同 payload → 409（不覆盖、不推进）", async () => {
    const hash = computeSaveRequestHash(baseSaveInput());
    repos.studyNotes.lock = vi.fn(async () =>
      noteRow({ version: 2, last_write_request_id: REQ, last_write_hash: hash }),
    );
    await expect(
      service.save(USER, NOTE, baseSaveInput({ title: "改了标题" })),
    ).rejects.toThrow(ConflictError);
    expect(repos.studyNotes.updateIfVersion).not.toHaveBeenCalled();
  });

  it("旧版本保存 → 409 且只返回 currentVersion", async () => {
    repos.studyNotes.lock = vi.fn(async () => noteRow({ version: 5 }));
    const error = await service.save(USER, NOTE, baseSaveInput({ expectedVersion: 3 })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictError);
    expect((error as ConflictError).meta).toEqual({ noteId: NOTE, currentVersion: 5 });
    expect(repos.studyNotes.updateIfVersion).not.toHaveBeenCalled();
  });

  it("无权限（note 不存在/他人）→ 404 先于版本细节", async () => {
    repos.studyNotes.lock = vi.fn(async () => null);
    await expect(service.save(USER, NOTE, baseSaveInput({ expectedVersion: 999 }))).rejects.toThrow(NotFoundError);
  });

  it("成功保存：CAS 携带 expectedVersion 与 last_write 两列；归属与引用同事务替换", async () => {
    const input = baseSaveInput();
    await service.save(USER, NOTE, input);
    const hash = computeSaveRequestHash(input);
    expect(repos.studyNotes.updateIfVersion).toHaveBeenCalledWith(USER, NOTE, 1, expect.objectContaining({
      title: "标题", body_md: "正文", last_write_request_id: REQ, last_write_hash: hash,
    }));
    expect(repos.studyNotes.replaceVenues).toHaveBeenCalledWith(USER, NOTE, ["reading_choice"]);
    expect(repos.studyReferences.replaceForNote).toHaveBeenCalledWith(USER, NOTE, []);
  });

  it("引用替换失败 → 整体拒绝（不吞错；真实回滚由事务层保证）", async () => {
    repos.studyReferences.replaceForNote = vi.fn(async () => {
      throw new Error("boom");
    });
    await expect(service.save(USER, NOTE, baseSaveInput())).rejects.toThrow("boom");
  });

  it("marker 与引用集合不一致 → 422（bodyMd 字段）", async () => {
    const input = baseSaveInput({ bodyMd: `[[ref:${REF}]]`, references: [] });
    const error = await service.save(USER, NOTE, input).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).field).toBe("bodyMd");
  });

  it("移除归属仍被该题型专题占用 → 409 并列出专题", async () => {
    repos.studyNotes.listVenues = vi.fn(async () => ["reading_choice", "cloze"]);
    repos.studyNotes.listTopicBlockers = vi.fn(async () => [
      { topic_id: TOPIC, title: "阅读专题", status: "active" },
    ]);
    const error = await service
      .save(USER, NOTE, baseSaveInput({ venues: ["cloze"] }))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictError);
    expect(repos.studyNotes.listTopicBlockers).toHaveBeenCalledWith(USER, NOTE, ["reading_choice"]);
    expect((error as ConflictError).meta).toMatchObject({
      blockers: { topics: [{ id: TOPIC, title: "阅读专题", status: "active" }] },
    });
  });
});

describe("save · 引用规则（keep / capture / 限额）", () => {
  it("keep 必须已属于当前笔记 → 否则 422", async () => {
    repos.studyReferences.listForNote = vi.fn(async () => []); // 当前无引用
    const input = baseSaveInput({
      bodyMd: `[[ref:${REF}]]`,
      references: [{ id: REF, action: "keep" }],
    });
    const error = await service.save(USER, NOTE, input).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ValidationError);
  });

  it("keep 保留原摘录与 capturedAt（不重读目标、不调用 lockTargets）", async () => {
    const existing = {
      id: REF, note_id: NOTE, user_id: USER, kind: "source_quote" as const,
      source_id: SOURCE, question_id: null, option_key: null, start_offset: 0, end_offset: 3,
      quote_snapshot: "The", field_hash: "e".repeat(64), display_snapshot: { kind: "source_quote", title: "T", quote: "The" },
      captured_at: "2026-09-01T00:00:00.000Z",
    };
    repos.studyReferences.listForNote = vi.fn(async () => [existing]);
    const input = baseSaveInput({
      bodyMd: `[[ref:${REF}]]`,
      references: [{ id: REF, action: "keep" }],
    });
    await service.save(USER, NOTE, input);
    const rows = repos.studyReferences.replaceForNote.mock.calls[0]![2] as { captured_at: string; quote_snapshot: string }[];
    expect(rows[0]).toMatchObject({ captured_at: "2026-09-01T00:00:00.000Z", quote_snapshot: "The" });
    expect(repos.studyReferences.lockTargets).not.toHaveBeenCalled();
  });

  it("capture：先 lockTargets 再经引用服务生成快照；被其他笔记使用的 id → 409", async () => {
    repos.studyReferences.findReferenceOwners = vi.fn(async () => new Map([[REF, "other-note"]]));
    const input = baseSaveInput({
      bodyMd: `[[ref:${REF}]]`,
      references: [{ id: REF, action: "capture", target: { kind: "source", sourceId: SOURCE } }],
    });
    const error = await service.save(USER, NOTE, input).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictError);

    // 正常路径：全新 id
    repos.studyReferences.findReferenceOwners = vi.fn(async () => new Map());
    const loadedMap = new Map([[
      `source:${SOURCE}`,
      { kind: "source" as const, id: SOURCE, title: "T", content_text: "The quick" },
    ]]);
    repos.studyReferences.loadTargets = vi.fn(async () => loadedMap as never);
    const input2 = baseSaveInput({
      bodyMd: `[[ref:${REF_B}]]`,
      references: [{ id: REF_B, action: "capture", target: { kind: "source", sourceId: SOURCE } }],
    });
    await service.save(USER, NOTE, input2);
    expect(repos.studyReferences.lockTargets).toHaveBeenCalledWith(USER, [{ kind: "source", id: SOURCE }]);
    expect(referenceService.captureAgainst).toHaveBeenCalled();
  });

  it("快照序列化总量 > 2MiB → 422", async () => {
    referenceService.captureAgainst = vi.fn(() => ({
      kind: "source" as const, source_id: SOURCE, question_id: null, option_key: null,
      start_offset: null, end_offset: null, quote_snapshot: null,
      field_hash: "f".repeat(64),
      display_snapshot: { kind: "source", title: "T", excerpt: "x".repeat(2 * 1024 * 1024 + 16) },
    })) as never;
    repos.studyReferences.loadTargets = vi.fn(async () =>
      new Map([[
        `source:${SOURCE}`,
        { kind: "source", id: SOURCE, title: "T", content_text: "x" },
      ]]) as never,
    );
    const input = baseSaveInput({
      bodyMd: `[[ref:${REF}]]`,
      references: [{ id: REF, action: "capture", target: { kind: "source", sourceId: SOURCE } }],
    });
    const error = await service.save(USER, NOTE, input).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ValidationError);
  });
});

describe("topics · 成员操作", () => {
  it("加入成员：锁序 topic → note → 归属校验 → insertMember + 重排 + bumpVersion", async () => {
    repos.studyTopics.listMembers = vi.fn(async () => []);
    repos.studyTopics.insertMember = vi.fn(async () => undefined);
    await service.moveTopicMember(USER, TOPIC, NOTE, {
      requestId: REQ, expectedVersion: 1, beforeNoteId: null,
    });
    expect(repos.studyTopics.lock).toHaveBeenCalledWith(USER, TOPIC);
    expect(repos.studyNotes.lock).toHaveBeenCalledWith(USER, NOTE);
    // 锁序：topic 锁先于 note 锁（防与 note save 的竞态破坏成员不变量）
    expect(repos.studyTopics.lock.mock.invocationCallOrder[0]!)
      .toBeLessThan(repos.studyNotes.lock.mock.invocationCallOrder[0]!);
    expect(repos.studyNotes.listVenues).toHaveBeenCalledWith(USER, NOTE);
    expect(repos.studyTopics.insertMember).toHaveBeenCalledWith({
      topicId: TOPIC, noteId: NOTE, userId: USER, position: 0,
    });
    expect(repos.studyTopics.replaceMemberPositions).toHaveBeenCalledWith(USER, TOPIC, [NOTE]);
    expect(repos.studyTopics.bumpVersion).toHaveBeenCalled();
  });

  it("note 不存在/他人 → 404（由 note 锁决定）", async () => {
    repos.studyNotes.lock = vi.fn(async () => null);
    await expect(
      service.moveTopicMember(USER, TOPIC, NOTE, { requestId: REQ, expectedVersion: 1, beforeNoteId: null }),
    ).rejects.toThrow(NotFoundError);
  });

  it("跨题型未归属 → 409；归档 topic → 409；beforeNoteId 非本专题成员 → 422", async () => {
    repos.studyNotes.listVenues = vi.fn(async () => ["cloze"]);
    await expect(
      service.moveTopicMember(USER, TOPIC, NOTE, { requestId: REQ, expectedVersion: 1, beforeNoteId: null }),
    ).rejects.toThrow(ConflictError);

    repos.studyNotes.listVenues = vi.fn(async () => ["reading_choice"]);
    repos.studyTopics.lock = vi.fn(async () => topicRow({ status: "archived" }));
    await expect(
      service.moveTopicMember(USER, TOPIC, NOTE, { requestId: REQ, expectedVersion: 1, beforeNoteId: null }),
    ).rejects.toThrow(ConflictError);

    repos.studyTopics.lock = vi.fn(async () => topicRow());
    repos.studyTopics.listMembers = vi.fn(async () => [{ note_id: "other-note", position: 0 }]);
    await expect(
      service.moveTopicMember(USER, TOPIC, NOTE, { requestId: REQ, expectedVersion: 1, beforeNoteId: REF_B }),
    ).rejects.toThrow(ValidationError);
  });

  it("移动成员：从任意位置插到 beforeNoteId 之前（重排完整顺序）", async () => {
    const N_B = "00000000-0000-4000-8000-000000000102";
    const N_C = "00000000-0000-4000-8000-000000000103";
    // 当前顺序 [NOTE, N_B, N_C]；把 N_C 移到 NOTE 之前 → [N_C, NOTE, N_B]
    repos.studyTopics.listMembers = vi.fn(async () => [
      { note_id: NOTE, position: 0 },
      { note_id: N_B, position: 1 },
      { note_id: N_C, position: 2 },
    ]);
    await service.moveTopicMember(USER, TOPIC, N_C, {
      requestId: REQ, expectedVersion: 1, beforeNoteId: NOTE,
    });
    expect(repos.studyTopics.replaceMemberPositions).toHaveBeenCalledWith(USER, TOPIC, [N_C, NOTE, N_B]);
  });

  it("移出空操作（成员不存在）：版本仍递增（固定语义）", async () => {
    repos.studyTopics.deleteMember = vi.fn(async () => false);
    await service.removeTopicMember(USER, TOPIC, NOTE, { requestId: REQ, expectedVersion: 1 });
    expect(repos.studyTopics.deleteMember).toHaveBeenCalledWith(USER, TOPIC, NOTE);
    expect(repos.studyTopics.replaceMemberPositions).not.toHaveBeenCalled();
    expect(repos.studyTopics.bumpVersion).toHaveBeenCalled();
  });

  it("成员上限 500：新增时超限 → 422", async () => {
    repos.studyTopics.listMembers = vi.fn(async () =>
      Array.from({ length: 500 }, (_, i) => ({ note_id: `n-${i}`, position: i })),
    );
    await expect(
      service.moveTopicMember(USER, TOPIC, NOTE, { requestId: REQ, expectedVersion: 1, beforeNoteId: null }),
    ).rejects.toThrow(ValidationError);
  });

  it("相同 requestId 重试返回当前 topic（不重复操作）", async () => {
    const { computeMemberOpHash } = await import("@/services/l3-study-notes.service");
    const opHash = computeMemberOpHash({ op: "move", expectedVersion: 1, noteId: NOTE, beforeNoteId: null });
    repos.studyTopics.lock = vi.fn(async () =>
      topicRow({ version: 2, last_write_request_id: REQ, last_write_hash: opHash }),
    );
    await service.moveTopicMember(USER, TOPIC, NOTE, {
      requestId: REQ, expectedVersion: 1, beforeNoteId: null,
    });
    expect(repos.studyTopics.insertMember).not.toHaveBeenCalled();
    expect(repos.studyTopics.replaceMemberPositions).not.toHaveBeenCalled();
  });
});

describe("list · cursor 过滤绑定", () => {
  it("过滤指纹不符的 cursor → 400（不能将 A 过滤/专题的 cursor 用于 B）", async () => {
    const { encodeStudyCursor, studyFilterFingerprint } = await import("@/repositories/l3-study-cursor");
    const wrongFilter = studyFilterFingerprint(["cloze", null, null, null, false, null]);
    const cursor = encodeStudyCursor({
      sortKind: "updatedAt", lastSort: "2026-09-19T00:00:00Z", id: NOTE, filter: wrongFilter,
    });
    await expect(
      service.list(USER, { venue: "reading_choice", cursor }),
    ).rejects.toThrow(ValidationError);
  });

  it("专题内 cursor sortKind 必须为 position", async () => {
    const { encodeStudyCursor, studyFilterFingerprint } = await import("@/repositories/l3-study-cursor");
    const filter = studyFilterFingerprint(["reading_choice", null, null, TOPIC, false, null]);
    const cursor = encodeStudyCursor({
      sortKind: "updatedAt", lastSort: "2026-09-19T00:00:00Z", id: NOTE, filter,
    });
    await expect(
      service.list(USER, { venue: "reading_choice", topicId: TOPIC, cursor }),
    ).rejects.toThrow(ValidationError);
  });
});

describe("补齐：默认装配 / 成功路径 / 竞态与兜底", () => {
  it("默认装配可构造；不注入 factory 时在 fake tx 上完成 list（覆盖默认工厂体）", async () => {
    const tx = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) };
    const svc = new L3StudyNoteService((async (cb: (t: unknown) => Promise<unknown>) => cb(tx)) as never);
    const page = await svc.list(USER, { venue: "reading_choice", limit: 10 });
    expect(page).toEqual({ items: [], total: 0, nextCursor: null });
    // clampLimit 带值分支：limit=10 → repo 收 11
    expect(tx.query).toHaveBeenCalled();
  });

  it("list 成功路径：DTO 映射（venues 枚举序）+ hasMore/nextCursor（updatedAt）", async () => {
    const { decodeStudyCursor } = await import("@/repositories/l3-study-cursor");
    const NOTE_B = "00000000-0000-4000-8000-000000000102";
    repos.studyNotes.list = vi.fn(async () => ({
      items: [
        { ...noteRow({ id: NOTE }), updated_at: "2026-09-19T02:00:00Z" },
        { ...noteRow({ id: NOTE_B }), updated_at: "2026-09-19T01:00:00Z" },
      ],
      total: 4,
    }));
    repos.studyNotes.listVenuesForNotes = vi.fn(async () =>
      new Map([[NOTE, ["reading_choice", "cloze"]]]),
    );
    const page = await service.list(USER, { venue: "reading_choice", limit: 1 });
    expect(page.total).toBe(4);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.venues).toEqual(["cloze", "reading_choice"]); // 枚举序（comparator 执行）
    const decoded = decodeStudyCursor(page.nextCursor);
    expect(decoded).toMatchObject({ sortKind: "updatedAt", lastSort: "2026-09-19T02:00:00Z", id: NOTE });
    expect(repos.studyNotes.list).toHaveBeenCalledWith(expect.objectContaining({ limit: 2 }));
  });

  it("list 专题内成功路径：position 游标", async () => {
    const { decodeStudyCursor } = await import("@/repositories/l3-study-cursor");
    const NOTE_B = "00000000-0000-4000-8000-000000000102";
    repos.studyNotes.list = vi.fn(async () => ({
      items: [
        { ...noteRow({ id: NOTE }), position: 0 },
        { ...noteRow({ id: NOTE_B }), position: 1 },
      ],
      total: 2,
    }));
    const page = await service.list(USER, { venue: "reading_choice", topicId: TOPIC, limit: 1 });
    const decoded = decodeStudyCursor(page.nextCursor);
    expect(decoded).toMatchObject({ sortKind: "position", lastSort: "0", id: NOTE });
  });

  it("get 成功路径与 404", async () => {
    repos.studyNotes.get = vi.fn(async () => noteRow({ title: "详情" }));
    const result = await service.get(USER, NOTE);
    expect(result.item.title).toBe("详情");
    expect(result.item.references).toEqual([]);

    repos.studyNotes.get = vi.fn(async () => null);
    await expect(service.get(USER, NOTE)).rejects.toThrow(NotFoundError);
  });

  it("create 并发竞态（F1）：ON CONFLICT 不中止事务、新语句回读；异输入 409", async () => {
    const { computeNoteCreateHash } = await import("@/services/l3-study-notes.service");
    // 模拟真实 PG 语义：普通 INSERT 撞唯一键会中止事务（后续查询 25P02）；
    // ON CONFLICT DO NOTHING 不中止，冲突后新语句可回读并发已提交行。
    let txPoisoned = false;
    let lookups = 0;
    const racedRow = noteRow({ create_input_hash: computeNoteCreateHash("reading_choice") });
    repos.studyNotes.create = vi.fn(async () => {
      txPoisoned = true; // 旧实现路径：23505 使事务进入 aborted 状态
      throw Object.assign(new Error("dup"), { code: "23505" });
    });
    repos.studyNotes.createIfAbsent = vi.fn(async () => null);
    repos.studyNotes.findByCreateRequestId = vi.fn(async () => {
      if (txPoisoned) {
        throw Object.assign(new Error("current transaction is aborted"), { code: "25P02" });
      }
      lookups += 1;
      return lookups >= 2 ? racedRow : null;
    });

    const raced = await service.create(USER, { requestId: REQ, venue: "reading_choice" });
    expect(raced.created).toBe(false);
    expect(raced.item.id).toBe(racedRow.id);
    expect(txPoisoned).toBe(false); // ON CONFLICT 路径不得使用失败事务

    // 同键异输入 → 409（同一机制，不依赖失败事务内查询）
    lookups = 0;
    repos.studyNotes.findByCreateRequestId = vi.fn(async () => {
      if (txPoisoned) {
        throw Object.assign(new Error("current transaction is aborted"), { code: "25P02" });
      }
      lookups += 1;
      return lookups >= 2 ? noteRow({ create_input_hash: computeNoteCreateHash("cloze") }) : null;
    });
    await expect(service.create(USER, { requestId: REQ, venue: "reading_choice" })).rejects.toThrow(ConflictError);
  });

  it("create 冲突后回读不到行（理论边界）→ 409；createIfAbsent 非冲突异常照常上抛", async () => {
    repos.studyNotes.createIfAbsent = vi.fn(async () => null);
    repos.studyNotes.findByCreateRequestId = vi.fn(async () => null);
    await expect(service.create(USER, { requestId: REQ, venue: "reading_choice" })).rejects.toThrow(ConflictError);

    repos.studyNotes.createIfAbsent = vi.fn(async () => {
      throw new Error("other failure");
    });
    repos.studyNotes.findByCreateRequestId = vi.fn(async () => null);
    await expect(service.create(USER, { requestId: REQ, venue: "reading_choice" })).rejects.toThrow("other failure");
  });

  it("createTopic：新建（走 createIfAbsent）/ 同输入幂等复用 / 异输入 409", async () => {
    const first = await service.createTopic(USER, { requestId: REQ, venue: "reading_choice", title: "专题" });
    expect(first.created).toBe(true);
    expect(repos.studyTopics.create).not.toHaveBeenCalled();
    const hash = (repos.studyTopics.createIfAbsent.mock.calls[0]![0] as { create_input_hash: string }).create_input_hash;
    repos.studyTopics.findByCreateRequestId = vi.fn(async () => topicRow({ create_input_hash: hash }));
    const retry = await service.createTopic(USER, { requestId: REQ, venue: "reading_choice", title: "专题" });
    expect(retry.created).toBe(false);

    repos.studyTopics.findByCreateRequestId = vi.fn(async () => topicRow({ create_input_hash: "0".repeat(64) }));
    await expect(
      service.createTopic(USER, { requestId: REQ, venue: "cloze", title: "别的" }),
    ).rejects.toThrow(ConflictError);
  });

  it("createTopic 并发竞态（F1）：冲突不中止事务、新语句回读；异输入 409", async () => {
    const { computeTopicCreateHash } = await import("@/services/l3-study-notes.service");
    let txPoisoned = false;
    let lookups = 0;
    const racedRow = topicRow({ create_input_hash: computeTopicCreateHash("reading_choice", "专题") });
    repos.studyTopics.create = vi.fn(async () => {
      txPoisoned = true;
      throw Object.assign(new Error("dup"), { code: "23505" });
    });
    repos.studyTopics.createIfAbsent = vi.fn(async () => null);
    repos.studyTopics.findByCreateRequestId = vi.fn(async () => {
      if (txPoisoned) {
        throw Object.assign(new Error("current transaction is aborted"), { code: "25P02" });
      }
      lookups += 1;
      return lookups >= 2 ? racedRow : null;
    });

    const raced = await service.createTopic(USER, { requestId: REQ, venue: "reading_choice", title: "专题" });
    expect(raced.created).toBe(false);
    expect(raced.item.id).toBe(racedRow.id);

    lookups = 0;
    repos.studyTopics.findByCreateRequestId = vi.fn(async () => {
      if (txPoisoned) {
        throw Object.assign(new Error("current transaction is aborted"), { code: "25P02" });
      }
      lookups += 1;
      return lookups >= 2 ? noteRow({ create_input_hash: computeTopicCreateHash("cloze", "别的") }) : null;
    });
    await expect(
      service.createTopic(USER, { requestId: REQ, venue: "reading_choice", title: "专题" }),
    ).rejects.toThrow(ConflictError);
  });

  it("saveTopic：成功（CAS+幂等列）/ 重放幂等 / 版本冲突", async () => {
    const { computeTopicSaveHash } = await import("@/services/l3-study-notes.service");
    const first = await service.saveTopic(USER, TOPIC, {
      requestId: REQ, expectedVersion: 1, title: "改名", status: "active",
    });
    expect(first.item.version).toBe(2);
    expect(repos.studyTopics.updateIfVersion).toHaveBeenCalledWith(USER, TOPIC, 1, expect.objectContaining({
      title: "改名", last_write_request_id: REQ,
    }));

    const hash = computeTopicSaveHash({ expectedVersion: 1, title: "改名", status: "active" });
    repos.studyTopics.lock = vi.fn(async () =>
      topicRow({ version: 2, last_write_request_id: REQ, last_write_hash: hash }),
    );
    const retry = await service.saveTopic(USER, TOPIC, {
      requestId: REQ, expectedVersion: 1, title: "改名", status: "active",
    });
    expect(retry.item.version).toBe(2);

    repos.studyTopics.lock = vi.fn(async () => topicRow({ version: 9 }));
    await expect(
      service.saveTopic(USER, TOPIC, { requestId: REQ_B, expectedVersion: 1, title: "x", status: "active" }),
    ).rejects.toThrow(ConflictError);
  });

  it("listTopics 成功路径（批量成员计数填充）", async () => {
    repos.studyTopics.list = vi.fn(async () => ({ items: [topicRow()], total: 1 }));
    repos.studyTopics.countMembersForTopics = vi.fn(async () => new Map([[TOPIC, 3]]));
    const page = await service.listTopics(USER, { venue: "reading_choice" });
    expect(page.total).toBe(1);
    expect(page.items[0]).toMatchObject({ id: TOPIC, memberCount: 3 });
  });

  it("save 兜底：updateIfVersion null → 409；replaceForNote 23503 → 409（Referenced material）", async () => {
    repos.studyNotes.updateIfVersion = vi.fn(async () => null);
    await expect(service.save(USER, NOTE, baseSaveInput())).rejects.toThrow(ConflictError);

    repos.studyNotes.updateIfVersion = vi.fn(async () => noteRow({ version: 2 }));
    repos.studyReferences.replaceForNote = vi.fn(async () => {
      throw Object.assign(new Error("fk"), { code: "23503" });
    });
    const error = await service.save(USER, NOTE, baseSaveInput()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictError);
    expect((error as ConflictError).message).toContain("no longer available");
  });
});

// ── F5（补修批次）：UUID 身份规范化 —— 合法大写 UUID 必须与同值小写同一身份 ──
// 样例均含 a–f（纯数字 UUID 无法暴露大小写差异）。

describe("F5 UUID 身份：成员移动 / 排序 / 幂等重试 / 锁身份", () => {
  const TOPIC_U = "BEEFCAFE-2345-4789-8ABC-FEDCBA987654";
  const TOPIC_L = "beefcafe-2345-4789-8abc-fedcba987654";
  const NOTE_U = "ABCDEF01-2345-4789-8ABC-DEF012345678";
  const NOTE_L = "abcdef01-2345-4789-8abc-def012345678";
  const N_B_U = "CAFEBABE-2345-4789-8ABC-111122223333";
  const N_B_L = "cafebabe-2345-4789-8abc-111122223333";
  const REQ_U = "DEADBEEF-2345-4789-8ABC-0123456789AB";
  const REQ_L = "deadbeef-2345-4789-8abc-0123456789ab";

  it("成员移动：大写 noteId 命中小写成员（不误走重复 INSERT，重排完整顺序）", async () => {
    repos.studyTopics.listMembers = vi.fn(async () => [
      { note_id: N_B_L, position: 0 },
      { note_id: NOTE_L, position: 1 },
    ]);
    repos.studyNotes.lock = vi.fn(async () => noteRow({ id: NOTE_L }));

    await service.moveTopicMember(USER, TOPIC, NOTE_U, {
      requestId: REQ, expectedVersion: 1, beforeNoteId: null,
    });
    expect(repos.studyNotes.lock).toHaveBeenCalledWith(USER, NOTE_L);
    expect(repos.studyTopics.insertMember).not.toHaveBeenCalled();
    expect(repos.studyTopics.replaceMemberPositions).toHaveBeenCalledWith(USER, TOPIC, [N_B_L, NOTE_L]);
  });

  it("beforeNoteId 大写：按同一身份解析（不再 422），插位到成员之前", async () => {
    repos.studyTopics.listMembers = vi.fn(async () => [
      { note_id: NOTE_L, position: 0 },
      { note_id: N_B_L, position: 1 },
    ]);
    repos.studyNotes.lock = vi.fn(async () => noteRow({ id: N_B_L }));

    await service.moveTopicMember(USER, TOPIC, N_B_U, {
      requestId: REQ, expectedVersion: 1, beforeNoteId: NOTE_U,
    });
    expect(repos.studyTopics.replaceMemberPositions).toHaveBeenCalledWith(USER, TOPIC, [N_B_L, NOTE_L]);
  });

  it("create：大写 requestId 规范到同一身份查询（幂等重试命中既有对象）", async () => {
    const { computeNoteCreateHash } = await import("@/services/l3-study-notes.service");
    repos.studyNotes.findByCreateRequestId = vi.fn(async () =>
      noteRow({ id: NOTE_L, create_input_hash: computeNoteCreateHash("reading_choice") }),
    );
    const result = await service.create(USER, { requestId: REQ_U, venue: "reading_choice" });
    expect(repos.studyNotes.findByCreateRequestId).toHaveBeenCalledWith(USER, REQ_L);
    expect(result.created).toBe(false);
  });

  it("createTopic：大写 requestId 规范到同一身份查询；saveTopic 大写 topicId 锁行", async () => {
    await service.createTopic(USER, { requestId: REQ_U, venue: "reading_choice", title: "专题" });
    expect(repos.studyTopics.findByCreateRequestId).toHaveBeenCalledWith(USER, REQ_L);

    await service.saveTopic(USER, TOPIC_U, {
      requestId: REQ_U, expectedVersion: 1, title: "改名", status: "active",
    });
    expect(repos.studyTopics.lock).toHaveBeenCalledWith(USER, TOPIC_L);
  });

  it("removeTopicMember：大写 topicId/noteId 规范到同一身份；幂等请求键同为小写", async () => {
    await service.removeTopicMember(USER, TOPIC_U, NOTE_U, { requestId: REQ_U, expectedVersion: 1 });
    expect(repos.studyTopics.lock).toHaveBeenCalledWith(USER, TOPIC_L);
    expect(repos.studyTopics.deleteMember).toHaveBeenCalledWith(USER, TOPIC_L, NOTE_L);
    expect(repos.studyTopics.bumpVersion).toHaveBeenCalledWith(USER, TOPIC_L, 1, REQ_L, expect.any(String));
  });

  it("save / get：大写 noteId 规范到同一身份（锁行与读取同键）", async () => {
    await service.save(USER, NOTE_U, baseSaveInput());
    expect(repos.studyNotes.lock).toHaveBeenCalledWith(USER, NOTE_L);
    expect(repos.studyNotes.updateIfVersion).toHaveBeenCalledWith(USER, NOTE_L, 1, expect.anything());

    repos.studyNotes.get = vi.fn(async () => noteRow({ id: NOTE_L }));
    await service.get(USER, NOTE_U);
    expect(repos.studyNotes.get).toHaveBeenCalledWith(USER, NOTE_L);
  });

  it("专题内列表：topicId 大小写属同一过滤身份（cursor 指纹可跨大小写复用）", async () => {
    repos.studyNotes.list = vi.fn(async () => ({
      items: [
        { ...noteRow({ id: NOTE_L }), position: 0, updated_at: "2026-09-19T02:00:00Z" },
        { ...noteRow({ id: N_B_L }), position: 1, updated_at: "2026-09-19T01:00:00Z" },
      ],
      total: 2,
    }));
    const first = await service.list(USER, { venue: "reading_choice", topicId: TOPIC_U, limit: 1 });
    expect(repos.studyNotes.list).toHaveBeenCalledWith(expect.objectContaining({ topicId: TOPIC_L }));
    expect(first.nextCursor).toBeTypeOf("string");

    // 第二次请求换成小写 topicId 复用同一游标：同一身份 → 指纹一致，不 400
    repos.studyNotes.list = vi.fn(async () => ({ items: [], total: 2 }));
    const page2 = await service.list(USER, {
      venue: "reading_choice", topicId: TOPIC_L, limit: 1, cursor: first.nextCursor!,
    });
    expect(page2.items).toEqual([]);
  });
});

// ── F2（补修批次）：一致详情（readSnapshot 与复用路径先锁后组装）──────────────

describe("F2 一致详情：readSnapshot / 复用锁序", () => {
  it("get 使用只读一致快照（readSnapshot:true 传给事务层，其余调用保持默认）", async () => {
    const txRunner = vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback({})) as unknown as never;
    const svc = new L3StudyNoteService(txRunner, () => repos as unknown as StudyNoteRepos, referenceService as never);
    repos.studyNotes.get = vi.fn(async () => noteRow());
    await svc.get(USER, NOTE);
    expect(txRunner).toHaveBeenCalledWith(expect.any(Function), { actorId: USER, readSnapshot: true });

    // 保存路径保持默认（写事务不得进入只读快照）
    const saveTxRunner = vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback({})) as unknown as never;
    const saveSvc = new L3StudyNoteService(saveTxRunner, () => repos as unknown as StudyNoteRepos, referenceService as never);
    await saveSvc.save(USER, NOTE, baseSaveInput());
    expect(saveTxRunner).toHaveBeenCalledWith(expect.any(Function), { actorId: USER });
  });

  it("幂等创建复用（已存在路径与冲突回读路径）：先锁现有笔记再组装 DTO", async () => {
    const { computeNoteCreateHash } = await import("@/services/l3-study-notes.service");
    const order: string[] = [];
    const existing = noteRow({ id: NOTE, create_input_hash: computeNoteCreateHash("reading_choice") });
    repos.studyNotes.findByCreateRequestId = vi.fn(async () => existing);
    repos.studyNotes.lock = vi.fn(async () => { order.push("lock"); return existing; });
    repos.studyNotes.listVenues = vi.fn(async () => { order.push("listVenues"); return ["reading_choice"]; });

    const result = await service.create(USER, { requestId: REQ, venue: "reading_choice" });
    expect(result.created).toBe(false);
    expect(repos.studyNotes.lock).toHaveBeenCalledWith(USER, NOTE);
    expect(order[0]).toBe("lock");

    // 冲突回读路径（createIfAbsent 返回 null → 新语句回读）
    order.length = 0;
    let lookups = 0;
    repos.studyNotes.createIfAbsent = vi.fn(async () => null);
    repos.studyNotes.findByCreateRequestId = vi.fn(async () => {
      lookups += 1;
      return lookups >= 2 ? existing : null;
    });
    repos.studyNotes.lock = vi.fn(async () => { order.push("lock"); return existing; });
    const raced = await service.create(USER, { requestId: REQ, venue: "reading_choice" });
    expect(raced.created).toBe(false);
    expect(order[0]).toBe("lock");
  });

  it("createTopic 幂等复用：先锁行再组装（version 与 memberCount 同源快照）", async () => {
    const { computeTopicCreateHash } = await import("@/services/l3-study-notes.service");
    const order: string[] = [];
    const hash = computeTopicCreateHash("reading_choice", "专题");
    repos.studyTopics.findByCreateRequestId = vi.fn(async () => topicRow({ version: 3, create_input_hash: hash }));
    repos.studyTopics.lock = vi.fn(async () => {
      order.push("lock");
      return topicRow({ version: 3, create_input_hash: hash });
    });
    repos.studyTopics.countMembers = vi.fn(async () => { order.push("count"); return 2; });

    const result = await service.createTopic(USER, { requestId: REQ, venue: "reading_choice", title: "专题" });
    expect(result.created).toBe(false);
    expect(repos.studyTopics.lock).toHaveBeenCalledWith(USER, TOPIC);
    expect(order).toEqual(["lock", "count"]);
    expect(result.item).toMatchObject({ version: 3, memberCount: 2 });
  });
});

describe("N2 评析引用（服务装配层 · 第一条垂直链）", () => {
  const ASSESSMENT = "00000000-0000-4000-8000-000000000221";

  const assessmentTarget = { kind: "assessment" as const, questionId: QUESTION, assessmentId: ASSESSMENT };

  function assessmentCaptureAgainst() {
    referenceService.captureAgainst = vi.fn(() => ({
      kind: "assessment" as const,
      source_id: null,
      question_id: QUESTION,
      assessment_id: ASSESSMENT,
      option_key: null,
      start_offset: null,
      end_offset: null,
      quote_snapshot: null,
      field_hash: "f".repeat(64),
      display_snapshot: { kind: "assessment", excerpt: "评析摘要" },
    })) as never;
  }

  it("capture 评析：锁/装载键为「所属题 + 评析行」两把，写入行带 assessment_id", async () => {
    assessmentCaptureAgainst();
    repos.studyReferences.loadTargets = vi.fn(async () =>
      new Map([[
        `assessment:${ASSESSMENT}`,
        { kind: "assessment", id: ASSESSMENT, questionId: QUESTION, content_md: "评析正文", question_type: "reading_choice", source_title: "Fox source" },
      ]]) as never,
    );
    const input = baseSaveInput({
      bodyMd: `[[ref:${REF_B}]]`,
      references: [{ id: REF_B, action: "capture", target: assessmentTarget }],
    });
    await service.save(USER, NOTE, input);

    // 锁序与仓储一致：评析随题级联删除，故两端都要锁
    expect(repos.studyReferences.lockTargets).toHaveBeenCalledWith(USER, [
      { kind: "question", id: QUESTION },
      { kind: "assessment", id: ASSESSMENT },
    ]);
    const rows = repos.studyReferences.replaceForNote.mock.calls[0]![2] as { assessment_id: string | null }[];
    expect(rows[0]!.assessment_id).toBe(ASSESSMENT);
  });

  it("keep 评析引用：保留原 assessment_id 与 capturedAt（不重读评析）", async () => {
    const existing = {
      id: REF, note_id: NOTE, user_id: USER, kind: "assessment" as const,
      source_id: null, question_id: QUESTION, assessment_id: ASSESSMENT,
      option_key: null, start_offset: null, end_offset: null, quote_snapshot: null,
      field_hash: "e".repeat(64),
      display_snapshot: { kind: "assessment", excerpt: "评析摘要" },
      captured_at: "2026-09-01T00:00:00.000Z",
    };
    repos.studyReferences.listForNote = vi.fn(async () => [existing] as never);
    const input = baseSaveInput({
      bodyMd: `[[ref:${REF}]]`,
      references: [{ id: REF, action: "keep" }],
    });
    await service.save(USER, NOTE, input);

    const rows = repos.studyReferences.replaceForNote.mock.calls[0]![2] as { assessment_id: string | null; captured_at: string }[];
    expect(rows[0]).toMatchObject({ assessment_id: ASSESSMENT, captured_at: "2026-09-01T00:00:00.000Z" });
    expect(repos.studyReferences.lockTargets).not.toHaveBeenCalled();
  });

  it("capture 评析但目标未装载 → 404（键为 assessment:<id>，不退化成按题命中）", async () => {
    assessmentCaptureAgainst();
    // 装载只给了「题目」键：评析引用不得按题兜底命中
    repos.studyReferences.loadTargets = vi.fn(async () =>
      new Map([[`question:${QUESTION}`, { kind: "question", id: QUESTION }]]) as never,
    );
    const input = baseSaveInput({
      bodyMd: `[[ref:${REF_B}]]`,
      references: [{ id: REF_B, action: "capture", target: assessmentTarget }],
    });
    const error = await service.save(USER, NOTE, input).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(NotFoundError);
    expect((error as { message: string }).message).toContain(`assessment:${ASSESSMENT}`);
  });
});

describe("N2 笔记互链（服务装配层 · 第二条垂直链）", () => {
  const TARGET_NOTE = "00000000-0000-4000-8000-000000000231";

  const noteTarget = { kind: "note" as const, noteId: TARGET_NOTE };

  function noteCaptureAgainst() {
    referenceService.captureAgainst = vi.fn(() => ({
      kind: "note" as const,
      source_id: null,
      question_id: null,
      assessment_id: null,
      target_note_id: TARGET_NOTE,
      option_key: null,
      start_offset: null,
      end_offset: null,
      quote_snapshot: null,
      field_hash: "f".repeat(64),
      display_snapshot: { kind: "note", title: "被引用笔记", excerpt: "被引用正文" },
    })) as never;
  }

  it("capture 笔记：装载键为 note:<id>，写入行带 target_note_id", async () => {
    noteCaptureAgainst();
    repos.studyReferences.loadTargets = vi.fn(async () =>
      new Map([[
        `note:${TARGET_NOTE}`,
        { kind: "note", id: TARGET_NOTE, title: "被引用笔记", body_md: "被引用正文", status: "active" },
      ]]) as never,
    );
    const input = baseSaveInput({
      bodyMd: `[[ref:${REF_B}]]`,
      references: [{ id: REF_B, action: "capture", target: noteTarget }],
    });
    await service.save(USER, NOTE, input);

    expect(repos.studyReferences.lockTargets).toHaveBeenCalledWith(USER, [
      { kind: "note", id: TARGET_NOTE },
    ]);
    const rows = repos.studyReferences.replaceForNote.mock.calls[0]![2] as {
      target_note_id: string | null;
      display_snapshot: Record<string, unknown>;
    }[];
    expect(rows[0]!.target_note_id).toBe(TARGET_NOTE);
    // 只展开一层：快照里不得出现目标笔记自身的引用集合
    expect(rows[0]!.display_snapshot).not.toHaveProperty("references");
  });

  it("自引用 → 422（笔记不能引用自身）", async () => {
    noteCaptureAgainst();
    repos.studyReferences.loadTargets = vi.fn(async () =>
      new Map([[
        `note:${NOTE}`,
        { kind: "note", id: NOTE, title: "自己", body_md: "自己", status: "active" },
      ]]) as never,
    );
    const input = baseSaveInput({
      bodyMd: `[[ref:${REF_B}]]`,
      references: [{ id: REF_B, action: "capture", target: { kind: "note", noteId: NOTE } }],
    });
    const error = await service.save(USER, NOTE, input).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ValidationError);
    expect((error as { field?: string }).field).toBe("references");
    expect(repos.studyReferences.replaceForNote).not.toHaveBeenCalled();
  });

  it("自引用大小写不敏感：UUID 大写形式同样被拒（F5 身份规范化）", async () => {
    noteCaptureAgainst();
    repos.studyReferences.loadTargets = vi.fn(async () =>
      new Map([[
        `note:${NOTE}`,
        { kind: "note", id: NOTE, title: "自己", body_md: "自己", status: "active" },
      ]]) as never,
    );
    const input = baseSaveInput({
      bodyMd: `[[ref:${REF_B}]]`,
      references: [{ id: REF_B, action: "capture", target: { kind: "note", noteId: NOTE.toUpperCase() } }],
    });
    await expect(service.save(USER, NOTE, input)).rejects.toThrow(ValidationError);
  });

  it("成环允许：目标笔记反向引用当前笔记不构成错误（只解一层，不递归展开）", async () => {
    noteCaptureAgainst();
    // 已存引用表明「目标笔记也引用了当前笔记」——环不被禁止
    repos.studyReferences.listForNote = vi.fn(async () => [
      {
        id: REF, note_id: NOTE, user_id: USER, kind: "note" as const,
        source_id: null, question_id: null, assessment_id: null, target_note_id: TARGET_NOTE,
        option_key: null, start_offset: null, end_offset: null, quote_snapshot: null,
        field_hash: "e".repeat(64),
        display_snapshot: { kind: "note", title: "被引用笔记", excerpt: "被引用正文" },
        captured_at: "2026-09-01T00:00:00.000Z",
      },
    ] as never);
    repos.studyReferences.loadTargets = vi.fn(async () =>
      new Map([[
        `note:${TARGET_NOTE}`,
        { kind: "note", id: TARGET_NOTE, title: "被引用笔记", body_md: "被引用正文", status: "active" },
      ]]) as never,
    );
    const input = baseSaveInput({
      bodyMd: `[[ref:${REF}]]`,
      references: [{ id: REF, action: "capture", target: noteTarget }],
    });
    await service.save(USER, NOTE, input);

    const rows = repos.studyReferences.replaceForNote.mock.calls[0]![2] as {
      target_note_id: string | null;
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.target_note_id).toBe(TARGET_NOTE);
  });

  it("keep 笔记引用：保留原 target_note_id 与 capturedAt（不重读目标）", async () => {
    const existing = {
      id: REF, note_id: NOTE, user_id: USER, kind: "note" as const,
      source_id: null, question_id: null, assessment_id: null, target_note_id: TARGET_NOTE,
      option_key: null, start_offset: null, end_offset: null, quote_snapshot: null,
      field_hash: "e".repeat(64),
      display_snapshot: { kind: "note", title: "被引用笔记", excerpt: "被引用正文" },
      captured_at: "2026-09-01T00:00:00.000Z",
    };
    repos.studyReferences.listForNote = vi.fn(async () => [existing] as never);
    const input = baseSaveInput({
      bodyMd: `[[ref:${REF}]]`,
      references: [{ id: REF, action: "keep" }],
    });
    await service.save(USER, NOTE, input);

    const rows = repos.studyReferences.replaceForNote.mock.calls[0]![2] as {
      target_note_id: string | null;
      captured_at: string;
    }[];
    expect(rows[0]).toMatchObject({
      target_note_id: TARGET_NOTE,
      captured_at: "2026-09-01T00:00:00.000Z",
    });
    expect(repos.studyReferences.lockTargets).not.toHaveBeenCalled();
  });
});

describe("N2 第三条链（服务装配层 · sheet / attempt）", () => {
  const SHEET = "00000000-0000-4000-8000-000000000321";
  const ATTEMPT = "00000000-0000-4000-8000-000000000331";
  const LOADED_SHEET = {
    kind: "sheet", id: SHEET, scope: "file", status: "sealed", revision_no: null, summary: "小结",
  };
  const LOADED_ATTEMPT = {
    kind: "attempt", id: ATTEMPT, venue: "file", answer: { value: "A" }, status: "active",
  };

  /**
   * 忠实装载替身：只返回**被请求**的键。
   *
   * 若装载请求写错 kind/id（如退化成按 question 装载），这里必然取不到，
   * 引用就会被判 unavailable / 404——正是 P1-1 同款防复发断言。
   */
  function faithfulLoadTargets(available: Record<string, unknown>) {
    repos.studyReferences.loadTargets = vi.fn(
      async (_userId: string, requested: readonly { kind: string; id: string }[]) => {
        const map = new Map<string, unknown>();
        for (const req of requested) {
          const key = `${req.kind}:${req.id}`;
          const hit = available[key];
          if (hit) map.set(key, hit);
        }
        return map;
      },
    ) as never;
  }

  function sheetCaptureAgainst(revisionNo: number | null = null) {
    referenceService.captureAgainst = vi.fn(() => ({
      kind: "sheet",
      source_id: null, question_id: null, assessment_id: null, target_note_id: null,
      submission_id: SHEET, submission_revision_no: revisionNo, attempt_id: null,
      option_key: null, start_offset: null, end_offset: null, quote_snapshot: null,
      field_hash: "f".repeat(64),
      display_snapshot: { kind: "sheet", scope: "file", summaryExcerpt: "小结" },
    })) as never;
  }

  function attemptCaptureAgainst() {
    referenceService.captureAgainst = vi.fn(() => ({
      kind: "attempt",
      source_id: null, question_id: null, assessment_id: null, target_note_id: null,
      submission_id: null, submission_revision_no: null, attempt_id: ATTEMPT,
      option_key: null, start_offset: null, end_offset: null, quote_snapshot: null,
      field_hash: "f".repeat(64),
      display_snapshot: { kind: "attempt", venue: "file", answerExcerpt: `{"value":"A"}` },
    })) as never;
  }

  it("capture sheet：锁键与装载键同为 sheet:<id>，写入行带 submission_id / revision", async () => {
    sheetCaptureAgainst();
    faithfulLoadTargets({ [`sheet:${SHEET}`]: LOADED_SHEET });
    const input = baseSaveInput({
      bodyMd: `[[ref:${REF_B}]]`,
      references: [{ id: REF_B, action: "capture", target: { kind: "sheet", submissionId: SHEET } }],
    });
    await service.save(USER, NOTE, input);

    expect(repos.studyReferences.lockTargets).toHaveBeenCalledWith(USER, [
      { kind: "sheet", id: SHEET },
    ]);
    const rows = repos.studyReferences.replaceForNote.mock.calls[0]![2] as {
      submission_id: string | null;
      submission_revision_no: number | null;
      attempt_id: string | null;
    }[];
    expect(rows[0]).toMatchObject({
      submission_id: SHEET,
      submission_revision_no: null,
      attempt_id: null,
    });
  });

  it("capture attempt：锁键与装载键同为 attempt:<id>，写入行带 attempt_id（K9 单值身份）", async () => {
    attemptCaptureAgainst();
    faithfulLoadTargets({ [`attempt:${ATTEMPT}`]: LOADED_ATTEMPT });
    const input = baseSaveInput({
      bodyMd: `[[ref:${REF_B}]]`,
      references: [{ id: REF_B, action: "capture", target: { kind: "attempt", attemptId: ATTEMPT } }],
    });
    await service.save(USER, NOTE, input);

    expect(repos.studyReferences.lockTargets).toHaveBeenCalledWith(USER, [
      { kind: "attempt", id: ATTEMPT },
    ]);
    const rows = repos.studyReferences.replaceForNote.mock.calls[0]![2] as {
      submission_id: string | null;
      attempt_id: string | null;
    }[];
    expect(rows[0]).toMatchObject({ submission_id: null, attempt_id: ATTEMPT });
  });

  it("忠实装载替身下装载键写错 → 404（sheet 不按 question 兜底、attempt 不按 question 兜底）", async () => {
    sheetCaptureAgainst();
    // 只提供「题目」键：sheet 引用不得按题兜底命中（K5）
    faithfulLoadTargets({ [`question:${SOURCE}`]: { kind: "question", id: SOURCE } });
    const sheetInput = baseSaveInput({
      bodyMd: `[[ref:${REF_B}]]`,
      references: [{ id: REF_B, action: "capture", target: { kind: "sheet", submissionId: SHEET } }],
    });
    const sheetError = await service.save(USER, NOTE, sheetInput).catch((e: unknown) => e);
    expect(sheetError).toBeInstanceOf(NotFoundError);
    expect((sheetError as { message: string }).message).toContain(`sheet:${SHEET}`);

    attemptCaptureAgainst();
    faithfulLoadTargets({ [`question:${SOURCE}`]: { kind: "question", id: SOURCE } });
    const attemptInput = baseSaveInput({
      bodyMd: `[[ref:${REF_B}]]`,
      references: [{ id: REF_B, action: "capture", target: { kind: "attempt", attemptId: ATTEMPT } }],
    });
    const attemptError = await service.save(USER, NOTE, attemptInput).catch((e: unknown) => e);
    expect(attemptError).toBeInstanceOf(NotFoundError);
    expect((attemptError as { message: string }).message).toContain(`attempt:${ATTEMPT}`);
    expect(repos.studyReferences.replaceForNote).not.toHaveBeenCalled();
  });

  it("keep sheet / attempt 引用：保留原目标列与 capturedAt，不重读目标", async () => {
    const existingSheet = {
      id: REF, note_id: NOTE, user_id: USER, kind: "sheet" as const,
      source_id: null, question_id: null, assessment_id: null, target_note_id: null,
      submission_id: SHEET, submission_revision_no: 2, attempt_id: null,
      option_key: null, start_offset: null, end_offset: null, quote_snapshot: null,
      field_hash: "e".repeat(64),
      display_snapshot: { kind: "sheet", scope: "writing", summaryExcerpt: "第二稿" },
      captured_at: "2026-09-01T00:00:00.000Z",
    };
    repos.studyReferences.listForNote = vi.fn(async () => [existingSheet] as never);
    const input = baseSaveInput({
      bodyMd: `[[ref:${REF}]]`,
      references: [{ id: REF, action: "keep" }],
    });
    await service.save(USER, NOTE, input);

    const rows = repos.studyReferences.replaceForNote.mock.calls[0]![2] as {
      submission_id: string | null;
      submission_revision_no: number | null;
      captured_at: string;
    }[];
    expect(rows[0]).toMatchObject({
      submission_id: SHEET,
      submission_revision_no: 2,
      captured_at: "2026-09-01T00:00:00.000Z",
    });
    expect(repos.studyReferences.lockTargets).not.toHaveBeenCalled();
  });
});
