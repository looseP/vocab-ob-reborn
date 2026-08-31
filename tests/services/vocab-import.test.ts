import { describe, expect, it, vi, beforeEach } from "vitest";
import type { IRepositories, IWordRepository, UpsertFullWordInput } from "@/repositories/interfaces";
import { VocabImportService, isNonVocabNoteFile } from "@/services/vocab-import.service";
import { plazaCache } from "@/services/plaza-cache";

const mockRepos: Partial<IRepositories> = {};

const { withTransactionMock } = vi.hoisted(() => ({
  withTransactionMock: vi.fn(),
}));

vi.mock("@/db/transaction", () => ({
  withTransaction: withTransactionMock,
}));
vi.mock("@/repositories/factory", () => ({
  createRepositories: vi.fn(() => mockRepos),
}));

function makeWordsRepo(upsertFullWord?: ReturnType<typeof vi.fn>): IWordRepository {
  const repo = {
    findBySlug: vi.fn(async () => null),
    insertMany: vi.fn(async () => 0),
    ...(upsertFullWord ? { upsertFullWord } : {}),
  };
  return repo as unknown as IWordRepository;
}

const OK_FILE = {
  path: "L1_雅思词汇_交通旅行.md",
  content: `# t\n\n---\n\n## accelerate\n\n### Identity\n- lemma: accelerate\n- pos: v\n- ipa: /əkˈseləreɪt/\n\n### Short Definition\n加速\n\n### Core Definitions\n1. 加速\n   - en: to increase speed\n   - priority: 1\n   - tags: core\n`,
  updatedAt: "2026-08-22T00:00:00Z",
};

describe("VocabImportService.importFiles", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("imports a well-formed file and forwards hash/source fields to the repository", async () => {
    const upsertFullWord = vi.fn(async (_input: UpsertFullWordInput) => "imported" as const);
    const service = new VocabImportService(makeWordsRepo(upsertFullWord));

    const result = await service.importFiles([OK_FILE]);

    expect(result.stats).toMatchObject({ files: 1, imported: 1, rejected: 0, failed: 0 });
    expect(result.results[0]).toMatchObject({ path: OK_FILE.path, status: "imported", total: 1 });
    expect(result.dryRun).toBe(false);
    expect(result.results[0]!.words).toMatchObject([
      { slug: "accelerate", pos: "v", cefr: null, tier: "ok", score: expect.any(Number), outcome: "imported" },
    ]);
    const call = upsertFullWord.mock.calls[0]![0] as UpsertFullWordInput;
    expect(call.slug).toBe("accelerate");
    expect(call.sourcePath).toBe(OK_FILE.path);
    expect(call.sourceUpdatedAt).toBe("2026-08-22T00:00:00Z");
    expect(call.isPublished).toBe(true);
    expect(call.qualityStatus).toBe("ok");
    expect(call.contentHash).toHaveLength(64);
  });

  it("skips the repository entirely for quality-rejected words", async () => {
    const noDefinition = {
      ...OK_FILE,
      content: `# t\n\n---\n\n## ghost\n\n### Identity\n- lemma: ghost\n`,
    };
    const upsertFullWord = vi.fn(async (_input: UpsertFullWordInput) => "imported" as const);
    const service = new VocabImportService(makeWordsRepo(upsertFullWord));

    const result = await service.importFiles([noDefinition]);

    expect(result.results[0]!.status).toBe("rejected");
    expect(result.stats.rejected).toBe(1);
    expect(result.results[0]!.issues[0]).toContain("ghost");
    expect(result.results[0]!.words).toMatchObject([
      { slug: "ghost", pos: null, cefr: null, tier: "rejected", score: expect.any(Number) },
    ]);
    expect(result.results[0]!.words[0]!.issues.length).toBeGreaterThan(0);
    expect(upsertFullWord).not.toHaveBeenCalled();
  });

  it("never touches the repository in dryRun mode", async () => {
    const upsertFullWord = vi.fn(async (_input: UpsertFullWordInput) => "imported" as const);
    const service = new VocabImportService(makeWordsRepo(upsertFullWord));

    const result = await service.importFiles([OK_FILE], { dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.stats.imported).toBe(1);
    expect(result.results[0]!.words[0]).toMatchObject({ slug: "accelerate", tier: "ok" });
    expect(result.results[0]!.words[0]!.outcome).toBeUndefined();
    expect(upsertFullWord).not.toHaveBeenCalled();
  });

  it("reports dryRun=false by default so consumers can trust the write outcome", async () => {
    const upsertFullWord = vi.fn(async (_input: UpsertFullWordInput) => "imported" as const);
    const service = new VocabImportService(makeWordsRepo(upsertFullWord));

    const result = await service.importFiles([OK_FILE]);

    expect(result.dryRun).toBe(false);
    expect(upsertFullWord).toHaveBeenCalledTimes(1);
  });

  it("invalidates the plaza aggregate cache after a real import", async () => {
    const upsertFullWord = vi.fn(async (_input: UpsertFullWordInput) => "imported" as const);
    const service = new VocabImportService(makeWordsRepo(upsertFullWord));
    const invalidate = vi.spyOn(plazaCache, "invalidateAll");

    await service.importFiles([OK_FILE]);

    expect(upsertFullWord).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledTimes(1);
    invalidate.mockRestore();
  });

  it("does not invalidate the plaza cache in dryRun mode", async () => {
    const upsertFullWord = vi.fn(async (_input: UpsertFullWordInput) => "imported" as const);
    const service = new VocabImportService(makeWordsRepo(upsertFullWord));
    const invalidate = vi.spyOn(plazaCache, "invalidateAll");

    await service.importFiles([OK_FILE], { dryRun: true });

    expect(upsertFullWord).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
    invalidate.mockRestore();
  });

  it("isolates a failing file so later files still import", async () => {
    const upsertFullWord = vi.fn(async (_input: UpsertFullWordInput) => "imported" as const);
    const service = new VocabImportService(makeWordsRepo(upsertFullWord));

    const result = await service.importFiles([
      { path: "broken.md", content: "no heading at all" },
      OK_FILE,
    ]);

    expect(result.results[0]!.status).toBe("failed");
    expect(result.results[0]!.error).toContain("no word entries");
    expect(result.results[1]!.status).toBe("imported");
    expect(result.stats.failed).toBe(1);
    expect(result.stats.imported).toBe(1);
  });

  it("propagates unchanged outcomes from the repository", async () => {
    const upsertFullWord = vi.fn(async (_input: UpsertFullWordInput) => "unchanged" as const);
    const service = new VocabImportService(makeWordsRepo(upsertFullWord));

    const result = await service.importFiles([OK_FILE]);

    expect(result.results[0]!.status).toBe("unchanged");
    expect(result.stats.unchanged).toBe(1);
  });

  it("marks needs_supplement files unpublished when strict mode flags them", async () => {
    const missingIpa = {
      ...OK_FILE,
      content: OK_FILE.content.replace("- ipa: /əkˈseləreɪt/", "- ipa:"),
    };
    const upsertFullWord = vi.fn(async (_input: UpsertFullWordInput) => "imported" as const);
    const service = new VocabImportService(makeWordsRepo(upsertFullWord));

    const result = await service.importFiles([missingIpa], { strictness: "strict" });

    expect(result.results[0]!.status).toBe("needs_supplement");
    expect(result.results[0]!.words[0]!.issues.join("\n")).toContain("缺少音标");
    const call = upsertFullWord.mock.calls[0]![0] as UpsertFullWordInput;
    expect(call.isPublished).toBe(false);
    expect(call.qualityStatus).toBe("needs_supplement");
  });

  it("flags duplicate slugs across files instead of silently overwriting", async () => {
    const upsertFullWord = vi.fn(async (_input: UpsertFullWordInput) => "imported" as const);
    const service = new VocabImportService(makeWordsRepo(upsertFullWord));
    const dupFile = { ...OK_FILE, path: "L1_重复.md" };

    const result = await service.importFiles([OK_FILE, dupFile]);

    expect(result.results[0]!.words[0]!.issues).toEqual([]);
    expect(result.results[1]!.words[0]!.issues.join(";")).toContain("重复词条 slug");
    expect(result.results[1]!.issues.join(";")).toContain("首次出现于 L1_雅思词汇_交通旅行.md");
    // Both occurrences still import — last write wins is preserved.
    expect(result.stats.imported).toBe(2);
  });
});

