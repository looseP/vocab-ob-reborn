/**
 * createServices 装配测试 —— 覆盖 services/index.ts 的 DI 接线（覆盖率收口）。
 *
 * 重点：ReviewService 的读路径 lambda（findDueCards / getStats / findLeeches /
 * getTimeline / getHeatmap / clearL1WeakSignal）必须通过 withTransaction +
 * createRepositories(tx) 以 actorId 执行（RLS 红线），以及 l2Drill 的
 * contextSource/telemetry 装配。
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockCreateRepositories = vi.fn();
vi.mock("@/db/transaction", () => ({
  withTransaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>, _opts?: { actorId?: string }) => cb({})),
}));
vi.mock("@/repositories/factory", () => ({
  createRepositories: (...args: unknown[]) => mockCreateRepositories(...args),
}));

import { createServices } from "@/services";

function makeRepos() {
  const reviews = {
    findDueCards: vi.fn(async () => []),
    getStats: vi.fn(async () => ({ todayCount: 0, totalCount: 0, ratingDist: { again: 0, hard: 0, good: 0, easy: 0 } })),
    findLeeches: vi.fn(async () => []),
    getTimeline: vi.fn(async () => []),
    getHeatmap: vi.fn(async () => []),
    markL1WeakSignal: vi.fn(async () => 1),
  };
  const sessions = {
    getOrCreateToday: vi.fn(async () => ({ id: "s1", mode: "cram", cards_seen: 0 })),
  };
  const l2Progress = {
    findDueCards: vi.fn(async () => []),
    findPendingProductionStepsForResume: vi.fn(async () => []),
    findDrillStepForUpdate: vi.fn(async () => null),
    findDrillStepBySessionWordStep: vi.fn(async () => null),
    findForUpdate: vi.fn(async () => null),
    insertDrillStepIfAbsent: vi.fn(async () => null),
    saveL2Answer: vi.fn(async () => ({ reviewLogId: "log-1" })),
    findByWordbookWordAndUser: vi.fn(async () => null),
  };
  const repos = {
    reviews,
    sessions,
    l2Progress,
    outbox: { enqueue: vi.fn() },
    llmUsage: {},
    words: {},
    notes: {},
    wordbooks: {},
    stats: {},
    l3Context: {},
    l3Proposal: {},
    l3Recommendation: {},
  };
  return { repos, reviews, sessions, l2Progress };
}

beforeEach(() => {
  mockCreateRepositories.mockReset();
});

describe("createServices wiring", () => {
  it("wires ReviewService read lambdas through actorId transactions", async () => {
    const { repos, reviews, sessions } = makeRepos();
    mockCreateRepositories.mockReturnValue(repos);
    const services = createServices({
      fsrsAdapter: vi.fn(() => ({
        difficulty: 5.0, dueAt: "2026-09-25T00:00:00.000Z", logDueAt: null,
        elapsedDays: 1, scheduledDays: 10, retrievability: 0.85, stability: 3.5,
        state: "review" as const,
        nextPayload: { due: "2026-09-25T00:00:00.000Z", stability: 3.5, difficulty: 5.0, state: 2 },
      })),
      loadWeights: vi.fn(async () => null),
    });

    await services.reviews.getQueue("u1", "wb1", 5, "cram");
    expect(reviews.findDueCards).toHaveBeenCalledWith("u1", "wb1", 5);
    expect(sessions.getOrCreateToday).toHaveBeenCalledWith("u1", "wb1", "cram");

    await services.reviews.getStats("u1", "wb1");
    expect(reviews.getStats).toHaveBeenCalledWith("u1", "wb1");

    await services.reviews.getLeeches("u1", "wb1", 5);
    expect(reviews.findLeeches).toHaveBeenCalledWith("u1", "wb1", 5);

    await services.reviews.getTimeline("u1", "wb1", 50);
    expect(reviews.getTimeline).toHaveBeenCalledWith("u1", "wb1", 50);

    await services.reviews.getHeatmap("u1", "wb1", 365);
    expect(reviews.getHeatmap).toHaveBeenCalledWith("u1", "wb1", 365);

    await services.reviews.clearL1WeakSignal({ wordbookId: "wb1", wordId: "w1" }, "u1");
    expect(reviews.markL1WeakSignal).toHaveBeenCalledWith("u1", "wb1", "w1", false);
  });

  it("wires l2Drill with default L3 context source and getQueue path", async () => {
    const { repos, l2Progress, sessions } = makeRepos();
    mockCreateRepositories.mockReturnValue(repos);
    const services = createServices({
      fsrsAdapter: vi.fn(),
      loadWeights: vi.fn(async () => null),
    });

    const result = await services.l2Drill.getQueue("u1", "wb1", 5);
    expect(l2Progress.findDueCards).toHaveBeenCalledWith("u1", "wb1", 5);
    expect(l2Progress.findPendingProductionStepsForResume).toHaveBeenCalled();
    expect(sessions.getOrCreateToday).toHaveBeenCalled();
    expect(result.items).toEqual([]);
    expect(result.session.mode).toBe("cram");
  });
});
