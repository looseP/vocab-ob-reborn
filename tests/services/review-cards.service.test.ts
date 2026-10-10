import { describe, it, expect, vi } from "vitest";
import { ReviewCardsService } from "@/services/review-cards.service";
import type { IRepositories } from "@/repositories/interfaces";

function makeService(overrides: {
  removeCardsByWordIds?: ReturnType<typeof vi.fn>;
  expireCardsByWordIds?: ReturnType<typeof vi.fn>;
  countQueueBuckets?: ReturnType<typeof vi.fn>;
  listQueueCards?: ReturnType<typeof vi.fn>;
} = {}) {
  const reviews = {
    removeCardsByWordIds: overrides.removeCardsByWordIds ?? vi.fn(async () => []),
    expireCardsByWordIds: overrides.expireCardsByWordIds ?? vi.fn(async () => []),
    countQueueBuckets:
      overrides.countQueueBuckets ??
      vi.fn(async () => ({ due: 0, learning: 0, review: 0, new: 0, suspended: 0, dueNow: 0, total: 0 })),
    listQueueCards: overrides.listQueueCards ?? vi.fn(async () => ({ items: [], total: 0 })),
  };
  const repoFactory = () => ({ reviews }) as unknown as IRepositories;
  // txRunner：直接执行回调（事务语义由真实实现保证，这里测服务层组装）
  const txRunner = (async (fn: (tx: unknown) => Promise<unknown>) => fn({})) as never;
  const service = new ReviewCardsService(txRunner, repoFactory);
  return { service, reviews };
}

describe("ReviewCardsService.removeCards（P1 移出队列）", () => {
  it("去重后转发 (user, wordbook, ids) 并以生效行构造结果", async () => {
    const { service, reviews } = makeService({
      removeCardsByWordIds: vi.fn(async () => ["w-1"]),
    });

    const result = await service.removeCards({
      userId: "u1",
      wordbookId: "wb-1",
      wordIds: ["w-1", "w-1", "w-2"],
    });

    expect(reviews.removeCardsByWordIds).toHaveBeenCalledWith({
      userId: "u1",
      wordbookId: "wb-1",
      wordIds: ["w-1", "w-2"],
    });
    expect(result).toEqual({ ok: true, count: 1, wordIds: ["w-1"] });
  });

  it("空 wordIds 拒绝（BusinessRuleError），不触仓库", async () => {
    const { service, reviews } = makeService();

    await expect(service.removeCards({ userId: "u1", wordbookId: "wb-1", wordIds: [] })).rejects.toMatchObject({
      code: "BUSINESS_RULE",
    });
    expect(reviews.removeCardsByWordIds).not.toHaveBeenCalled();
  });
});

describe("ReviewCardsService.expireCards（P1 提前到期）", () => {
  it("转发参数并返回实际变更的 id（未命中/无需变更不计）", async () => {
    const { service, reviews } = makeService({
      expireCardsByWordIds: vi.fn(async () => ["w-2"]),
    });

    const result = await service.expireCards({
      userId: "u1",
      wordbookId: "wb-1",
      wordIds: ["w-1", "w-2"],
    });

    expect(reviews.expireCardsByWordIds).toHaveBeenCalledWith({
      userId: "u1",
      wordbookId: "wb-1",
      wordIds: ["w-1", "w-2"],
    });
    expect(result).toEqual({ ok: true, count: 1, wordIds: ["w-2"] });
  });

  it("空 wordIds 拒绝（BusinessRuleError），不触仓库", async () => {
    const { service, reviews } = makeService();

    await expect(service.expireCards({ userId: "u1", wordbookId: "wb-1", wordIds: [] })).rejects.toMatchObject({
      code: "BUSINESS_RULE",
    });
    expect(reviews.expireCardsByWordIds).not.toHaveBeenCalled();
  });
});

describe("ReviewCardsService.listQueue（P1 队列全景）", () => {
  it("计数不受 bucket/搜索影响，hasMore 由 offset+本页 与 total 比较得出", async () => {
    const items = [makeQueueRow("w-1"), makeQueueRow("w-2")];
    const { service, reviews } = makeService({
      countQueueBuckets: vi.fn(async () => ({
        due: 12,
        learning: 3,
        review: 40,
        new: 100,
        suspended: 2,
        dueNow: 15,
        total: 157,
      })),
      listQueueCards: vi.fn(async () => ({ items, total: 157 })),
    });

    const result = await service.listQueue({
      userId: "u1",
      wordbookId: "wb-1",
      bucket: "due",
      search: "abandon",
      limit: 2,
      offset: 20,
    });

    // 计数驱动 tab 徽标 ⇒ 永远按全词书统计
    expect(result.counts.total).toBe(157);
    expect(result.items).toEqual(items);
    expect(result.hasMore).toBe(true);
    // 末页：offset + 本页条数 === total ⇒ 没有下一页
    expect(
      await service.listQueue({
        userId: "u1",
        wordbookId: "wb-1",
        bucket: "all",
        limit: 2,
        offset: 155,
      }),
    ).toMatchObject({ hasMore: false });
  });

  it("转义 ILIKE 通配符：搜 % 不会列出全部词", async () => {
    const { service, reviews } = makeService();
    await service.listQueue({
      userId: "u1",
      wordbookId: "wb-1",
      bucket: "all",
      search: "  50%_off  ",
      limit: 50,
      offset: 0,
    });

    expect(reviews.listQueueCards).toHaveBeenCalledWith(
      expect.objectContaining({ search: "50\\%\\_off" }),
    );
  });

  it("空白搜索视作无搜索（search=null）", async () => {
    const { service, reviews } = makeService();
    await service.listQueue({
      userId: "u1",
      wordbookId: "wb-1",
      bucket: "all",
      search: "   ",
      limit: 50,
      offset: 0,
    });

    expect(reviews.listQueueCards).toHaveBeenCalledWith(expect.objectContaining({ search: null }));
  });
});

/** 队列清单行夹具（字段与仓储 mapQueueCardRows 的输出一致）。 */
function makeQueueRow(wordId: string) {
  return {
    wordId,
    slug: wordId,
    title: wordId,
    lemma: wordId,
    shortDefinition: null,
    pos: null,
    cefr: null,
    state: "review" as const,
    dueAt: "2026-10-09T08:00:00.000Z",
    reviewCount: 2,
    lapseCount: 0,
    stability: 10,
    intervalDays: 8,
    lastReviewedAt: "2026-10-01T08:00:00.000Z",
    lastRating: "good" as const,
    needsRecheck: false,
  };
}
