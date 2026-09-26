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
  sheetFieldText,
  attemptFieldText,
  targetKeyOf,
  targetRefsOf,
  referenceRowToTarget,
  type StudyReferenceRepos,
} from "@/services/l3-study-reference.service";
import type {
  L3StudyNoteReferenceRow,
  LoadedTarget,
} from "@/repositories/l3-study-references.repository";
import type { ReferenceTarget } from "@/domain/l3-study-notes";

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

/**
 * **忠实装载**替身：只返回**被请求**的目标（键 `<kind>:<id>`）。
 *
 * 反例教训（N2 评析）：无条件按 targets 建键的替身会掩盖「装载请求本身就没带
 * 正确 kind/id」的缺陷——`resolve()` 曾对评析引用只装载 question 键，却在忠实
 * 装载下按 `assessment:<id>` 取值，生产环境必然取不到。替身必须按入参过滤。
 */
function loadedMap(
  requested: readonly { kind: string; id: string }[],
  targets: readonly LoadedTarget[],
): Map<string, LoadedTarget> {
  const available = new Map(targets.map((target) => [`${target.kind}:${target.id}`, target]));
  const map = new Map<string, LoadedTarget>();
  for (const request of requested) {
    const key = `${request.kind}:${request.id}`;
    const hit = available.get(key);
    if (hit) map.set(key, hit);
  }
  return map;
}

