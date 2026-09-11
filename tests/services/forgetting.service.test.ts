import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IRepositories, ForgettingPreviewRow } from "@/repositories/interfaces";
import { BusinessRuleError, NotFoundError, ValidationError } from "@/errors";

// Mock transaction + repository factory: the service never touches a real DB.
const mockRepos: Partial<IRepositories> = {};
vi.mock("@/db/transaction", () => ({
  withTransaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb({})),
}));
vi.mock("@/repositories/factory", () => ({
  createRepositories: vi.fn(() => mockRepos),
}));

import { ForgettingService } from "@/services/forgetting.service";

const USER = "user-1";
const WB = "wb-1";

/** 可保留（review）但不命中任何规则的填充行；用于把 20% 上限抬起来。 */
function previewRow(overrides: Partial<ForgettingPreviewRow> = {}): ForgettingPreviewRow {
  return {
    wordId: "word-plain",
    state: "review",
    stability: null,
    retrievability: null,
    recentRatings: [],
    lapseCount: 0,
    morphology: null,
    mnemonic: null,
    semanticChain: null,
    aliases: [],
    ...overrides,
  };
}

/** 两行 → 可保留 2 → 上限 ceil(2×20%)=1 → 仅稳定锚入选。 */
function defaultRows(): ForgettingPreviewRow[] {
  return [
    previewRow({ wordId: "word-stable", stability: 30 }),
    previewRow({ wordId: "word-plain" }),
  ];
}

function setup(options: { rows?: ForgettingPreviewRow[]; txRunner?: unknown } = {}) {
  const rows = options.rows ?? defaultRows();
  const reviews = {
    findForgettingPreviewRows: vi.fn(async (_userId: string, _wordbookId: string) => rows),
    countBulkSuspendCandidates: vi.fn(
      async (_input: { userId: string; wordbookId: string; keepWordIds: string[] }) => 2,
    ),
    bulkSuspendByWordbook: vi.fn(
      async (_input: { userId: string; wordbookId: string; keepWordIds: string[]; batchId: string }) => 1,
    ),
    findBulkForgetBatch: vi.fn(
      async (_input: { userId: string; wordbookId: string; batchId: string }) => true,
    ),
    restoreBulkForget: vi.fn(
      async (_input: { userId: string; wordbookId: string; batchId: string }) => 1,
    ),
  };
  const l2Progress = {
    batchPauseByWordbook: vi.fn(
      async (_input: { userId: string; wordbookId: string; keepWordIds: string[] }) => 1,
    ),
    batchUnpauseManual: vi.fn(async (_userId: string, _wordbookId: string) => 1),
  };
  mockRepos.reviews = reviews as never;
  mockRepos.l2Progress = l2Progress as never;

  const service = new ForgettingService({
    generateBatchId: () => "batch-fixed",
    ...(options.txRunner ? { txRunner: options.txRunner as never } : {}),
  });
  return { service, reviews, l2Progress };
}

beforeEach(() => {
  Object.keys(mockRepos).forEach((key) => delete (mockRepos as Record<string, unknown>)[key]);
});

describe("ForgettingService.preview", () => {
  it("returns deterministic anchors + suspendCount and performs zero writes", async () => {
    const { service, reviews, l2Progress } = setup();

    const result = await service.preview({ userId: USER, bookId: WB });

    expect(result.anchors).toEqual(["word-stable"]);
    expect(result.suspendCount).toBe(2);
    // 计数条件以当前锚点为 keepWordIds
    expect(reviews.countBulkSuspendCandidates).toHaveBeenCalledWith({
      userId: USER,
      wordbookId: WB,
      keepWordIds: ["word-stable"],
    });
    // 零写入：任何写方法都不得被调用
    expect(reviews.bulkSuspendByWordbook).not.toHaveBeenCalled();
    expect(reviews.restoreBulkForget).not.toHaveBeenCalled();
    expect(l2Progress.batchPauseByWordbook).not.toHaveBeenCalled();
    expect(l2Progress.batchUnpauseManual).not.toHaveBeenCalled();
  });

  it("空 userId / bookId 在触库前拒绝", async () => {
    const { service, reviews } = setup();
    await expect(service.preview({ userId: "", bookId: WB })).rejects.toThrow(ValidationError);
    await expect(service.preview({ userId: USER, bookId: " " })).rejects.toThrow(ValidationError);
    expect(reviews.findForgettingPreviewRows).not.toHaveBeenCalled();
  });
});

