import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  IOutboxRepository,
  IRepositories,
  IReviewRepository,
  InsertNewCardStatus,
} from "@/repositories/interfaces";
import { ReviewService, L1_DEFAULT_DESIRED_RETENTION, type FsrsAdapterFn } from "@/services/review.service";
import { BusinessRuleError, ConflictError, NotFoundError } from "@/errors";

// ── Mock infrastructure (same pattern as review-service.test.ts) ─────────
const mockRepos: Partial<IRepositories> = {};

const { withTransactionMock } = vi.hoisted(() => ({
  withTransactionMock: vi.fn(async (
    cb: (tx: unknown) => Promise<unknown>,
    _options?: { actorId?: string },
  ) => cb({})),
}));

vi.mock("@/db/transaction", () => ({
  withTransaction: withTransactionMock,
}));
vi.mock("@/repositories/factory", () => ({
  createRepositories: vi.fn(() => mockRepos),
}));

function makeAdapter(): FsrsAdapterFn {
  return (() => {
    throw new Error("enqueue path must not invoke the FSRS adapter");
  }) as unknown as FsrsAdapterFn;
}

function inserted(id: string): InsertNewCardStatus {
  return { status: "inserted", progressId: id };
}

function makeRepos(insertNewCard: IReviewRepository["insertNewCard"]): {
  reviews: IReviewRepository;
  outbox: IOutboxRepository & { enqueue: ReturnType<typeof vi.fn> };
} {
  const outbox = {
    enqueue: vi.fn(async () => ({ id: "evt-1" })),
  } as unknown as IOutboxRepository & { enqueue: ReturnType<typeof vi.fn> };
  const reviews = { insertNewCard } as unknown as IReviewRepository;
  return { reviews, outbox };
}

// ── Single-card enqueue ──────────────────────────────────────────────────
describe("ReviewService.enqueueCard", () => {
  beforeEach(() => {
    withTransactionMock.mockClear();
  });

  it("creates the card, records one outbox event, and returns the progress id", async () => {
    const insertNewCard = vi.fn(async () => inserted("p-new-1"));
    const { reviews, outbox } = makeRepos(insertNewCard);
    mockRepos.reviews = reviews;
    mockRepos.outbox = outbox;

    const service = new ReviewService({ fsrsAdapter: makeAdapter(), loadWeights: async () => null });
    const result = await service.enqueueCard({ wordId: "w1", wordbookId: "wb1" }, "u1");

    expect(result).toEqual({ ok: true, progressId: "p-new-1" });
    expect(insertNewCard).toHaveBeenCalledWith({
      userId: "u1",
      wordId: "w1",
      wordbookId: "wb1",
      desiredRetention: L1_DEFAULT_DESIRED_RETENTION,
    });
    expect(L1_DEFAULT_DESIRED_RETENTION).toBe("0.850");
    expect(outbox.enqueue).toHaveBeenCalledTimes(1);
    expect(outbox.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      aggregateType: "user_word_progress",
      aggregateId: "p-new-1",
      eventType: "review.card.enqueued.v1",
      dedupeKey: "review.card.enqueued.v1:p-new-1",
      payload: expect.objectContaining({
        version: 1,
        progressId: "p-new-1",
        userId: "u1",
        wordbookId: "wb1",
        wordId: "w1",
      }),
    }));
    expect(withTransactionMock).toHaveBeenCalledWith(expect.any(Function), { actorId: "u1" });
  });

  it("rejects a duplicate with ConflictError and records no outbox event", async () => {
    const insertNewCard = vi.fn(async (): Promise<InsertNewCardStatus> => ({ status: "duplicate", progressId: null }));
    const { reviews, outbox } = makeRepos(insertNewCard);
    mockRepos.reviews = reviews;
    mockRepos.outbox = outbox;

    const service = new ReviewService({ fsrsAdapter: makeAdapter(), loadWeights: async () => null });
    await expect(
      service.enqueueCard({ wordId: "w1", wordbookId: "wb1" }, "u1"),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(outbox.enqueue).not.toHaveBeenCalled();
  });

  it("maps an unknown word to NotFoundError", async () => {
    const insertNewCard = vi.fn(async (): Promise<InsertNewCardStatus> => ({ status: "word_not_found", progressId: null }));
    const { reviews, outbox } = makeRepos(insertNewCard);
    mockRepos.reviews = reviews;
    mockRepos.outbox = outbox;

    const service = new ReviewService({ fsrsAdapter: makeAdapter(), loadWeights: async () => null });
    await expect(
      service.enqueueCard({ wordId: "missing", wordbookId: "wb1" }, "u1"),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(outbox.enqueue).not.toHaveBeenCalled();
  });

  it("maps an unowned wordbook to NotFoundError on the wordbook resource", async () => {
    const insertNewCard = vi.fn(async (): Promise<InsertNewCardStatus> => ({ status: "wordbook_invalid", progressId: null }));
    const { reviews, outbox } = makeRepos(insertNewCard);
    mockRepos.reviews = reviews;
    mockRepos.outbox = outbox;

    const service = new ReviewService({ fsrsAdapter: makeAdapter(), loadWeights: async () => null });
    await expect(
      service.enqueueCard({ wordId: "w1", wordbookId: "foreign-wb" }, "u1"),
    ).rejects.toMatchObject({ resourceType: "Wordbook" });
    expect(outbox.enqueue).not.toHaveBeenCalled();
  });
});

