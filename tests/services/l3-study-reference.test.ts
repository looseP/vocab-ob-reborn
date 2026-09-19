/**
 * L3StudyReferenceService 单元测试（fake repos，无真实 DB）：
 * capture 的服务端快照/hash 口径（五 kind）、quote 严格校验（只接受服务端原文）、
 * 他人目标 404 / 选项不存在 422、resolve 的 current/changed/unavailable 判定、
 * preview 的只读语义与错误路径。
 */
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { NotFoundError, ValidationError } from "@/errors";
import {
  L3StudyReferenceService,
  currentFieldText,
  questionFieldText,
  type StudyReferenceRepos,
} from "@/services/l3-study-reference.service";
import type {
  L3StudyNoteReferenceRow,
  LoadedTarget,
} from "@/repositories/l3-study-references.repository";

const USER = "00000000-0000-4000-8000-0000000000a1";
const REF = "00000000-0000-4000-8000-000000000001";
const SOURCE = "00000000-0000-4000-8000-000000000201";
const QUESTION = "00000000-0000-4000-8000-000000000211";

const SOURCE_TEXT = "The quick brown fox.";
const QUESTION_TARGET: LoadedTarget = {
  kind: "question",
  id: QUESTION,
  stem: "What does the fox do?",
  options: [
    { key: "A", text: "jumps over the lazy dog" },
    { key: "B", text: "sleeps" },
  ],
  question_type: "reading_choice",
  source_id: SOURCE,
  source_title: "Fox source",
};

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function loadedMap(...targets: LoadedTarget[]): Map<string, LoadedTarget> {
  const map = new Map<string, LoadedTarget>();
  for (const target of targets) {
    map.set(`${target.kind}:${target.id}`, target);
  }
  return map;
}

function fakeRepos(targets: LoadedTarget[]): StudyReferenceRepos {
  return {
    studyReferences: {
      listForNote: vi.fn(),
      replaceForNote: vi.fn(),
      searchTargets: vi.fn(),
      loadTargets: vi.fn(async () => loadedMap(...targets)),
      lockTargets: vi.fn(),
      listBacklinks: vi.fn(),
      getSourceDeleteBlockers: vi.fn(),
      getQuestionDeleteBlockers: vi.fn(),
    } as unknown as StudyReferenceRepos["studyReferences"],
  };
}

function makeService(repos: StudyReferenceRepos): L3StudyReferenceService {
  const txRunner = (async (callback: (tx: unknown) => Promise<unknown>) => callback({})) as never;
  return new L3StudyReferenceService(txRunner, () => repos);
}

function refRow(overrides: Partial<L3StudyNoteReferenceRow> = {}): L3StudyNoteReferenceRow {
  return {
    id: REF, note_id: "n", user_id: USER, kind: "stem_quote", source_id: null, question_id: QUESTION,
    option_key: null, start_offset: 0, end_offset: 4, quote_snapshot: "What",
    field_hash: sha256Hex("What does the fox do?"), display_snapshot: { kind: "stem_quote" },
    captured_at: "2026-09-19T00:00:00Z",
    ...overrides,
  };
}

