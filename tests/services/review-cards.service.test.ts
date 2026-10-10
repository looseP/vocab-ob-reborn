import { describe, it, expect, vi } from "vitest";
import { ReviewCardsService } from "@/services/review-cards.service";
import type { IRepositories } from "@/repositories/interfaces";

function makeService(overrides: {
  removeCardsByWordIds?: ReturnType<typeof vi.fn>;
  expireCardsByWordIds?: ReturnType<typeof vi.fn>;
} = {}) {
  const reviews = {
    removeCardsByWordIds: overrides.removeCardsByWordIds ?? vi.fn(async () => []),
    expireCardsByWordIds: overrides.expireCardsByWordIds ?? vi.fn(async () => []),
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