describe("ForgettingService.apply", () => {
  it("重算候选并挂起/暂停非锚点行，返回服务生成的 batchId", async () => {
    const { service, reviews, l2Progress } = setup();

    const result = await service.apply({
      userId: USER,
      bookId: WB,
      confirmedAnchorIds: ["word-stable"],
    });

    expect(result).toEqual({
      batchId: "batch-fixed",
      suspendedCount: 1,
      pausedCount: 1,
      anchors: ["word-stable"],
    });
    expect(reviews.bulkSuspendByWordbook).toHaveBeenCalledWith({
      userId: USER,
      wordbookId: WB,
      keepWordIds: ["word-stable"],
      batchId: "batch-fixed",
    });
    expect(l2Progress.batchPauseByWordbook).toHaveBeenCalledWith({
      userId: USER,
      wordbookId: WB,
      keepWordIds: ["word-stable"],
    });
  });

  it("confirmedAnchorIds 去重后作为 keepWordIds（不挂起锚点）", async () => {
    const { service, reviews } = setup();

    await service.apply({
      userId: USER,
      bookId: WB,
      confirmedAnchorIds: ["word-stable", "word-stable"],
    });

    const arg = reviews.bulkSuspendByWordbook.mock.calls[0]![0] as { keepWordIds: string[] };
    expect(arg.keepWordIds).toEqual(["word-stable"]);
  });

  it("确认空锚点集合法：挂起整本书的非 new/suspended 行", async () => {
    const { service, reviews, l2Progress } = setup();

    const result = await service.apply({ userId: USER, bookId: WB, confirmedAnchorIds: [] });

    expect(result.anchors).toEqual([]);
    expect(reviews.bulkSuspendByWordbook).toHaveBeenCalledWith({
      userId: USER,
      wordbookId: WB,
      keepWordIds: [],
      batchId: "batch-fixed",
    });
    expect(l2Progress.batchPauseByWordbook).toHaveBeenCalledWith({
      userId: USER,
      wordbookId: WB,
      keepWordIds: [],
    });
  });

  it("陈旧锚点清单被拒绝（ADR-0020 防误触），且零写入", async () => {
    const { service, reviews, l2Progress } = setup();

    await expect(
      service.apply({ userId: USER, bookId: WB, confirmedAnchorIds: ["word-stable", "ghost"] }),
    ).rejects.toThrow(BusinessRuleError);

    expect(reviews.bulkSuspendByWordbook).not.toHaveBeenCalled();
    expect(l2Progress.batchPauseByWordbook).not.toHaveBeenCalled();
  });

  it("原子性：L2 段失败时整个事务不提交，L1 挂起不落库", async () => {
    let committed = false;
    const txRunner = async (cb: (tx: unknown) => Promise<unknown>) => {
      const result = await cb({});
      committed = true; // 只有回调不抛异常才会走到这里（模拟 withTransaction 的 COMMIT）
      return result;
    };
    const { service, reviews, l2Progress } = setup({ txRunner });
    l2Progress.batchPauseByWordbook.mockRejectedValueOnce(new Error("l2 boom"));

    await expect(
      service.apply({ userId: USER, bookId: WB, confirmedAnchorIds: ["word-stable"] }),
    ).rejects.toThrow("l2 boom");

    // L1 段已在同一事务内被调用，但事务未提交 → 回滚
    expect(reviews.bulkSuspendByWordbook).toHaveBeenCalledTimes(1);
    expect(l2Progress.batchPauseByWordbook).toHaveBeenCalledTimes(1);
    expect(committed).toBe(false);
  });

  it("非法入参在触库前拒绝", async () => {
    const { service, reviews } = setup();
    await expect(
      service.apply({ userId: "", bookId: WB, confirmedAnchorIds: [] }),
    ).rejects.toThrow(ValidationError);
    await expect(
      service.apply({ userId: USER, bookId: WB, confirmedAnchorIds: undefined as never }),
    ).rejects.toThrow(ValidationError);
    await expect(
      service.apply({ userId: USER, bookId: WB, confirmedAnchorIds: [" "] }),
    ).rejects.toThrow(ValidationError);
    expect(reviews.bulkSuspendByWordbook).not.toHaveBeenCalled();
  });
});

