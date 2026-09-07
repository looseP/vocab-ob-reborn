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
});
