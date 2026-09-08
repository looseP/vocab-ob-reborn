import { describe, it, expect, vi, beforeEach } from "vitest";
import type { IRepositories, IWordRepository, IL3ContextRepository } from "@/repositories/interfaces";
import { L3ContextService } from "@/services/l3-context.service";

const mockRepos: Partial<IRepositories> = {};
const { withTransactionMock } = vi.hoisted(() => ({
  withTransactionMock: vi.fn(async (cb: (tx: unknown) => Promise<unknown>, _o?: { actorId?: string }) => cb({})),
}));
vi.mock("@/db/transaction", () => ({ withTransaction: withTransactionMock }));
vi.mock("@/repositories/factory", () => ({ createRepositories: vi.fn(() => mockRepos) }));

function makeService() {
  return new L3ContextService(mockRepos.l3Context as IL3ContextRepository, mockRepos.words as IWordRepository);
}

describe("createSelectionCapture (S3 圈记)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("binds context+occurrence to existing word with global anchor", async () => {
    const source = { id: "s1", user_id: "u1", content_text: "Alpha beta. Gamma delta epsilon. Zeta.", language: "en" };
    const word = { id: "w-1", slug: "delta", title: "delta", lemma: "delta" };
    const l3 = {
      lockSourceByIdForUser: vi.fn().mockResolvedValue(source),
      findWordBySlug: vi.fn().mockResolvedValue(word),
      findContextByAnchor: vi.fn().mockResolvedValue(null),
      listOccurrencesForContext: vi.fn().mockResolvedValue([]),
      createContext: vi.fn().mockResolvedValue({ id: "ctx-1" }),
      createOccurrence: vi.fn().mockResolvedValue({ id: "occ-1" }),
    };
    mockRepos.l3Context = l3 as unknown as IL3ContextRepository;
    mockRepos.words = { insertMany: vi.fn(), findBySlug: vi.fn() } as unknown as IWordRepository;

    const svc = makeService();
    const res = await svc.createSelectionCapture({
      userId: "u1", sourceId: "s1", text: "Gamma delta epsilon.",
      anchorStart: 12, anchorEnd: 32, surface: "delta", wordSlug: "delta",
    });
    expect(l3.createContext).toHaveBeenCalledWith(expect.objectContaining({
      source_id: "s1", context_type: "sentence",
      position: { start: 12, end: 32 },
    }));
    expect(l3.createOccurrence).toHaveBeenCalledWith(expect.objectContaining({
      context_id: "ctx-1", word_id: "w-1", surface: "delta", start_offset: 6, end_offset: 11,
    }));
    expect(res).toEqual(expect.objectContaining({ contextId: "ctx-1", occurrenceId: "occ-1", created: false }));
  });

  it("creates word stub via words repo when slug missing (capture-first)", async () => {
    const source = { id: "s1", user_id: "u1", content_text: "Some text with Xylophone here.", language: "en" };
    const l3 = {
      lockSourceByIdForUser: vi.fn().mockResolvedValue(source),
      findWordBySlug: vi.fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: "w-new", slug: "xylophone", title: "xylophone", lemma: "xylophone" }),
      findContextByAnchor: vi.fn().mockResolvedValue(null),
      listOccurrencesForContext: vi.fn().mockResolvedValue([]),
      createContext: vi.fn().mockResolvedValue({ id: "ctx-2" }),
      createOccurrence: vi.fn().mockResolvedValue({ id: "occ-2" }),
    };
    const words = { insertMany: vi.fn(async () => 1), findBySlug: vi.fn(async () => null) };
    mockRepos.l3Context = l3 as unknown as IL3ContextRepository;
    mockRepos.words = words as unknown as IWordRepository;

    const svc = makeService();
    const res = await svc.createSelectionCapture({
      userId: "u1", sourceId: "s1", text: "Some text with Xylophone here.",
      anchorStart: 0, anchorEnd: 30, surface: "Xylophone", wordSlug: "xylophone",
    });
    expect(words.insertMany).toHaveBeenCalledTimes(1);
    expect(res.created).toBe(true);
    expect(res.word).toEqual(expect.objectContaining({ slug: "xylophone" }));
  });

  it("rejects when source has no content_text or anchor out of range", async () => {
    const l3 = {
      lockSourceByIdForUser: vi.fn().mockResolvedValue({ id: "s1", user_id: "u1", content_text: null }),
    };
    mockRepos.l3Context = l3 as unknown as IL3ContextRepository;
    mockRepos.words = { insertMany: vi.fn(), findBySlug: vi.fn() } as unknown as IWordRepository;
    const svc = makeService();
    await expect(svc.createSelectionCapture({
      userId: "u1", sourceId: "s1", text: "x", anchorStart: 0, anchorEnd: 1, surface: "x", wordSlug: "x",
    })).rejects.toThrow();
  });

  // ① 圈记幂等复用（用户反馈 2026-09-08）：一句话涉及多个词——同来源同锚点再圈另一词时
  // 必须复用既有 context 只追加 occurrence，而非新建重复语境行。
  it("reuses the existing context at the same anchor and appends a second occurrence", async () => {
    const source = { id: "s1", user_id: "u1", content_text: "Alpha beta. Gamma delta epsilon. Zeta.", language: "en" };
    const existing = { id: "ctx-1", source_id: "s1", position: { start: 12, end: 32 } };
    const wordB = { id: "w-2", slug: "epsilon", title: "epsilon", lemma: "epsilon" };
    const l3 = {
      lockSourceByIdForUser: vi.fn().mockResolvedValue(source),
      findWordBySlug: vi.fn().mockResolvedValue(wordB),
      findContextByAnchor: vi.fn().mockResolvedValue(existing),
      listOccurrencesForContext: vi.fn().mockResolvedValue([]),
      createContext: vi.fn(),
      createOccurrence: vi.fn().mockResolvedValue({ id: "occ-9" }),
    };
    mockRepos.l3Context = l3 as unknown as IL3ContextRepository;
    mockRepos.words = { insertMany: vi.fn(), findBySlug: vi.fn() } as unknown as IWordRepository;

    const svc = makeService();
    const res = await svc.createSelectionCapture({
      userId: "u1", sourceId: "s1", text: "Gamma delta epsilon.",
      anchorStart: 12, anchorEnd: 32, surface: "epsilon", wordSlug: "epsilon",
    });
    expect(l3.findContextByAnchor).toHaveBeenCalledWith("u1", "s1", 12, 32);
    expect(l3.createContext).not.toHaveBeenCalled();
    expect(l3.createOccurrence).toHaveBeenCalledWith(expect.objectContaining({
      context_id: "ctx-1", word_id: "w-2", surface: "epsilon",
    }));
    expect(res).toEqual(expect.objectContaining({ contextId: "ctx-1", occurrenceId: "occ-9", created: false }));
  });

  it("returns the existing occurrence idempotently when the same word is re-captured at the same anchor", async () => {
    const source = { id: "s1", user_id: "u1", content_text: "Alpha beta. Gamma delta epsilon. Zeta.", language: "en" };
    const existing = { id: "ctx-1", source_id: "s1", position: { start: 12, end: 32 } };
    const word = { id: "w-1", slug: "delta", title: "delta", lemma: "delta" };
    const l3 = {
      lockSourceByIdForUser: vi.fn().mockResolvedValue(source),
      findWordBySlug: vi.fn().mockResolvedValue(word),
      findContextByAnchor: vi.fn().mockResolvedValue(existing),
      listOccurrencesForContext: vi.fn().mockResolvedValue([
        { id: "occ-1", context_id: "ctx-1", word_id: "w-1", surface: "delta" },
      ]),
      createContext: vi.fn(),
      createOccurrence: vi.fn(),
    };
    mockRepos.l3Context = l3 as unknown as IL3ContextRepository;
    mockRepos.words = { insertMany: vi.fn(), findBySlug: vi.fn() } as unknown as IWordRepository;

    const svc = makeService();
    const res = await svc.createSelectionCapture({
      userId: "u1", sourceId: "s1", text: "Gamma delta epsilon.",
      anchorStart: 12, anchorEnd: 32, surface: "delta", wordSlug: "delta",
    });
    expect(l3.createOccurrence).not.toHaveBeenCalled();
    expect(res).toEqual(expect.objectContaining({ contextId: "ctx-1", occurrenceId: "occ-1", created: false }));
  });

  it("creates a new context when no context exists at the anchor", async () => {
    const source = { id: "s1", user_id: "u1", content_text: "Alpha beta. Gamma delta epsilon. Zeta.", language: "en" };
    const word = { id: "w-1", slug: "delta", title: "delta", lemma: "delta" };
    const l3 = {
      lockSourceByIdForUser: vi.fn().mockResolvedValue(source),
      findWordBySlug: vi.fn().mockResolvedValue(word),
      findContextByAnchor: vi.fn().mockResolvedValue(null),
      createContext: vi.fn().mockResolvedValue({ id: "ctx-new" }),
      createOccurrence: vi.fn().mockResolvedValue({ id: "occ-new" }),
    };
    mockRepos.l3Context = l3 as unknown as IL3ContextRepository;
    mockRepos.words = { insertMany: vi.fn(), findBySlug: vi.fn() } as unknown as IWordRepository;

    const svc = makeService();
    const res = await svc.createSelectionCapture({
      userId: "u1", sourceId: "s1", text: "Gamma delta epsilon.",
      anchorStart: 12, anchorEnd: 32, surface: "delta", wordSlug: "delta",
    });
    expect(l3.createContext).toHaveBeenCalledTimes(1);
    expect(res.contextId).toBe("ctx-new");
  });
});