describe("capture · 服务端快照与 hash 口径", () => {
  it("source：hash=完整 content_text；快照=标题+前280摘要", async () => {
    const repos = fakeRepos([{ kind: "source", id: SOURCE, title: "Fox source", content_text: SOURCE_TEXT }]);
    const service = makeService(repos);
    const row = await service.capture(USER, { id: REF, target: { kind: "source", sourceId: SOURCE } }, repos);
    expect(row.field_hash).toBe(sha256Hex(SOURCE_TEXT));
    expect(row.display_snapshot).toEqual({ kind: "source", title: "Fox source", excerpt: SOURCE_TEXT });
    expect(row.quote_snapshot).toBeNull();
  });

  it("question：hash 为固定键序 {stem,options} JSON（options 保序）", async () => {
    const repos = fakeRepos([QUESTION_TARGET]);
    const service = makeService(repos);
    const row = await service.capture(USER, { id: REF, target: { kind: "question", questionId: QUESTION } }, repos);
    const expected = JSON.stringify({
      stem: "What does the fox do?",
      options: [{ key: "A", text: "jumps over the lazy dog" }, { key: "B", text: "sleeps" }],
    });
    expect(questionFieldText(QUESTION_TARGET as never)).toBe(expected);
    expect(row.field_hash).toBe(sha256Hex(expected));
    expect(row.display_snapshot).toMatchObject({
      kind: "question", questionType: "reading_choice", sourceTitle: "Fox source",
    });
    expect(row.display_snapshot).not.toHaveProperty("answer");
    expect(row.display_snapshot).not.toHaveProperty("explanation");
  });

  it("source_quote / stem_quote / option_quote：quote 必须严格等于 slice（含 offset 与摘录落地）", async () => {
    const source = { kind: "source", id: SOURCE, title: "T", content_text: SOURCE_TEXT } as const;
    const repos = fakeRepos([source, QUESTION_TARGET]);
    const service = makeService(repos);

    const sq = await service.capture(USER, {
      id: REF, target: { kind: "source_quote", sourceId: SOURCE, start: 0, end: 3, quote: "The" },
    }, repos);
    expect(sq.quote_snapshot).toBe("The");
    expect(sq.start_offset).toBe(0);
    expect(sq.field_hash).toBe(sha256Hex(SOURCE_TEXT));

    const tq = await service.capture(USER, {
      id: REF, target: { kind: "stem_quote", questionId: QUESTION, start: 0, end: 4, quote: "What" },
    }, repos);
    expect(tq.field_hash).toBe(sha256Hex(QUESTION_TARGET.stem));

    const oq = await service.capture(USER, {
      id: REF, target: { kind: "option_quote", questionId: QUESTION, optionKey: "A", start: 0, end: 5, quote: "jumps" },
    }, repos);
    expect(oq.option_key).toBe("A");
    expect(oq.field_hash).toBe(sha256Hex("jumps over the lazy dog"));
    expect(oq.display_snapshot).toMatchObject({ kind: "option_quote", optionKey: "A", quote: "jumps" });
  });

  it("题干引用只接受服务端原文：quote 与 slice 不符 → 422", async () => {
    const repos = fakeRepos([QUESTION_TARGET]);
    const service = makeService(repos);
    await expect(
      service.capture(USER, {
        id: REF, target: { kind: "stem_quote", questionId: QUESTION, start: 0, end: 4, quote: "what" },
      }, repos),
    ).rejects.toThrow(ValidationError);
  });

  it("他人/不存在的目标不可见 → 404", async () => {
    const repos = fakeRepos([]);
    const service = makeService(repos);
    await expect(
      service.capture(USER, { id: REF, target: { kind: "source", sourceId: SOURCE } }, repos),
    ).rejects.toThrow(NotFoundError);
  });

  it("选项不存在（如 D）→ 422", async () => {
    const repos = fakeRepos([QUESTION_TARGET]);
    const service = makeService(repos);
    await expect(
      service.capture(USER, {
        id: REF, target: { kind: "option_quote", questionId: QUESTION, optionKey: "D", start: 0, end: 4, quote: "What" },
      }, repos),
    ).rejects.toThrow(ValidationError);
  });

  it("NULL 正文的来源不可做 source_quote（422）", async () => {
    const repos = fakeRepos([{ kind: "source", id: SOURCE, title: "T", content_text: null }]);
    const service = makeService(repos);
    await expect(
      service.capture(USER, {
        id: REF, target: { kind: "source_quote", sourceId: SOURCE, start: 0, end: 1, quote: "T" },
      }, repos),
    ).rejects.toThrow(ValidationError);
  });
});

