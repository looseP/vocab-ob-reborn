import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IOutboxRepository, IRepositories, OutboxEventRow } from "@/repositories/interfaces";
import { ReviewOutboxWorker } from "@/outbox/review-outbox.worker";

const mockRepos: Partial<IRepositories> = {};

vi.mock("@/db/transaction", () => ({
  withTransaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback({})),
}));
vi.mock("@/repositories/factory", () => ({
  createRepositories: vi.fn(() => mockRepos),
}));

function event(overrides: Partial<OutboxEventRow> = {}): OutboxEventRow {
  return {
    id: "00000000-0000-4000-8000-000000000101",
    aggregate_type: "review_log",
    aggregate_id: "00000000-0000-4000-8000-000000000102",
    event_type: "review.answer.recorded.v1",
    payload: {
      version: 1,
      reviewLogId: "00000000-0000-4000-8000-000000000102",
      progressId: "00000000-0000-4000-8000-000000000107",
      sessionId: "00000000-0000-4000-8000-000000000103",
      userId: "00000000-0000-4000-8000-000000000104",
      wordbookId: "00000000-0000-4000-8000-000000000105",
      wordId: "00000000-0000-4000-8000-000000000106",
    },
    dedupe_key: "review.answer.recorded.v1:00000000-0000-4000-8000-000000000102",
    status: "processing",
    attempts: 1,
    max_attempts: 8,
    available_at: "2026-07-10T00:00:00Z",
    locked_at: "2026-07-10T00:00:00Z",
    locked_until: "2026-07-10T00:01:00Z",
    locked_by: "worker-1",
    last_error: null,
    processed_at: null,
    created_at: "2026-07-10T00:00:00Z",
    updated_at: "2026-07-10T00:00:00Z",
    ...overrides,
  };
}

function makeOutbox(overrides: Partial<IOutboxRepository> = {}): IOutboxRepository {
  const claimBatch = vi.fn<() => Promise<OutboxEventRow[]>>()
    .mockResolvedValueOnce([event()])
    .mockResolvedValue([]);
  return {
    enqueue: vi.fn(async () => ({ id: "event-1", inserted: true })),
    recoverExpiredLeases: vi.fn(async () => 0),
    claimBatch,
    beginEffect: vi.fn(async () => true),
    completeEffect: vi.fn(async () => undefined),
    markProcessed: vi.fn(async () => undefined),
    markFailed: vi.fn(async () => "retry" as const),
    replayDeadLetter: vi.fn(async () => false),
    getMetrics: vi.fn(async () => ({ pending: 0, processing: 0, deadLetter: 0, oldestPendingAgeSeconds: null })),
    ...overrides,
  };
}

beforeEach(() => {
  Object.keys(mockRepos).forEach((key) => delete (mockRepos as Record<string, unknown>)[key]);
  mockRepos.outbox = makeOutbox();
  mockRepos.l2Progress = {
    findByWordbookWordAndUser: vi.fn(async () => null),
    insert: vi.fn(async () => ({}) as never),
    finalizeL2ContentHash: vi.fn(async () => 0),
    pause: vi.fn(async () => undefined),
    unpauseByReason: vi.fn(async () => undefined),
  };
  mockRepos.reviews = {
    findProgressForOutbox: vi.fn(async () => ({
      id: "00000000-0000-4000-8000-000000000107",
      user_id: "00000000-0000-4000-8000-000000000104",
      wordbook_id: "00000000-0000-4000-8000-000000000105",
      word_id: "00000000-0000-4000-8000-000000000106",
      stability: 2,
      difficulty: 0.4,
      review_count: 4,
      last_rating: "good",
      recent_ratings: ["good", "good"],
    })),
    markL1WeakSignal: vi.fn(async () => 0),
  } as never;
  mockRepos.sessions = { incrementCardsSeenFromOutbox: vi.fn(async () => undefined) } as never;
});