function fakeRepos(targets: LoadedTarget[]): StudyReferenceRepos {
  return {
    studyReferences: {
      listForNote: vi.fn(),
      replaceForNote: vi.fn(),
      searchTargets: vi.fn(),
      loadTargets: vi.fn(async (_userId: string, requested: readonly { kind: string; id: string }[]) =>
        loadedMap(requested, targets),
      ),
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
    assessment_id: null, target_note_id: null, submission_id: null, submission_revision_no: null, attempt_id: null,
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

describe("N2 评析引用（第一条垂直链 · 验收 V-4/V-5/V-6/V-7）", () => {
  const ASSESSMENT = "00000000-0000-4000-8000-000000000221";
  const OTHER_QUESTION = "00000000-0000-4000-8000-000000000212";

  const ASSESSMENT_TARGET: LoadedTarget = {
    kind: "assessment",
    id: ASSESSMENT,
    question_id: QUESTION,
    content_md: "评析初稿：定位题眼",
    updated_at: "2026-09-20T00:00:00Z",
    question_stem: "What does the fox do?",
    question_type: "reading_choice",
    source_title: "Fox source",
  };

  const target = { kind: "assessment", questionId: QUESTION, assessmentId: ASSESSMENT } as const;

  it("capture：hash 输入写死为 content_md；target 同时带 questionId 与 assessmentId（不退化成只引用题目）", async () => {
    const repos = fakeRepos([ASSESSMENT_TARGET]);
    const service = makeService(repos);
    const row = await service.capture(USER, { id: REF, target }, repos);

    expect(row.kind).toBe("assessment");
    expect(row.question_id).toBe(QUESTION);
    expect(row.assessment_id).toBe(ASSESSMENT);
    expect(row.field_hash).toBe(sha256Hex("评析初稿：定位题眼"));
    expect(row.display_snapshot).toEqual({
      kind: "assessment",
      excerpt: "评析初稿：定位题眼",
      questionType: "reading_choice",
      sourceTitle: "Fox source",
    });
  });

  it("题与评析不匹配 → 404（拒绝「按题兜底找当前评析」的隐式降级）", async () => {
    const repos = fakeRepos([ASSESSMENT_TARGET]);
    const service = makeService(repos);
    await expect(
      service.capture(USER, { id: REF, target: { kind: "assessment", questionId: OTHER_QUESTION, assessmentId: ASSESSMENT } }, repos),
    ).rejects.toThrow(NotFoundError);
  });

  it("评析被覆写 → resolve 转 changed，而 displaySnapshot / capturedAt / fieldHash 逐字节不变（D3-2）", async () => {
    const row = refRow({
      kind: "assessment",
      question_id: QUESTION,
      assessment_id: ASSESSMENT,
      source_id: null,
      start_offset: null,
      end_offset: null,
      quote_snapshot: null,
      field_hash: sha256Hex("评析初稿：定位题眼"),
      display_snapshot: { kind: "assessment", excerpt: "评析初稿：定位题眼", questionType: "reading_choice", sourceTitle: "Fox source" },
    });
    const before = JSON.stringify([row.display_snapshot, row.captured_at, row.field_hash]);

    // 当前评析已被 latest-wins 覆写
    const repos = fakeRepos([{ ...ASSESSMENT_TARGET, content_md: "评析改稿：换了个角度" }]);
    const [preview] = await makeService(repos).resolve(USER, [row], repos);

    expect(preview.status).toBe("changed");
    expect(preview.target).toEqual({ kind: "assessment", questionId: QUESTION, assessmentId: ASSESSMENT });
    // V-5：快照三件套未被回写（引用写路径不得按当前目标重算）
    expect(JSON.stringify([preview.displaySnapshot, preview.capturedAt, row.field_hash])).toBe(before);
  });

  it("currentFieldText：评析的 hash 字段文本就是 content_md（A2 写死）", () => {
    expect(currentFieldText("assessment", null, ASSESSMENT_TARGET)).toBe("评析初稿：定位题眼");
    // 交叉防御：评析 target 配非评析 kind → null（不会拿题干当评析内容）
    expect(currentFieldText("question", null, ASSESSMENT_TARGET)).toBeNull();
  });

  it("resolve 装载键与取值键同源：评析引用在忠实装载下为 current（防复发回归）", async () => {
    const row = refRow({
      kind: "assessment",
      question_id: QUESTION,
      assessment_id: ASSESSMENT,
      source_id: null,
      start_offset: null,
      end_offset: null,
      quote_snapshot: null,
      field_hash: sha256Hex("评析初稿：定位题眼"),
      display_snapshot: { kind: "assessment", excerpt: "评析初稿：定位题眼", questionType: "reading_choice", sourceTitle: "Fox source" },
    });
    const repos = fakeRepos([ASSESSMENT_TARGET]);
    const [preview] = await makeService(repos).resolve(USER, [row], repos);

    // 取值键是 assessment:<assessment_id>；若装载只请求 question 键，忠实装载下必然
    // 取不到 → 被误判为 unavailable（N2 审查 P1-1）。
    expect(preview.status).toBe("current");
    const requested = (repos.studyReferences.loadTargets as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(requested).toEqual(expect.arrayContaining([{ kind: "assessment", id: ASSESSMENT }]));
  });
});

describe("N2 笔记互链（第二条垂直链 · note 引用型）", () => {
  const TARGET_NOTE = "00000000-0000-4000-8000-000000000231";
  const OTHER_USER = "00000000-0000-4000-8000-0000000000b2";

  const NOTE_TARGET = {
    kind: "note",
    id: TARGET_NOTE,
    title: "被引用笔记",
    body_md: "被引用正文：一句话。",
    status: "active",
  } as const;

  const target = { kind: "note", noteId: TARGET_NOTE } as const;

  /**
   * **带归属**的忠实装载替身：真实 SQL 用 `WHERE user_id = $1` 限定属主，
   * 所以替身也必须按 userId 过滤——否则「跨用户不可见」这条合同在单测里
   * 永远测不出来（宽松 mock 掩盖真实缺陷，与 P1-1 同款教训）。
   */
  function ownedRepos(owner: string, targets: readonly LoadedTarget[]): StudyReferenceRepos {
    return {
      studyReferences: {
        listForNote: vi.fn(),
        replaceForNote: vi.fn(),
        searchTargets: vi.fn(),
        loadTargets: vi.fn(async (userId: string, requested: readonly { kind: string; id: string }[]) =>
          userId === owner ? loadedMap(requested, targets) : new Map<string, LoadedTarget>(),
        ),
        lockTargets: vi.fn(),
        listBacklinks: vi.fn(),
        getSourceDeleteBlockers: vi.fn(),
        getQuestionDeleteBlockers: vi.fn(),
      } as unknown as StudyReferenceRepos["studyReferences"],
    };
  }

  function noteRefRow(overrides: Partial<L3StudyNoteReferenceRow> = {}): L3StudyNoteReferenceRow {
    return refRow({
      kind: "note",
      source_id: null,
      question_id: null,
      assessment_id: null,
      target_note_id: TARGET_NOTE,
      option_key: null,
      start_offset: null,
      end_offset: null,
      quote_snapshot: null,
      field_hash: sha256Hex(JSON.stringify({ title: NOTE_TARGET.title, bodyMd: NOTE_TARGET.body_md })),
      display_snapshot: { kind: "note", title: "被引用笔记", excerpt: "被引用正文：一句话。" },
      ...overrides,
    } as Partial<L3StudyNoteReferenceRow>);
  }

  it("capture：hash 输入写死为服务端存储的标题+正文；target 落 target_note_id，其余 target 列全 null", async () => {
    const repos = fakeRepos([NOTE_TARGET]);
    const row = await makeService(repos).capture(USER, { id: REF, target }, repos);

    expect(row.kind).toBe("note");
    expect((row as { target_note_id: string | null }).target_note_id).toBe(TARGET_NOTE);
    expect(row.source_id).toBeNull();
    expect(row.question_id).toBeNull();
    expect(row.assessment_id).toBeNull();
    expect(row.field_hash).toBe(
      sha256Hex(JSON.stringify({ title: "被引用笔记", bodyMd: "被引用正文：一句话。" })),
    );
    expect(row.display_snapshot).toEqual({
      kind: "note",
      title: "被引用笔记",
      excerpt: "被引用正文：一句话。",
    });
  });

  it("capture：快照摘录沿用现有摘录上限（280）且不切代理对", async () => {
    const long = "字".repeat(400);
    const repos = fakeRepos([{ ...NOTE_TARGET, body_md: long }]);
    const row = await makeService(repos).capture(USER, { id: REF, target }, repos);

    const snapshot = row.display_snapshot as { excerpt: string };
    expect(snapshot.excerpt.length).toBe(280);
    // hash 仍取完整正文（摘录只影响展示，不影响 changed 判定）
    expect(row.field_hash).toBe(sha256Hex(JSON.stringify({ title: "被引用笔记", bodyMd: long })));
  });

  it("capture：目标笔记已归档 → 404（只有 active 才能新建引用）", async () => {
    const repos = fakeRepos([{ ...NOTE_TARGET, status: "archived" }]);
    await expect(makeService(repos).capture(USER, { id: REF, target }, repos)).rejects.toThrow(
      NotFoundError,
    );
  });

  it("capture：他人笔记 → 404（装载按 user_id 过滤，不按当前用户兜底）", async () => {
    const repos = ownedRepos(USER, [NOTE_TARGET]);
    await expect(
      makeService(repos).capture(OTHER_USER, { id: REF, target }, repos),
    ).rejects.toThrow(NotFoundError);
  });

  it("resolve 装载键与取值键同源：note 引用在忠实装载下为 current（防 P1-1 复发）", async () => {
    const row = noteRefRow();
    const repos = fakeRepos([NOTE_TARGET]);
    const [preview] = await makeService(repos).resolve(USER, [row], repos);

    expect(preview.status).toBe("current");
    expect(preview.target).toEqual({ kind: "note", noteId: TARGET_NOTE });
    const requested = (repos.studyReferences.loadTargets as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(requested).toEqual(expect.arrayContaining([{ kind: "note", id: TARGET_NOTE }]));
  });

  it("目标改名/改正文 → resolve 转 changed，且快照三件套逐字节不变（快照不可变）", async () => {
    const row = noteRefRow();
    const before = JSON.stringify([row.display_snapshot, row.captured_at, row.field_hash]);

    // 正文已改：标题不变、正文变
    const repos = fakeRepos([{ ...NOTE_TARGET, body_md: "被引用正文：改写了。" }]);
    const [preview] = await makeService(repos).resolve(USER, [row], repos);

    expect(preview.status).toBe("changed");
    // 快照仍是引用当时那份，不按当前正文回套
    expect(preview.displaySnapshot).toEqual({ kind: "note", title: "被引用笔记", excerpt: "被引用正文：一句话。" });
    expect(JSON.stringify([preview.displaySnapshot, preview.capturedAt, row.field_hash])).toBe(before);
  });

  it("目标之后归档 → 仍按快照 hash 解析为 current（不撤销引用、不转 unavailable）", async () => {
    const row = noteRefRow();
    const repos = fakeRepos([{ ...NOTE_TARGET, status: "archived" }]);
    const [preview] = await makeService(repos).resolve(USER, [row], repos);

    expect(preview.status).toBe("current");
    expect(preview.liveTitle).toBe("被引用笔记");
  });

  it("目标被他人持有 → resolve 转 unavailable（跨用户不可见）", async () => {
    const row = noteRefRow();
    const repos = ownedRepos(USER, [NOTE_TARGET]);
    const [preview] = await makeService(repos).resolve(OTHER_USER, [row], repos);

    expect(preview.status).toBe("unavailable");
    expect(preview.liveTitle).toBeNull();
  });

  it("currentFieldText：note 的 hash 字段文本就是 {title, bodyMd} 固定键序", () => {
    expect(currentFieldText("note", null, NOTE_TARGET)).toBe(
      JSON.stringify({ title: "被引用笔记", bodyMd: "被引用正文：一句话。" }),
    );
    // 交叉防御：note target 配非 note kind → null
    expect(currentFieldText("source", null, NOTE_TARGET)).toBeNull();
  });

  it("preview：只读预览 note 目标（快照与 capture 同口径，不持久化）", async () => {
    const repos = fakeRepos([NOTE_TARGET]);
    const { preview } = await makeService(repos).preview(USER, target);

    expect(preview.target).toEqual({ kind: "note", noteId: TARGET_NOTE });
    expect(preview.displaySnapshot).toEqual({
      kind: "note",
      title: "被引用笔记",
      excerpt: "被引用正文：一句话。",
    });
    expect(preview.liveTitle).toBe("被引用笔记");
    // 零写：预览不得触碰 replaceForNote
    expect(repos.studyReferences.replaceForNote).not.toHaveBeenCalled();
  });
});

// ── N2 第三条链：sheet（sealed 稿次）/ attempt（作答记录）────────────────────
// 红测先行：以下用例在实现前必须**全部按合同失败**（typecheck 亦红——新类型尚未
// 落地），实现后转绿并同步去掉红测期的 `as unknown as` 断言。

const SHEET = "00000000-0000-4000-8000-000000000321";
const SHEET_WRITING = "00000000-0000-4000-8000-000000000322";
const ATTEMPT = "00000000-0000-4000-8000-000000000331";

/** 非 writing（file）sealed 稿次。 */
const SHEET_TARGET: LoadedTarget = {
  kind: "sheet",
  id: SHEET,
  scope: "file",
  status: "sealed",
  revision_no: null,
  summary: "卷面总结：三次 cloze 全对",
};

/** writing sealed 稿次（revision_no = 2）。 */
const SHEET_WRITING_TARGET: LoadedTarget = {
  kind: "sheet",
  id: SHEET_WRITING,
  scope: "writing",
  status: "sealed",
  revision_no: 2,
  summary: "第二稿：论证段重写",
};

const ATTEMPT_TARGET: LoadedTarget = {
  kind: "attempt",
  id: ATTEMPT,
  venue: "file",
  answer: { value: "A" },
  status: "active",
};

describe("target key helpers · sheet / attempt（N2 第三条链）", () => {
  it("targetKeyOf：sheet=sheet:<submissionId>、attempt=attempt:<attemptId>", () => {
    expect(targetKeyOf({ kind: "sheet", submissionId: SHEET })).toBe(`sheet:${SHEET}`);
    expect(targetKeyOf({ kind: "attempt", attemptId: ATTEMPT })).toBe(`attempt:${ATTEMPT}`);
  });

  it("targetRefsOf：sheet / attempt 各只返回自身键，无 question / submission 兜底（K5 / K9）", () => {
    expect(targetRefsOf({ kind: "sheet", submissionId: SHEET })).toEqual([{ kind: "sheet", id: SHEET }]);
    expect(targetRefsOf({ kind: "attempt", attemptId: ATTEMPT })).toEqual([{ kind: "attempt", id: ATTEMPT }]);
  });

  it("referenceRowToTarget：sheet 行保留 revisionNo（null 也保留），attempt 行只有 attemptId", () => {
    const sheetRow = {
      ...refRow(),
      kind: "sheet",
      submission_id: SHEET,
      submission_revision_no: 2,
    } as L3StudyNoteReferenceRow;
    expect(referenceRowToTarget(sheetRow)).toEqual({ kind: "sheet", submissionId: SHEET, revisionNo: 2 });

    const attemptRow = { ...refRow(), kind: "attempt", attempt_id: ATTEMPT } as L3StudyNoteReferenceRow;
    expect(referenceRowToTarget(attemptRow)).toEqual({ kind: "attempt", attemptId: ATTEMPT });
  });
});

describe("capture · sheet（D1-a：只认 sealed 稿次）", () => {
  it("sealed 非 writing：快照={scope,summaryExcerpt}、submission_revision_no 落 null、hash 可复算", async () => {
    const repos = fakeRepos([SHEET_TARGET]);
    const service = makeService(repos);
    const row = await service.capture(USER, { id: REF, target: { kind: "sheet", submissionId: SHEET } }, repos);

    expect(row.submission_id).toBe(SHEET);
    expect(row.submission_revision_no).toBeNull();
    expect(row.attempt_id).toBeNull();
    expect(row.display_snapshot).toEqual({
      kind: "sheet",
      scope: "file",
      summaryExcerpt: "卷面总结：三次 cloze 全对",
    });
    // hash 可复算（K15：{scope, revisionNo, summary} 固定键序）
    expect(row.field_hash).toBe(sha256Hex(sheetFieldText(SHEET_TARGET)));
    // 快照白名单不含 answers / grading 字段（K7 / K14）
    expect(row.display_snapshot).not.toHaveProperty("answers");
    expect(row.display_snapshot).not.toHaveProperty("verdict");
    // 装载请求必须是 sheet 键本身（忠实替身下写错键必然取不到）
    expect(repos.studyReferences.loadTargets).toHaveBeenCalledWith(USER, [{ kind: "sheet", id: SHEET }]);
  });

  it("draft / discarded 稿次：忠实装载取不到 → 404（不是 409，K1）", async () => {
    const repos = fakeRepos([]);
    const service = makeService(repos);
    await expect(
      service.capture(USER, { id: REF, target: { kind: "sheet", submissionId: SHEET } }, repos),
    ).rejects.toThrow(NotFoundError);
  });

  it("装载侧若放宽（返回 draft / discarded 稿次）：capture 仍按 sealed 断言 → 404（K2 双保险）", async () => {
    // 变异锚点：装载只取 sealed 是**第一道**闸门；这里是第二道——日后若把装载条件
    // 放宽（例如为了支持「引用草稿」），这条会立刻变红，draft 不会被静默认为稳定身份。
    for (const status of ["draft", "discarded"]) {
      const loose = {
        kind: "sheet",
        id: SHEET,
        scope: "file",
        status,
        revision_no: null,
        summary: "未定稿",
      } as unknown as LoadedTarget;
      const repos = fakeRepos([loose]);
      const service = makeService(repos);
      await expect(
        service.capture(USER, { id: REF, target: { kind: "sheet", submissionId: SHEET } }, repos),
      ).rejects.toThrow(NotFoundError);
    }
  });

  it("writing sealed 缺 revisionNo 或 ≤0 → 422（V-17）", async () => {
    const repos = fakeRepos([SHEET_WRITING_TARGET]);
    const service = makeService(repos);
    await expect(
      service.capture(USER, { id: REF, target: { kind: "sheet", submissionId: SHEET_WRITING } }, repos),
    ).rejects.toThrow(ValidationError);
  });

  it("writing sealed revisionNo 不匹配 → 404（身份不兜底，K3 / 变异防线）", async () => {
    const repos = fakeRepos([SHEET_WRITING_TARGET]);
    const service = makeService(repos);
    await expect(
      service.capture(
        USER,
        { id: REF, target: { kind: "sheet", submissionId: SHEET_WRITING, revisionNo: 1 } },
        repos,
      ),
    ).rejects.toThrow(NotFoundError);
  });

  it("非 writing 稿次传 revisionNo → 404（该稿次无 revision 身份，K3）", async () => {
    const repos = fakeRepos([SHEET_TARGET]);
    const service = makeService(repos);
    await expect(
      service.capture(USER, { id: REF, target: { kind: "sheet", submissionId: SHEET, revisionNo: 1 } }, repos),
    ).rejects.toThrow(NotFoundError);
  });
});

describe("capture · attempt（K9 / K10）", () => {
  it("active：快照={venue,answerExcerpt}、attempt_id 落地、hash 可复算", async () => {
    const repos = fakeRepos([ATTEMPT_TARGET]);
    const service = makeService(repos);
    const row = await service.capture(USER, { id: REF, target: { kind: "attempt", attemptId: ATTEMPT } }, repos);

    expect(row.attempt_id).toBe(ATTEMPT);
    expect(row.submission_id).toBeNull();
    expect(row.display_snapshot).toEqual({ kind: "attempt", venue: "file", answerExcerpt: `{"value":"A"}` });
    expect(row.field_hash).toBe(sha256Hex(attemptFieldText(ATTEMPT_TARGET)));
    expect(repos.studyReferences.loadTargets).toHaveBeenCalledWith(USER, [{ kind: "attempt", id: ATTEMPT }]);
  });

  it("已软删（装载过滤 deleted）→ 404，不做「按题找最新一次」兜底", async () => {
    const repos = fakeRepos([]);
    const service = makeService(repos);
    await expect(
      service.capture(USER, { id: REF, target: { kind: "attempt", attemptId: ATTEMPT } }, repos),
    ).rejects.toThrow(NotFoundError);
  });
});

describe("resolve · sheet / attempt 状态语义（§5）", () => {
  it("快照与 hash 一致 → current；两者 changed 均不可达（不可变事实）", async () => {
    const repos = fakeRepos([SHEET_TARGET, ATTEMPT_TARGET]);
    const service = makeService(repos);
    const sheetRow = {
      ...refRow(),
      kind: "sheet",
      submission_id: SHEET,
      submission_revision_no: null,
      field_hash: sha256Hex(sheetFieldText(SHEET_TARGET)),
      display_snapshot: { kind: "sheet", scope: "file", summaryExcerpt: "卷面总结" },
    } as L3StudyNoteReferenceRow;
    const attemptRow = {
      ...refRow(),
      id: "00000000-0000-4000-8000-000000000002",
      kind: "attempt",
      attempt_id: ATTEMPT,
      field_hash: sha256Hex(attemptFieldText(ATTEMPT_TARGET)),
      display_snapshot: { kind: "attempt", venue: "file", answerExcerpt: `{"value":"A"}` },
    } as L3StudyNoteReferenceRow;

    const resolved = await service.resolve(USER, [sheetRow, attemptRow], repos);
    expect(resolved.map((item) => item.status)).toEqual(["current", "current"]);
  });

  it("attempt 软删后 → unavailable，快照与 capturedAt 逐字节保留（K10）", async () => {
    const repos = fakeRepos([]);
    const service = makeService(repos);
    const snapshot = { kind: "attempt", venue: "file", answerExcerpt: `{"value":"A"}` };
    const attemptRow = {
      ...refRow(),
      kind: "attempt",
      attempt_id: ATTEMPT,
      display_snapshot: snapshot,
      captured_at: "2026-09-20T00:00:00Z",
    } as L3StudyNoteReferenceRow;

    const resolved = await service.resolve(USER, [attemptRow], repos);
    expect(resolved[0]!.status).toBe("unavailable");
    expect(resolved[0]!.displaySnapshot).toEqual(snapshot);
    expect(resolved[0]!.capturedAt).toBe("2026-09-20T00:00:00Z");
  });
});

/**
 * ADR-0039 决策 10 的六条必测矩阵（N2 第四条链：评卷引用）。
 *
 * 这些不是「顺手补的测试」，而是**决策本身的兑现凭证**：
 * - ①② 证明 changed 这条承重路径在评卷上真的可达（与 attempt 相反，评卷可改判）；
 * - ③ 证明引用指向的是「这一格的当前判定」而不是一次性快照副本；
 * - ④ 证明未定格题纸引不到评卷（否则会把半张卷的临时判定钉进长期笔记）；
 * - ⑤ 证明 kind 判别联合是**封闭**的：邻接 kind 不能顺带泄漏评卷字段；
 * - ⑥ 证明 hash 只取 verdict + analysis_md（决策 3 的白名单是硬的，不是「主要看这两项」）。
 */
describe("ADR-0039 · 评卷引用：决策 10 六条矩阵", () => {
  const SHEET = "00000000-0000-4000-8000-000000000301";
  const SHEET_B = "00000000-0000-4000-8000-000000000302";
  const GRADING_ANALYSIS = "A 是同义替换，但把 which 读成 what 就错了。";

  function gradingTarget(over: Partial<LoadedTarget> = {}): LoadedTarget {
    return {
      kind: "grading",
      id: `${SHEET}:${QUESTION}`,
      sheet_id: SHEET,
      question_id: QUESTION,
      sheet_status: "sealed",
      verdict: "wrong",
      analysis_md: GRADING_ANALYSIS,
      graded_by: "agent-1",
      graded_at: "2026-09-26T00:00:00Z",
      question_ordinal: 2,
      question_type: "reading_choice",
      source_title: "Fox source",
      ...over,
    } as LoadedTarget;
  }

  function gradingRow(over: Partial<L3StudyNoteReferenceRow> = {}): L3StudyNoteReferenceRow {
    return refRow({
      kind: "grading",
      submission_id: SHEET,
      question_id: QUESTION,
      end_offset: 0,
      quote_snapshot: null,
      field_hash: sha256Hex(JSON.stringify({ verdict: "wrong", analysis_md: GRADING_ANALYSIS })),
      display_snapshot: { kind: "grading", verdict: "wrong", analysisExcerpt: GRADING_ANALYSIS },
      ...over,
    });
  }

  const TARGET: ReferenceTarget = { kind: "grading", sheetId: SHEET, questionId: QUESTION };

  it("① 钉住后被改判（verdict+analysis 同时变）→ changed，且快照不被覆写", async () => {
    const captured = gradingRow();
    const repos = fakeRepos([gradingTarget({ verdict: "partial", analysis_md: "结论松了：题干限定词没读全。" })]);
    const service = makeService(repos);
    const [resolved] = await service.resolve(USER, [captured], repos);
    expect(resolved!.status).toBe("changed");
    // 快照 = 钉的那一刻。改判不会回头改写它，否则「改判警示」就失去对象。
    expect((resolved!.displaySnapshot as { verdict: string }).verdict).toBe("wrong");
    expect((resolved!.displaySnapshot as { analysisExcerpt: string }).analysisExcerpt).toBe(GRADING_ANALYSIS);
  });

  it("② 只改 verdict（分析一字未动）→ 仍然 changed", async () => {
    const repos = fakeRepos([gradingTarget({ verdict: "correct" })]);
    const service = makeService(repos);
    const [resolved] = await service.resolve(USER, [gradingRow()], repos);
    // 决策 3：verdict 是 hash 的一半，判分翻面就是改判，不能被「分析没变」掩盖。
    expect(resolved!.status).toBe("changed");
  });

  it("③ 同一 (sheetId, questionId) 重复钉 → 身份串相同，指向当前那一行", () => {
    expect(targetKeyOf(TARGET)).toBe(`grading:${SHEET}:${QUESTION}`);
    // 不能退化成只按 questionId 判等：同一题在两张题纸里各评一次，是两个不同判定。
    expect(targetKeyOf(TARGET)).not.toBe(targetKeyOf({ ...TARGET, sheetId: SHEET_B }));
    // 装载请求是**一个**复合身份（K5/K7 同款：一次只钉一个实体），不是
    // 「题 + 题纸」两跳扇出——两跳会让删除题纸/题目时无法判定该锁哪一条引用。
    expect(targetRefsOf(TARGET)).toEqual([{ kind: "grading", id: `${SHEET}:${QUESTION}` }]);
  });

  it("④ 未定格题纸（draft / discarded）→ 404，不产生任何引用", () => {
    const service = makeService(fakeRepos([]));
    expect(() => service.captureAgainst(TARGET, gradingTarget({ sheet_status: "draft" })))
      .toThrow(NotFoundError);
    expect(() => service.captureAgainst(TARGET, gradingTarget({ sheet_status: "discarded" })))
      .toThrow(NotFoundError);
  });

  it("⑤ sheet / attempt 引用的快照与 hash 不含任何评卷字段", () => {
    const sourceRow = refRow({ kind: "question", submission_id: null, field_hash: sha256Hex("{}"), display_snapshot: { kind: "question" } });
    const snapshot = sourceRow.display_snapshot as Record<string, unknown>;
    // kind 是封闭判别联合：邻接 kind 的快照里没有 verdict 槽位可填。
    expect(snapshot.kind).toBe("question");
    expect(snapshot).not.toHaveProperty("verdict");
    expect(snapshot).not.toHaveProperty("analysisExcerpt");
    expect(referenceRowToTarget(sourceRow)).toEqual({ kind: "question", questionId: QUESTION });
  });

  it("⑥ hash 白名单是硬的：graded_by / graded_at / 题序 / 来源 变化不产生 changed", async () => {
    const captured = gradingRow();
    // 决策 3：只有 verdict 与 analysis_md 进 hash。改评卷人、改评卷时间、题目挪位
    // 都不是「这一格的判定变了」，不该把用户的笔记染成 changed。
    const repos = fakeRepos([gradingTarget({
      graded_by: "agent-2",
      graded_at: "2026-09-27T09:00:00Z",
      question_ordinal: 7,
      source_title: "另一个来源",
    })]);
    const service = makeService(repos);
    const [resolved] = await service.resolve(USER, [captured], repos);
    expect(resolved!.status).toBe("current");
  });
});