describe("resolve · current/changed/unavailable", () => {
  it("hash 相同 → current；字段变化 → changed（旧摘录保留、不按旧 offset 重定位）", async () => {
    const repos = fakeRepos([QUESTION_TARGET]);
    const service = makeService(repos);

    const current = await service.resolve(USER, [refRow()], repos);
    expect(current[0]!.status).toBe("current");
    expect(current[0]!.target).toEqual({ kind: "stem_quote", questionId: QUESTION, start: 0, end: 4, quote: "What" });

    const changed = await service.resolve(USER, [refRow({ field_hash: sha256Hex("OLD STEM") })], repos);
    expect(changed[0]!.status).toBe("changed");
    expect(changed[0]!.displaySnapshot).toEqual({ kind: "stem_quote" }); // 旧快照原样保留
    expect(changed[0]!.target).toMatchObject({ start: 0, end: 4, quote: "What" }); // 旧 offset 原样保留
  });

  it("目标缺失 → unavailable（不整页失败，保留旧快照）", async () => {
    const repos = fakeRepos([]);
    const service = makeService(repos);
    const previews = await service.resolve(USER, [refRow()], repos);
    expect(previews[0]!.status).toBe("unavailable");
    expect(previews[0]!.liveTitle).toBeNull();
  });

  it("option_quote 的选项被改写 → changed（当前字段按 option_key 重取）", async () => {
    const rewritten = {
      ...QUESTION_TARGET,
      options: [{ key: "A", text: "完全不同的选项文本" }, { key: "B", text: "sleeps" }],
    } as LoadedTarget;
    const repos = fakeRepos([rewritten]);
    const service = makeService(repos);
    const rows = [refRow({
      kind: "option_quote", option_key: "A", start_offset: 0, end_offset: 5, quote_snapshot: "jumps",
      field_hash: sha256Hex("jumps over the lazy dog"),
    })];
    const previews = await service.resolve(USER, rows, repos);
    expect(previews[0]!.status).toBe("changed");
  });
});

