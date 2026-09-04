import { afterAll, afterEach, describe, it, expect, vi } from "vitest";

vi.mock("@/db/transaction", () => ({
  withTransaction: vi.fn(async (cb: any) => cb({})),
}));

import { L2TransitionService } from "@/services/l2-transition.service";

function makeProgress(overrides: Partial<any> = {}) {
  return {
    user_id: "user-1",
    wordbook_id: "wb-1",
    word_id: "word-1",
    stability: 25,
    difficulty: 5.0,
    review_count: 6,
    last_rating: "good",
    ...overrides,
  };
}

describe("L2TransitionService.checkAndTransition", () => {
  it("transitions when L1_S >= 21 and review_count >= 5 and last_rating is good", async () => {
    const mockL2Repo = {
      findByWordbookWordAndUser: vi.fn().mockResolvedValue(null),
      insert: vi.fn().mockResolvedValue({ id: "l2-1" }),
    };
    const service = new L2TransitionService(mockL2Repo as any);
    await service.checkAndTransition(makeProgress());
    expect(mockL2Repo.insert).toHaveBeenCalled();
    // payload 断路修复（l2-drill spec §四）：继承行必须带初始 StoredSchedulerCard
    const inserted = mockL2Repo.insert.mock.calls[0]![0] as { l2_scheduler_payload?: Record<string, unknown> };
    const payload = inserted.l2_scheduler_payload as Record<string, unknown>;
    expect(payload).toBeDefined();
    expect(payload.state).toBe(2); // ts-fsrs State.Review —— 绝不能是 New(0)
    expect(Number(payload.stability)).toBeGreaterThan(0);
    expect(() => new Date(String(payload.due))).not.toThrow();
    expect(new Date(String(payload.due)).getTime()).not.toBeNaN();
  });

  it("does NOT transition when stability < 21", async () => {
    const mockL2Repo = { findByWordbookWordAndUser: vi.fn(), insert: vi.fn() };
    const service = new L2TransitionService(mockL2Repo as any);
    await service.checkAndTransition(makeProgress({ stability: 20 }));
    expect(mockL2Repo.insert).not.toHaveBeenCalled();
  });

  it("does NOT transition when review_count < 5", async () => {
    const mockL2Repo = { findByWordbookWordAndUser: vi.fn(), insert: vi.fn() };
    const service = new L2TransitionService(mockL2Repo as any);
    await service.checkAndTransition(makeProgress({ review_count: 4 }));
    expect(mockL2Repo.insert).not.toHaveBeenCalled();
  });

  it("does NOT transition when last_rating is 'again'", async () => {
    const mockL2Repo = { findByWordbookWordAndUser: vi.fn(), insert: vi.fn() };
    const service = new L2TransitionService(mockL2Repo as any);
    await service.checkAndTransition(makeProgress({ last_rating: "again" }));
    expect(mockL2Repo.insert).not.toHaveBeenCalled();
  });

  it("transitions when last_rating is 'easy'", async () => {
    const mockL2Repo = {
      findByWordbookWordAndUser: vi.fn().mockResolvedValue(null),
      insert: vi.fn().mockResolvedValue({ id: "l2-1" }),
    };
    const service = new L2TransitionService(mockL2Repo as any);
    await service.checkAndTransition(makeProgress({ last_rating: "easy" }));
    expect(mockL2Repo.insert).toHaveBeenCalled();
  });

  it("is idempotent (skips if L2 progress exists for same user+wordbook+word)", async () => {
    const mockL2Repo = {
      findByWordbookWordAndUser: vi.fn().mockResolvedValue({ id: "existing-l2" }),
      insert: vi.fn(),
    };
    const service = new L2TransitionService(mockL2Repo as any);
    await service.checkAndTransition(makeProgress());
    expect(mockL2Repo.insert).not.toHaveBeenCalled();
  });

  it("catches 23505 unique violation without throwing", async () => {
    const mockL2Repo = {
      findByWordbookWordAndUser: vi.fn().mockResolvedValue(null),
      insert: vi.fn().mockRejectedValue(Object.assign(new Error("dup"), { code: "23505" })),
    };
    const service = new L2TransitionService(mockL2Repo as any);
    // Should not throw
    await expect(service.checkAndTransition(makeProgress())).resolves.toBeUndefined();
  });

  it("re-throws non-23505 errors", async () => {
    const mockL2Repo = {
      findByWordbookWordAndUser: vi.fn().mockResolvedValue(null),
      insert: vi.fn().mockRejectedValue(Object.assign(new Error("schema error"), { code: "42P01" })),
    };
    const service = new L2TransitionService(mockL2Repo as any);
    await expect(service.checkAndTransition(makeProgress())).rejects.toThrow("schema error");
  });

  it("L2_S has absolute floor of 1.0", async () => {
    const mockL2Repo = {
      findByWordbookWordAndUser: vi.fn().mockResolvedValue(null),
      insert: vi.fn().mockResolvedValue({ id: "l2-1" }),
    };
    const service = new L2TransitionService(mockL2Repo as any);
    // L1_S = 21 → ratio = 0.5 * 21/42 = 0.25 → L2_S = max(5.25, 1.0) = 5.25
    await service.checkAndTransition(makeProgress({ stability: 21 }));
    const insertArg = mockL2Repo.insert.mock.calls[0][0];
    expect(insertArg.l2_stability).toBeGreaterThanOrEqual(1.0);
    expect(insertArg.l2_stability).toBeCloseTo(5.25, 1);
  });

  it("L2_desired_retention is 0.9", async () => {
    const mockL2Repo = {
      findByWordbookWordAndUser: vi.fn().mockResolvedValue(null),
      insert: vi.fn().mockResolvedValue({ id: "l2-1" }),
    };
    const service = new L2TransitionService(mockL2Repo as any);
    await service.checkAndTransition(makeProgress());
    const insertArg = mockL2Repo.insert.mock.calls[0][0];
    expect(insertArg.l2_desired_retention).toBe(0.9);
  });

  it("L2_state is 'review'", async () => {
    const mockL2Repo = {
      findByWordbookWordAndUser: vi.fn().mockResolvedValue(null),
      insert: vi.fn().mockResolvedValue({ id: "l2-1" }),
    };
    const service = new L2TransitionService(mockL2Repo as any);
    await service.checkAndTransition(makeProgress());
    const insertArg = mockL2Repo.insert.mock.calls[0][0];
    expect(insertArg.l2_state).toBe("review");
  });

  // ── Wordbook scoping (V2 fix) ──────────────────────────────────────────

  it("insert writes wordbook_id from the L1 snapshot", async () => {
    const mockL2Repo = {
      findByWordbookWordAndUser: vi.fn().mockResolvedValue(null),
      insert: vi.fn().mockResolvedValue({ id: "l2-1" }),
    };
    const service = new L2TransitionService(mockL2Repo as any);
    await service.checkAndTransition(makeProgress({ wordbook_id: "wb-99" }));
    const insertArg = mockL2Repo.insert.mock.calls[0][0];
    expect(insertArg.wordbook_id).toBe("wb-99");
    expect(insertArg.word_id).toBe("word-1");
    expect(insertArg.user_id).toBe("user-1");
  });

  it("idempotency check is scoped by (user, wordbook, word)", async () => {
    // The findBy call must carry all three identifiers, not just user+word.
    const mockL2Repo = {
      findByWordbookWordAndUser: vi.fn().mockResolvedValue(null),
      insert: vi.fn().mockResolvedValue({ id: "l2-1" }),
    };
    const service = new L2TransitionService(mockL2Repo as any);
    await service.checkAndTransition(
      makeProgress({ user_id: "uA", wordbook_id: "wbA", word_id: "wA" }),
    );
    expect(mockL2Repo.findByWordbookWordAndUser).toHaveBeenCalledWith("uA", "wbA", "wA");
  });

  it("does NOT skip transition when another wordbook already has L2 progress for same user+word", async () => {
    // Same user+word in wb-A already has L2 progress, but a transition for
    // wb-B (different wordbook) must still proceed — each wordbook is
    // independent. The repo returns null for the (wb-B) lookup.
    const mockL2Repo = {
      findByWordbookWordAndUser: vi.fn().mockResolvedValue(null),
      insert: vi.fn().mockResolvedValue({ id: "l2-2" }),
    };
    const service = new L2TransitionService(mockL2Repo as any);
    await service.checkAndTransition(
      makeProgress({ user_id: "user-1", wordbook_id: "wb-B", word_id: "word-1" }),
    );
    expect(mockL2Repo.findByWordbookWordAndUser).toHaveBeenCalledWith("user-1", "wb-B", "word-1");
    expect(mockL2Repo.insert).toHaveBeenCalledTimes(1);
    expect(mockL2Repo.insert.mock.calls[0][0].wordbook_id).toBe("wb-B");
  });

  it("same user + same word + different wordbooks can produce two independent L2 progress rows", async () => {
    // First transition (wb-A) succeeds; second transition (wb-B) for the
    // same user+word but a different wordbook must ALSO succeed because L2
    // progress is wordbook-scoped.
    const findBy = vi.fn().mockResolvedValue(null);
    const insert = vi.fn()
      .mockResolvedValueOnce({ id: "l2-wbA" })
      .mockResolvedValueOnce({ id: "l2-wbB" });
    const mockL2Repo = { findByWordbookWordAndUser: findBy, insert };
    const service = new L2TransitionService(mockL2Repo as any);

    await service.checkAndTransition(
      makeProgress({ wordbook_id: "wb-A", word_id: "word-1" }),
    );
    await service.checkAndTransition(
      makeProgress({ wordbook_id: "wb-B", word_id: "word-1" }),
    );

    expect(insert).toHaveBeenCalledTimes(2);
    expect(insert.mock.calls[0][0].wordbook_id).toBe("wb-A");
    expect(insert.mock.calls[1][0].wordbook_id).toBe("wb-B");
    // Both rows are for the same user+word but different wordbooks.
    expect(findBy).toHaveBeenCalledWith("user-1", "wb-A", "word-1");
    expect(findBy).toHaveBeenCalledWith("user-1", "wb-B", "word-1");
  });
});