// ── Batch enqueue ────────────────────────────────────────────────────────
describe("ReviewService.enqueueCards", () => {
  beforeEach(() => {
    withTransactionMock.mockClear();
  });

  it("counts duplicates as skipped and emits events only for inserted cards", async () => {
    let call = 0;
    const statuses: InsertNewCardStatus[] = [
      inserted("p-1"),
      { status: "duplicate", progressId: null },
      inserted("p-2"),
    ];
    const insertNewCard = vi.fn(async (): Promise<InsertNewCardStatus> => statuses[call++]!);
    const { reviews, outbox } = makeRepos(insertNewCard);
    mockRepos.reviews = reviews;
    mockRepos.outbox = outbox;

    const service = new ReviewService({ fsrsAdapter: makeAdapter(), loadWeights: async () => null });
    const result = await service.enqueueCards(
      { wordIds: ["w1", "w-dup", "w3"], wordbookId: "wb1" },
      "u1",
    );

    expect(result).toEqual({ ok: true, added: 2, skipped: 1, progressIds: ["p-1", "p-2"] });
    expect(outbox.enqueue).toHaveBeenCalledTimes(2);
    expect(outbox.enqueue.mock.calls[0]![0]).toMatchObject({ aggregateId: "p-1" });
    expect(outbox.enqueue.mock.calls[1]![0]).toMatchObject({ aggregateId: "p-2" });
  });

  it("rejects empty input with BusinessRuleError without opening a transaction", async () => {
    const service = new ReviewService({ fsrsAdapter: makeAdapter(), loadWeights: async () => null });
    await expect(
      service.enqueueCards({ wordIds: [], wordbookId: "wb1" }, "u1"),
    ).rejects.toBeInstanceOf(BusinessRuleError);
    expect(withTransactionMock).not.toHaveBeenCalled();
  });

  it("aborts the whole batch when any word is missing", async () => {
    let call = 0;
    const statuses: InsertNewCardStatus[] = [inserted("p-1"), { status: "word_not_found", progressId: null }];
    const insertNewCard = vi.fn(async (): Promise<InsertNewCardStatus> => statuses[call++]!);
    const { reviews, outbox } = makeRepos(insertNewCard);
    mockRepos.reviews = reviews;
    mockRepos.outbox = outbox;

    const service = new ReviewService({ fsrsAdapter: makeAdapter(), loadWeights: async () => null });
    await expect(
      service.enqueueCards({ wordIds: ["w-ok", "w-missing"], wordbookId: "wb1" }, "u1"),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("aborts the batch when the wordbook is not owned by the user", async () => {
    const insertNewCard = vi.fn(async (): Promise<InsertNewCardStatus> => ({ status: "wordbook_invalid", progressId: null }));
    const { reviews, outbox } = makeRepos(insertNewCard);
    mockRepos.reviews = reviews;
    mockRepos.outbox = outbox;

    const service = new ReviewService({ fsrsAdapter: makeAdapter(), loadWeights: async () => null });
    await expect(
      service.enqueueCards({ wordIds: ["w1"], wordbookId: "foreign-wb" }, "u1"),
    ).rejects.toMatchObject({ resourceType: "Wordbook" });
  });
});