describe("preview · 只读", () => {
  it("合法目标返回将生成的快照与 liveTitle（不持久化）", async () => {
    const repos = fakeRepos([QUESTION_TARGET]);
    const service = makeService(repos);
    const response = await service.preview(USER, { kind: "stem_quote", questionId: QUESTION, start: 0, end: 4, quote: "What" });
    expect(response.preview.liveTitle).toBe("Fox source");
    expect(response.preview.displaySnapshot).toMatchObject({ kind: "stem_quote", quote: "What" });
    // 只读：无 replace/lock 调用
    expect((repos.studyReferences.replaceForNote as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
    expect((repos.studyReferences.lockTargets as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  it("quote 不符 → 422；目标缺失 → 404", async () => {
    const service = makeService(fakeRepos([QUESTION_TARGET]));
    await expect(
      service.preview(USER, { kind: "stem_quote", questionId: QUESTION, start: 0, end: 4, quote: "nope" }),
    ).rejects.toThrow(ValidationError);

    const emptyService = makeService(fakeRepos([]));
    await expect(
      emptyService.preview(USER, { kind: "source", sourceId: SOURCE }),
    ).rejects.toThrow(NotFoundError);
  });
});

describe("补齐：resolve 各 kind / 防御分支 / search·backlinks 编排", () => {
  const SOURCE_B = "00000000-0000-4000-8000-000000000202";
  const NOTE_ID = "00000000-0000-4000-8000-000000000101";

  it("resolve 覆盖 source / source_quote / question 三种行的 target 重建与 status", async () => {
    const source = { kind: "source" as const, id: SOURCE, title: "T", content_text: SOURCE_TEXT };
    const repos = fakeRepos([source, QUESTION_TARGET]);
    const service = makeService(repos);
    const questionJson = JSON.stringify({
      stem: QUESTION_TARGET.stem,
      options: QUESTION_TARGET.options.map((o) => ({ key: o.key, text: o.text })),
    });
    const rows: L3StudyNoteReferenceRow[] = [
      refRow({
        kind: "source", question_id: null, source_id: SOURCE, start_offset: null,
        end_offset: null, quote_snapshot: null, field_hash: sha256Hex(SOURCE_TEXT),
      }),
      refRow({
        id: "00000000-0000-4000-8000-000000000002", kind: "source_quote", question_id: null,
        source_id: SOURCE, start_offset: 0, end_offset: 3, quote_snapshot: "The",
        field_hash: sha256Hex(SOURCE_TEXT),
      }),
      refRow({
        id: "00000000-0000-4000-8000-000000000003", kind: "question",
        source_id: null, start_offset: null, end_offset: null, quote_snapshot: null,
        field_hash: sha256Hex(questionJson),
      }),
    ];
    const previews = await service.resolve(USER, rows, repos);
    expect(previews[0]!.target).toEqual({ kind: "source", sourceId: SOURCE });
    expect(previews[0]!.status).toBe("current");
    expect(previews[1]!.target).toMatchObject({ kind: "source_quote", quote: "The" });
    expect(previews[2]!.target).toEqual({ kind: "question", questionId: QUESTION });
    expect(previews[2]!.status).toBe("current");
  });

  it("resolve 空数组直接返回（零查询）", async () => {
    const repos = fakeRepos([]);
    const service = makeService(repos);
    const previews = await service.resolve(USER, [], repos);
    expect(previews).toEqual([]);
    expect((repos.studyReferences.loadTargets as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  it("currentFieldText 交叉防御：kind 与 target 类型不匹配返回 null", () => {
    const sourceLoaded = { kind: "source" as const, id: SOURCE, title: "T", content_text: SOURCE_TEXT };
    expect(currentFieldText("stem_quote", null, sourceLoaded)).toBeNull();
    expect(currentFieldText("option_quote", "A", sourceLoaded)).toBeNull();
  });

  it("capture source：长正文截 280 且不切代理对；NULL 正文 excerpt 空且 hash 按空串", async () => {
    const long = "a".repeat(279) + "😀" + "tail"; // 截到 280 会切进代理对 → 回退到 279
    const repos = fakeRepos([{ kind: "source", id: SOURCE, title: "T", content_text: long }]);
    const service = makeService(repos);
    const row = await service.capture(USER, { id: REF, target: { kind: "source", sourceId: SOURCE } }, repos);
    const snapshot = row.display_snapshot as { excerpt: string };
    expect(snapshot.excerpt).toBe("a".repeat(279));

    const reposNull = fakeRepos([{ kind: "source", id: SOURCE, title: "T", content_text: null }]);
    const serviceNull = makeService(reposNull);
    const rowNull = await serviceNull.capture(USER, { id: REF, target: { kind: "source", sourceId: SOURCE } }, reposNull);
    expect((rowNull.display_snapshot as { excerpt: string }).excerpt).toBe("");
    expect(rowNull.field_hash).toBe(sha256Hex(""));
  });

  it("captureAgainst 目标交叉不匹配防御（五种 target × 异型 loaded）→ 404", () => {
    const service = makeService(fakeRepos([]));
    const sourceLoaded = { kind: "source" as const, id: SOURCE, title: "T", content_text: SOURCE_TEXT };
    expect(() => service.captureAgainst({ kind: "source", sourceId: SOURCE }, QUESTION_TARGET)).toThrow(NotFoundError);
    expect(() => service.captureAgainst(
      { kind: "source_quote", sourceId: SOURCE, start: 0, end: 3, quote: "The" }, QUESTION_TARGET,
    )).toThrow(NotFoundError);
    expect(() => service.captureAgainst({ kind: "question", questionId: QUESTION }, sourceLoaded)).toThrow(NotFoundError);
    expect(() => service.captureAgainst(
      { kind: "stem_quote", questionId: QUESTION, start: 0, end: 4, quote: "What" }, sourceLoaded,
    )).toThrow(NotFoundError);
    expect(() => service.captureAgainst(
      { kind: "option_quote", questionId: QUESTION, optionKey: "A", start: 0, end: 5, quote: "jumps" }, sourceLoaded,
    )).toThrow(NotFoundError);
  });

  it("search 编排：camelCase 映射、limit+1 与 nextCursor（clampPageLimit 带值）", async () => {
    const repos = fakeRepos([]);
    (repos.studyReferences.searchTargets as ReturnType<typeof vi.fn>).mockImplementation(async () => ({
      items: [
        { id: SOURCE, title: "T1", created_at: "2026-09-19T01:00:00Z" },
        { id: SOURCE_B, title: "T2", created_at: "2026-09-19T00:00:00Z" },
      ],
      total: 3,
    }));
    const service = makeService(repos);
    const page = await service.search(USER, { kind: "source", limit: 1 });
    expect(page.total).toBe(3);
    expect(page.items).toEqual([{ id: SOURCE, title: "T1", createdAt: "2026-09-19T01:00:00Z" }]);
    expect(page.nextCursor).toBeTypeOf("string");
    expect((repos.studyReferences.searchTargets as ReturnType<typeof vi.fn>).mock.calls[0]![0])
      .toMatchObject({ limit: 2, kind: "source" });
  });

  it("search question kind（venue 传递）与 backlinks 编排（camelCase）", async () => {
    const repos = fakeRepos([]);
    (repos.studyReferences.searchTargets as ReturnType<typeof vi.fn>).mockImplementation(async () => ({
      items: [{ id: QUESTION, stem: "Q", question_type: "reading_choice", created_at: "2026-09-19T00:00:00Z" }],
      total: 1,
    }));
    const service = makeService(repos);
    const page = await service.search(USER, { kind: "question", venue: "reading_choice" });
    expect(page.items[0]).toEqual({
      id: QUESTION, stem: "Q", questionType: "reading_choice", createdAt: "2026-09-19T00:00:00Z",
    });
    expect((repos.studyReferences.searchTargets as ReturnType<typeof vi.fn>).mock.calls[0]![0])
      .toMatchObject({ venue: "reading_choice" });

    (repos.studyReferences.listBacklinks as ReturnType<typeof vi.fn>).mockImplementation(async () => ({
      items: [{
        note_id: NOTE_ID, title: "T", status: "active", reference_count: 2,
        ref_ids: [REF], updated_at: "2026-09-19T00:00:00Z",
      }],
      total: 1,
    }));
    const back = await service.backlinks(USER, { targetKind: "source", targetId: SOURCE });
    expect(back.items[0]).toEqual({
      noteId: NOTE_ID, title: "T", status: "active", referenceCount: 2, refIds: [REF],
    });
  });

  it("backlinks 过滤指纹不符 → 400；默认构造可实例化（默认工厂参数求值）", async () => {
    const service = makeService(fakeRepos([]));
    const { encodeStudyCursor, studyFilterFingerprint } = await import("@/repositories/l3-study-cursor");
    const wrong = encodeStudyCursor({
      sortKind: "updatedAt", lastSort: "2026-09-19T00:00:00Z", id: REF,
      filter: studyFilterFingerprint(["question", SOURCE]),
    });
    await expect(
      service.backlinks(USER, { targetKind: "source", targetId: SOURCE, cursor: wrong }),
    ).rejects.toThrow(ValidationError);
    expect(new L3StudyReferenceService()).toBeInstanceOf(L3StudyReferenceService);
  });
});

// ── F5（补修批次）：UUID 身份规范化 —— 大写 UUID 与小写同一身份 ─────────────
// 样例均含 a–f；loaded 目标一律以 DB 规范形态（小写）提供。

describe("F5 UUID 身份：目标查找 / 预览 / capture / backlinks", () => {
  const SOURCE_U = "ABCDEFAB-2345-4789-8ABC-000000000201";
  const SOURCE_L = "abcdefab-2345-4789-8abc-000000000201";
  const QUESTION_U = "BEEFCAFE-2345-4789-8ABC-000000000211";
  const QUESTION_L = "beefcafe-2345-4789-8abc-000000000211";

  function loadedSourceCase(): LoadedTarget {
    return { kind: "source", id: SOURCE_L, title: "Case source", content_text: SOURCE_TEXT };
  }
  function loadedQuestionCase(): LoadedTarget {
    return {
      kind: "question", id: QUESTION_L, stem: "Case stem?", options: [{ key: "A", text: "alpha" }],
      question_type: "reading_choice", source_id: SOURCE_L, source_title: "Case source",
    };
  }

  it("capture source/question：大写目标 id 命中 DB 小写行（不再 404）", async () => {
    const repos = fakeRepos([loadedSourceCase(), loadedQuestionCase()]);
    const service = makeService(repos);

    const sourceRow = await service.capture(USER, {
      id: REF, target: { kind: "source", sourceId: SOURCE_U },
    }, repos);
    expect(sourceRow.source_id).toBe(SOURCE_L);
    expect(sourceRow.display_snapshot).toMatchObject({ kind: "source", title: "Case source" });

    const stemRow = await service.capture(USER, {
      id: REF, target: { kind: "stem_quote", questionId: QUESTION_U, start: 0, end: 4, quote: "Case" },
    }, repos);
    expect(stemRow.question_id).toBe(QUESTION_L);
    expect(stemRow.quote_snapshot).toBe("Case");

    // 引用行落库字段（source_id/question_id）使用 DB 规范形态
    const optionRow = await service.capture(USER, {
      id: REF, target: { kind: "option_quote", questionId: QUESTION_U, optionKey: "A", start: 0, end: 5, quote: "alpha" },
    }, repos);
    expect(optionRow.question_id).toBe(QUESTION_L);
    expect(optionRow.option_key).toBe("A"); // optionKey 非 UUID，不参与规范化
  });

  it("preview：大写目标 id 正常返回预览（不 404）", async () => {
    const repos = fakeRepos([loadedQuestionCase()]);
    const service = makeService(repos);
    const response = await service.preview(USER, {
      kind: "stem_quote", questionId: QUESTION_U, start: 0, end: 4, quote: "Case",
    });
    expect(response.preview.liveTitle).toBe("Case source");
  });

  it("captureAgainst：大写 target 对 DB 小写 loaded 不抛 404（比较按规范身份）", () => {
    const service = makeService(fakeRepos([]));
    const row = service.captureAgainst(
      { kind: "source", sourceId: SOURCE_U },
      loadedSourceCase(),
    );
    expect(row.source_id).toBe(SOURCE_L);
    const quoteRow = service.captureAgainst(
      { kind: "stem_quote", questionId: QUESTION_U, start: 0, end: 4, quote: "Case" },
      loadedQuestionCase(),
    );
    expect(quoteRow.question_id).toBe(QUESTION_L);
  });

  it("backlinks：大写 targetId 规范到同一身份（仓储同键；cursor 指纹可跨大小写复用）", async () => {
    const repos = fakeRepos([]);
    const listBacklinks = repos.studyReferences.listBacklinks as ReturnType<typeof vi.fn>;
    listBacklinks.mockImplementation(async () => ({
      items: [
        { note_id: "00000000-0000-4000-8000-000000000101", title: "T1", status: "active", reference_count: 1, ref_ids: [REF], updated_at: "2026-09-19T02:00:00Z" },
        { note_id: "00000000-0000-4000-8000-000000000102", title: "T2", status: "active", reference_count: 1, ref_ids: [REF], updated_at: "2026-09-19T01:00:00Z" },
      ],
      total: 2,
    }));
    const service = makeService(repos);
    const first = await service.backlinks(USER, { targetKind: "source", targetId: SOURCE_U, limit: 1 });
    expect(listBacklinks).toHaveBeenCalledWith(expect.objectContaining({ targetId: SOURCE_L }));
    expect(first.nextCursor).toBeTypeOf("string");

    listBacklinks.mockImplementation(async () => ({ items: [], total: 2 }));
    const page2 = await service.backlinks(USER, {
      targetKind: "source", targetId: SOURCE_L, limit: 1, cursor: first.nextCursor!,
    });
    expect(page2.items).toEqual([]);
  });
});

// ── F4（补修批次）：游标绑定目标搜索过滤条件 ────────────────────────────────

describe("F4 游标绑定目标搜索过滤条件", () => {
  const SOURCE_B = "00000000-0000-4000-8000-000000000202";

  function searchRepos() {
    const repos = fakeRepos([]);
    (repos.studyReferences.searchTargets as ReturnType<typeof vi.fn>).mockImplementation(async () => ({
      items: [
        { id: SOURCE, title: "T1", created_at: "2026-09-19T02:00:00Z" },
        { id: SOURCE_B, title: "T2", created_at: "2026-09-19T01:00:00Z" },
      ],
      total: 2,
    }));
    return repos;
  }

  it("同条件分页：游标为 createdAt 族，指纹绑定 kind/q/有效 venue；limit 不参与指纹", async () => {
    const { decodeStudyCursor, studyFilterFingerprint } = await import("@/repositories/l3-study-cursor");
    const repos = searchRepos();
    const service = makeService(repos);
    const first = await service.search(USER, { kind: "source", q: "first", limit: 1 });
    const decoded = decodeStudyCursor(first.nextCursor);
    expect(decoded).toMatchObject({
      sortKind: "createdAt",
      lastSort: "2026-09-19T02:00:00Z",
      id: SOURCE,
      filter: studyFilterFingerprint(["reference-targets", "source", "first", null]),
    });

    // 同条件 + 不同 limit 复用 → 正常分页（limit 不是过滤身份）
    const page2 = await service.search(USER, { kind: "source", q: "first", limit: 10, cursor: first.nextCursor! });
    expect(page2.items.length).toBeGreaterThan(0);
    // 规范化 q 参与指纹：q="first" 带首尾空白 → 同一指纹（归一化）→ 可复用
    const padded = await service.search(USER, { kind: "source", q: "  first  ", limit: 10, cursor: first.nextCursor! });
    expect(padded.items.length).toBeGreaterThan(0);
    // 空白 q 归一为「无 q」→ 与 "first" 指纹不同 → 400
    await expect(service.search(USER, { kind: "source", q: "   ", limit: 10, cursor: first.nextCursor! }))
      .rejects.toThrow(ValidationError);
  });

  it("换 kind / 换 q / 换有效 venue / 其他列表游标：复用旧游标 → 400", async () => {
    const { encodeStudyCursor, studyFilterFingerprint } = await import("@/repositories/l3-study-cursor");
    const repos = searchRepos();
    const service = makeService(repos);
    const first = await service.search(USER, { kind: "question", q: "first", venue: "reading_choice", limit: 1 });
    const cursor = first.nextCursor!;

    await expect(service.search(USER, { kind: "source", q: "first", limit: 1, cursor }))
      .rejects.toThrow(ValidationError);
    await expect(service.search(USER, { kind: "question", q: "different", venue: "reading_choice", limit: 1, cursor }))
      .rejects.toThrow(ValidationError);
    await expect(service.search(USER, { kind: "question", q: "first", venue: null, limit: 1, cursor }))
      .rejects.toThrow(ValidationError);

    // 其他列表（updatedAt）游标不能用于目标搜索
    const notesCursor = encodeStudyCursor({
      sortKind: "updatedAt", lastSort: "2026-09-19T00:00:00Z", id: SOURCE,
      filter: studyFilterFingerprint(["reference-targets", "question", "first", "reading_choice"]),
    });
    await expect(service.search(USER, { kind: "question", q: "first", venue: "reading_choice", limit: 1, cursor: notesCursor }))
      .rejects.toThrow(ValidationError);
  });

  it("source 忽略无效 venue（不制造虚假指纹差异）；旧的不绑定条件游标 → 400", async () => {
    const { encodeCursor } = await import("@/repositories/l3-cursor");
    const repos = searchRepos();
    const service = makeService(repos);
    const first = await service.search(USER, { kind: "source", q: "x", venue: "reading_choice", limit: 1 });
    // source + venue 与 source 无 venue：同指纹 → 可复用
    const page2 = await service.search(USER, { kind: "source", q: "x", venue: null, limit: 1, cursor: first.nextCursor! });
    expect(page2.items.length).toBeGreaterThan(0);

    // 旧格式（不绑定条件）游标一律拒绝
    await expect(
      service.search(USER, { kind: "source", q: "x", limit: 1, cursor: encodeCursor("2026-09-19T00:00:00Z", SOURCE) }),
    ).rejects.toThrow(ValidationError);
  });
});
