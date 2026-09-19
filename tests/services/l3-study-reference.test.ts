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
    const preview = await service.preview(USER, { kind: "stem_quote", questionId: QUESTION, start: 0, end: 4, quote: "What" });
    expect(preview.liveTitle).toBe("Fox source");
    expect(preview.displaySnapshot).toMatchObject({ kind: "stem_quote", quote: "What" });
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