// ── P2-6: L2_DESIRED_RETENTION env-var tuning ─────────────────────────────
// 模块级常量在 import 时一次性求值，须 vi.resetModules + dynamic import
// 才能让 process.env 改动生效。验证调优旋钮：合法值生效，越界回退默认。
describe("L2TransitionService L2_DESIRED_RETENTION env-var tuning (P2-6)", () => {
  const envBackup = process.env.L2_DESIRED_RETENTION;
  const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

  afterEach(() => {
    delete process.env.L2_DESIRED_RETENTION;
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterAll(() => {
    if (envBackup !== undefined) process.env.L2_DESIRED_RETENTION = envBackup;
    warnSpy.mockRestore();
    infoSpy.mockRestore();
  });

  async function importServiceAndInsert(value: string) {
    process.env.L2_DESIRED_RETENTION = value;
    vi.resetModules();
    const mod = await import("@/services/l2-transition.service");
    const L2TransitionServiceDyn = mod.L2TransitionService;
    const mockL2Repo = {
      findByWordbookWordAndUser: vi.fn().mockResolvedValue(null),
      insert: vi.fn().mockResolvedValue({ id: "l2-1" }),
    };
    const service = new L2TransitionServiceDyn(mockL2Repo as any);
    await service.checkAndTransition(makeProgress());
    return mockL2Repo.insert.mock.calls[0][0] as { l2_desired_retention: number };
  }

  it("L2_DESIRED_RETENTION=0.950 writes 0.95 to the new L2 row", async () => {
    const inserted = await importServiceAndInsert("0.950");
    expect(inserted.l2_desired_retention).toBe(0.95);
  });

  it("L2_DESIRED_RETENTION=0.990 writes 0.99 (upper bound)", async () => {
    const inserted = await importServiceAndInsert("0.990");
    expect(inserted.l2_desired_retention).toBe(0.99);
  });

  it("L2_DESIRED_RETENTION=0.900 writes 0.9 (lower bound)", async () => {
    const inserted = await importServiceAndInsert("0.900");
    expect(inserted.l2_desired_retention).toBe(0.9);
  });

  it("L2_DESIRED_RETENTION=0.85 falls back to 0.9 (below DB CHECK lower bound)", async () => {
    const inserted = await importServiceAndInsert("0.85");
    expect(inserted.l2_desired_retention).toBe(0.9);
  });

  it("L2_DESIRED_RETENTION=1.0 falls back to 0.9 (above DB CHECK upper bound)", async () => {
    const inserted = await importServiceAndInsert("1.0");
    expect(inserted.l2_desired_retention).toBe(0.9);
  });

  it("L2_DESIRED_RETENTION=abc falls back to 0.9 (non-numeric)", async () => {
    const inserted = await importServiceAndInsert("abc");
    expect(inserted.l2_desired_retention).toBe(0.9);
  });

  it("L2_DESIRED_RETENTION=0.955 rounds to 0.955 (NUMERIC(4,3) 3 decimal places)", async () => {
    const inserted = await importServiceAndInsert("0.955");
    expect(inserted.l2_desired_retention).toBeCloseTo(0.955, 3);
  });
});