describe("ReviewOutboxWorker", () => {
  it("processes every effect and marks the event processed", async () => {
    const outbox = makeOutbox();
    mockRepos.outbox = outbox;
    const worker = new ReviewOutboxWorker(outbox, { workerId: "worker-1" });

    expect(await worker.processBatch()).toBe(1);
    expect(outbox.beginEffect).toHaveBeenCalledTimes(3);
    expect(outbox.completeEffect).toHaveBeenCalledTimes(3);
    expect(mockRepos.sessions?.incrementCardsSeenFromOutbox).toHaveBeenCalledTimes(1);
    expect(outbox.markProcessed).toHaveBeenCalledWith(event().id, "worker-1");
    expect(outbox.markFailed).not.toHaveBeenCalled();
  });

  it("stops claiming new events when shutdown is requested during a batch", async () => {
    let continueProcessing = true;
    const claimBatch = vi.fn<() => Promise<OutboxEventRow[]>>()
      .mockResolvedValueOnce([event()])
      .mockResolvedValueOnce([event({ id: "00000000-0000-4000-8000-000000000108" })])
      .mockResolvedValue([]);
    const outbox = makeOutbox({ claimBatch });
    mockRepos.outbox = outbox;
    mockRepos.sessions = {
      incrementCardsSeenFromOutbox: vi.fn(async () => { continueProcessing = false; }),
    } as never;
    const worker = new ReviewOutboxWorker(outbox, { workerId: "worker-1", batchSize: 20 });

    expect(await worker.processBatch(() => continueProcessing)).toBe(1);
    expect(claimBatch).toHaveBeenCalledTimes(1);
  });

  it("does not recover or claim work when already stopping", async () => {
    const outbox = makeOutbox();
    const worker = new ReviewOutboxWorker(outbox, { workerId: "worker-1" });

    expect(await worker.processBatch(() => false)).toBe(0);
    expect(outbox.recoverExpiredLeases).not.toHaveBeenCalled();
    expect(outbox.claimBatch).not.toHaveBeenCalled();
  });

  it("uses current authoritative progress instead of stale event snapshots", async () => {
    const outbox = makeOutbox();
    mockRepos.outbox = outbox;
    const worker = new ReviewOutboxWorker(outbox, { workerId: "worker-1" });

    await worker.processBatch();
    expect(mockRepos.reviews?.findProgressForOutbox).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000107",
      "00000000-0000-4000-8000-000000000104",
      "00000000-0000-4000-8000-000000000105",
    );
    expect(mockRepos.l2Progress?.findByWordbookWordAndUser).not.toHaveBeenCalled();
  });

  it("skips an effect that already has a durable receipt", async () => {
    const outbox = makeOutbox({
      beginEffect: vi.fn(async (_eventId, effectName) => effectName !== "session_cards_seen"),
    });
    mockRepos.outbox = outbox;
    const worker = new ReviewOutboxWorker(outbox, { workerId: "worker-1" });

    await worker.processBatch();
    expect(mockRepos.sessions?.incrementCardsSeenFromOutbox).not.toHaveBeenCalled();
    expect(outbox.completeEffect).toHaveBeenCalledTimes(2);
    expect(outbox.markProcessed).toHaveBeenCalledTimes(1);
  });

  it("schedules retry and does not acknowledge when an effect fails", async () => {
    mockRepos.sessions = { incrementCardsSeenFromOutbox: vi.fn(async () => { throw new Error("db down"); }) } as never;
    const outbox = makeOutbox();
    mockRepos.outbox = outbox;
    const worker = new ReviewOutboxWorker(outbox, { workerId: "worker-1" });

    await worker.processBatch();
    expect(outbox.markProcessed).not.toHaveBeenCalled();
    expect(outbox.markFailed).toHaveBeenCalledWith(event().id, "worker-1", "db down", 1);
  });

  it("dead-letters unsupported or invalid event payloads through the repository policy", async () => {
    const claimBatch = vi.fn<() => Promise<OutboxEventRow[]>>()
      .mockResolvedValueOnce([event({ event_type: "unknown.v1", attempts: 8 })])
      .mockResolvedValue([]);
    const outbox = makeOutbox({
      claimBatch,
      markFailed: vi.fn(async () => "dead_letter" as const),
    });
    mockRepos.outbox = outbox;
    const worker = new ReviewOutboxWorker(outbox, { workerId: "worker-1" });

    await worker.processBatch();
    expect(outbox.markFailed).toHaveBeenCalledWith(
      event().id,
      "worker-1",
      "Unsupported outbox event type: unknown.v1",
      128,
    );
  });
});