describe("ForgettingService.restore", () => {
  it("前置校验通过后只按本批次回写并解除 manual 暂停", async () => {
    const { service, reviews, l2Progress } = setup();

    const result = await service.restore({ userId: USER, bookId: WB, batchId: "batch-1" });

    expect(result).toEqual({ restoredCount: 1, unpausedCount: 1 });
    expect(reviews.findBulkForgetBatch).toHaveBeenCalledWith({
      userId: USER,
      wordbookId: WB,
      batchId: "batch-1",
    });
    expect(reviews.restoreBulkForget).toHaveBeenCalledWith({
      userId: USER,
      wordbookId: WB,
      batchId: "batch-1",
    });
    expect(l2Progress.batchUnpauseManual).toHaveBeenCalledWith(USER, WB);
  });

  it("批次不存在 → NotFoundError，且不执行任何回写", async () => {
    const { service, reviews, l2Progress } = setup();
    reviews.findBulkForgetBatch.mockResolvedValueOnce(false);

    await expect(
      service.restore({ userId: USER, bookId: WB, batchId: "missing" }),
    ).rejects.toThrow(NotFoundError);

    expect(reviews.restoreBulkForget).not.toHaveBeenCalled();
    expect(l2Progress.batchUnpauseManual).not.toHaveBeenCalled();
  });

  it("重复 restore 行为明确：幂等重放（两次都成功、都回写同一批）", async () => {
    const { service, reviews } = setup();

    const first = await service.restore({ userId: USER, bookId: WB, batchId: "batch-1" });
    const second = await service.restore({ userId: USER, bookId: WB, batchId: "batch-1" });

    expect(first).toEqual(second);
    expect(reviews.findBulkForgetBatch).toHaveBeenCalledTimes(2);
    expect(reviews.restoreBulkForget).toHaveBeenCalledTimes(2);
  });

  it("空 batchId 在触库前拒绝", async () => {
    const { service, reviews } = setup();
    await expect(service.restore({ userId: USER, bookId: WB, batchId: "" })).rejects.toThrow(
      ValidationError,
    );
    expect(reviews.findBulkForgetBatch).not.toHaveBeenCalled();
  });
});

describe("ForgettingService 作用域与事务", () => {
  it("跨书隔离：apply 的每次仓库调用都钉死同一 wordbookId（书 B 不被触碰）", async () => {
    const { service, reviews, l2Progress } = setup();

    await service.apply({ userId: USER, bookId: "wb-A", confirmedAnchorIds: [] });

    expect(reviews.findForgettingPreviewRows).toHaveBeenCalledWith(USER, "wb-A");
    expect(reviews.bulkSuspendByWordbook).toHaveBeenCalledTimes(1);
    expect((reviews.bulkSuspendByWordbook.mock.calls[0]![0] as { wordbookId: string }).wordbookId).toBe(
      "wb-A",
    );
    expect(l2Progress.batchPauseByWordbook).toHaveBeenCalledTimes(1);
    expect(
      (l2Progress.batchPauseByWordbook.mock.calls[0]![0] as { wordbookId: string }).wordbookId,
    ).toBe("wb-A");
    // 从未以别的书调用
    const calledBooks = [
      ...reviews.bulkSuspendByWordbook.mock.calls,
      ...l2Progress.batchPauseByWordbook.mock.calls,
    ].map((call) => (call[0] as { wordbookId: string }).wordbookId);
    expect(calledBooks.every((book) => book === "wb-A")).toBe(true);
  });

  it("每个方法都在注入的 actor 事务内执行（actorId=userId）", async () => {
    const seen: unknown[] = [];
    const txRunner = async (cb: (tx: unknown) => Promise<unknown>, options: unknown) => {
      seen.push(options);
      return cb({});
    };
    const { service } = setup({ txRunner });

    await service.preview({ userId: USER, bookId: WB });
    await service.apply({ userId: USER, bookId: WB, confirmedAnchorIds: [] });
    await service.restore({ userId: USER, bookId: WB, batchId: "batch-1" });

    expect(seen).toEqual([{ actorId: USER }, { actorId: USER }, { actorId: USER }]);
  });
});