describe("VocabImportService 非单词样本守卫（P0）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("isNonVocabNoteFile flags README.md and system/backup dirs", () => {
    expect(isNonVocabNoteFile("README.md")).toBe(true);
    expect(isNonVocabNoteFile("notes/README.md")).toBe(true);
    expect(isNonVocabNoteFile("_系统/模板.md")).toBe(true);
    expect(isNonVocabNoteFile("_校验信息/校验.md")).toBe(true);
    expect(isNonVocabNoteFile("_backup/旧词库.md")).toBe(true);
    expect(isNonVocabNoteFile("L1_雅思词汇_交通旅行.md")).toBe(false);
    expect(isNonVocabNoteFile("L1_雅思词汇/accelerate.md")).toBe(false);
  });

  it("skips README / system-dir files entirely without touching the repository", async () => {
    const readme = {
      path: "README.md",
      content: `# 包说明\n\n## 一、包内目录结构\n\n说明文字\n\n## 二、四库词数与 confidence\n\n统计信息\n`,
      updatedAt: "2026-08-22T00:00:00Z",
    };
    const upsertFullWord = vi.fn(async (_input: UpsertFullWordInput) => "imported" as const);
    const service = new VocabImportService(makeWordsRepo(upsertFullWord));

    const result = await service.importFiles([readme]);

    expect(result.results[0]!.status).toBe("unchanged");
    expect(result.results[0]!.total).toBe(0);
    expect(result.results[0]!.issues.join(";")).toContain("跳过非词库笔记文件");
    expect(upsertFullWord).not.toHaveBeenCalled();
  });

  it("rejects a headword that cannot produce a slug (non-latin) even with a definition", async () => {
    const chineseHeading = {
      ...OK_FILE,
      content: `# t\n\n---\n\n## 勇气\n\n### Identity\n- lemma: 勇气\n- pos: n.\n\n### Short Definition\n勇气\n\n### Core Definitions\n1. 勇气\n   - en: courage\n   - priority: 1\n   - tags: core\n`,
    };
    const upsertFullWord = vi.fn(async (_input: UpsertFullWordInput) => "imported" as const);
    const service = new VocabImportService(makeWordsRepo(upsertFullWord));

    const result = await service.importFiles([chineseHeading]);

    expect(result.results[0]!.status).toBe("rejected");
    expect(result.stats.rejected).toBe(1);
    expect(result.results[0]!.issues.join(";")).toContain("无法生成 slug");
    expect(result.results[0]!.words[0]).toMatchObject({
      slug: "",
      tier: "rejected",
      score: 0,
    });
    expect(upsertFullWord).not.toHaveBeenCalled();
  });
});
