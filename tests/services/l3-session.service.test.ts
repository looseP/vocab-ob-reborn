import { describe, it, expect, vi } from "vitest";
import { BusinessRuleError, NotFoundError, ValidationError } from "@/errors";
import type { L3SessionContextSummary, L3SessionPlan, L3SessionRow } from "@/domain";
import type { IL3SessionRepository, IRepositories } from "@/repositories/interfaces";
import { L3SessionService } from "@/services/l3-session.service";

type TxRunner = typeof import("@/db/transaction").withTransaction;

const CONTEXT_1: L3SessionContextSummary = {
  id: "ctx-1",
  text: "A vivid context.",
  context_type: "sentence",
  source_id: "src-1",
  source_title: "Essay",
};
const CONTEXT_2: L3SessionContextSummary = {
  id: "ctx-2",
  text: "Another vivid context.",
  context_type: "sentence",
  source_id: "src-1",
  source_title: "Essay",
};
const CONTEXT_3: L3SessionContextSummary = {
  id: "ctx-3",
  text: "A third vivid context.",
  context_type: "excerpt",
  source_id: "src-2",
  source_title: "Reader",
};

const PLAN: L3SessionPlan = {
  version: 1,
  days: 2,
  seed: "seed-1",
  items: [
    { day: 1, contextIds: ["ctx-1", "ctx-2"] },
    { day: 2, contextIds: ["ctx-3"] },
  ],
};

const SESSION_ROW: L3SessionRow = {
  id: "sess-1",
  user_id: "u1",
  type: "cram_pack",
  title: "Cram",
  plan: PLAN as unknown as L3SessionRow["plan"],
  version: 1,
  status: "active",
  started_at: "2026-09-11T00:00:00Z",
  ended_at: null,
  created_at: "2026-09-11T00:00:00Z",
};

function makeFsrsSpies() {
  return {
    saveAnswer: vi.fn(),
    saveL2Answer: vi.fn(),
    insertL2: vi.fn(),
    insertL2SeedAuditLog: vi.fn(),
  };
}

type FsrsSpies = ReturnType<typeof makeFsrsSpies>;

function expectNoFsrsWrites(fsrs: FsrsSpies): void {
  expect(fsrs.saveAnswer).not.toHaveBeenCalled();
  expect(fsrs.saveL2Answer).not.toHaveBeenCalled();
  expect(fsrs.insertL2).not.toHaveBeenCalled();
  expect(fsrs.insertL2SeedAuditLog).not.toHaveBeenCalled();
}

function makeSessionRepo(overrides: Partial<IL3SessionRepository> = {}): IL3SessionRepository {
  return {
    insertSession: vi.fn(async (input) => ({
      ...SESSION_ROW,
      user_id: input.user_id,
      type: input.type,
      title: input.title,
      plan: input.plan,
      version: input.version,
    })),
    findSessionByIdForUser: vi.fn(async () => SESSION_ROW),
    updateStatus: vi.fn(async (userId, sessionId, status) => ({
      ...SESSION_ROW,
      id: sessionId,
      user_id: userId,
      status,
      ended_at: "2026-09-11T01:00:00Z",
    })),
    sampleContextIds: vi.fn(async () => ["ctx-1", "ctx-2", "ctx-3"]),
    findContextsByIds: vi.fn(async () => [CONTEXT_1, CONTEXT_2, CONTEXT_3]),
    ...overrides,
  };
}

function makeTxRunner(): TxRunner {
  return vi.fn(async <T>(callback: (tx: never) => Promise<T>): Promise<T> =>
    callback({} as never),
  ) as unknown as TxRunner;
}

function makeService(
  sessions: IL3SessionRepository,
  fsrs: FsrsSpies,
  txRunner: TxRunner,
): L3SessionService {
  return new L3SessionService({
    txRunner,
    repositoryFactory: () =>
      ({
        l3Sessions: sessions,
        l2Progress: { saveL2Answer: fsrs.saveL2Answer, insert: fsrs.insertL2 },
        reviews: { saveAnswer: fsrs.saveAnswer },
      }) as unknown as IRepositories,
  });
}

describe("L3SessionService defaults", () => {
  it("falls back to the real withTransaction/repository factory when deps are omitted", () => {
    const service = new L3SessionService();
    expect(service).toBeInstanceOf(L3SessionService);
  });
});

describe("L3SessionService.createPlan", () => {
  it("samples deterministically and stores a plan of id references only", async () => {
    const repo = makeSessionRepo();
    const fsrs = makeFsrsSpies();
    const txRunner = makeTxRunner();
    const service = makeService(repo, fsrs, txRunner);

    await service.createPlan({
      userId: "u1",
      type: "cram_pack",
      title: "考前攻坚",
      space: "阅读",
      direction: "考研",
      contextCount: 3,
      days: 2,
      seed: "seed-1",
    });

    expect(txRunner).toHaveBeenCalledWith(expect.any(Function), { actorId: "u1" });
    expect(repo.sampleContextIds).toHaveBeenCalledWith({
      userId: "u1",
      space: "阅读",
      direction: "考研",
      limit: 3,
      seed: "seed-1",
    });

    const inserted = vi.mocked(repo.insertSession).mock.calls[0]?.[0];
    expect(inserted).toMatchObject({ user_id: "u1", type: "cram_pack", title: "考前攻坚", version: 1 });
    expect(inserted?.plan).toEqual({
      version: 1,
      days: 2,
      seed: "seed-1",
      items: [
        { day: 1, contextIds: ["ctx-1", "ctx-2"] },
        { day: 2, contextIds: ["ctx-3"] },
      ],
    });
    // plan 只含 id 引用：无 context 原文文本、无冻结产物。
    const plan = inserted?.plan as unknown as L3SessionPlan;
    expect(Object.keys(plan).sort()).toEqual(["days", "items", "seed", "version"]);
    for (const item of plan.items) {
      expect(Object.keys(item).sort()).toEqual(["contextIds", "day"]);
      for (const id of item.contextIds) expect(id).toMatch(/^ctx-/);
    }
    expect(JSON.stringify(plan)).not.toContain("A vivid context.");
    expect(JSON.stringify(plan)).not.toContain("html");
    expectNoFsrsWrites(fsrs);
  });

  it("defaults the axes to null and derives a stable seed when omitted", async () => {
    const repo = makeSessionRepo();
    const service = makeService(repo, makeFsrsSpies(), makeTxRunner());

    await service.createPlan({ userId: "u1", type: "l3_practice", contextCount: 2, days: 1 });
    await service.createPlan({ userId: "u1", type: "l3_practice", contextCount: 2, days: 1 });

    const calls = vi.mocked(repo.sampleContextIds).mock.calls;
    expect(calls[0]?.[0]).toMatchObject({ space: null, direction: null, limit: 2 });
    const seed = calls[0]?.[0].seed ?? "";
    expect(seed).toHaveLength(16);
    expect(calls[1]?.[0].seed).toBe(seed); // 同输入 → 同 seed
  });

  it("uses the default contextCount/days when omitted", async () => {
    const repo = makeSessionRepo();
    const service = makeService(repo, makeFsrsSpies(), makeTxRunner());

    await service.createPlan({ userId: "u1", type: "knowledge" });

    expect(vi.mocked(repo.sampleContextIds).mock.calls[0]?.[0].limit).toBe(20);
    const plan = vi.mocked(repo.insertSession).mock.calls[0]?.[0].plan as unknown as L3SessionPlan;
    expect(plan.days).toBe(1);
  });

  it("prefers an explicit seed and ignores a blank one", async () => {
    const repo = makeSessionRepo();
    const service = makeService(repo, makeFsrsSpies(), makeTxRunner());

    await service.createPlan({ userId: "u1", type: "cram_pack", contextCount: 1, days: 1, seed: "explicit" });
    await service.createPlan({ userId: "u1", type: "cram_pack", contextCount: 1, days: 1, seed: "   " });

    const calls = vi.mocked(repo.sampleContextIds).mock.calls;
    expect(calls[0]?.[0].seed).toBe("explicit");
    expect(calls[1]?.[0].seed).not.toBe("   ");
    expect(calls[1]?.[0].seed).toHaveLength(16);
  });

  it("rejects an unknown type or an invalid axis before opening a transaction", async () => {
    const repo = makeSessionRepo();
    const txRunner = makeTxRunner();
    const service = makeService(repo, makeFsrsSpies(), txRunner);

    await expect(service.createPlan({ userId: "u1", type: "nope" as never })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(
      service.createPlan({ userId: "u1", type: "cram_pack", space: "数学" as never }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      service.createPlan({ userId: "u1", type: "cram_pack", direction: "法语" as never }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(service.createPlan({ userId: "", type: "cram_pack" })).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(txRunner).not.toHaveBeenCalled();
  });

  it("rejects out-of-range contextCount/days", async () => {
    const service = makeService(makeSessionRepo(), makeFsrsSpies(), makeTxRunner());

    for (const contextCount of [0, 1.5, 999]) {
      await expect(
        service.createPlan({ userId: "u1", type: "cram_pack", contextCount }),
      ).rejects.toBeInstanceOf(ValidationError);
    }
    for (const days of [0, 1.5, 999]) {
      await expect(service.createPlan({ userId: "u1", type: "cram_pack", days })).rejects.toBeInstanceOf(
        ValidationError,
      );
    }
  });

  it("refuses to create an empty session when nothing matches", async () => {
    const repo = makeSessionRepo({ sampleContextIds: vi.fn(async () => []) });
    const service = makeService(repo, makeFsrsSpies(), makeTxRunner());

    await expect(
      service.createPlan({ userId: "u1", type: "cram_pack", contextCount: 5, days: 2 }),
    ).rejects.toBeInstanceOf(BusinessRuleError);
    expect(repo.insertSession).not.toHaveBeenCalled();
  });

  it("keeps all requested days, leaving trailing days empty when material is short", async () => {
    const repo = makeSessionRepo({ sampleContextIds: vi.fn(async () => ["ctx-1", "ctx-2"]) });
    const service = makeService(repo, makeFsrsSpies(), makeTxRunner());

    await service.createPlan({ userId: "u1", type: "cram_pack", contextCount: 2, days: 3, seed: "s" });

    const plan = vi.mocked(repo.insertSession).mock.calls[0]?.[0].plan as unknown as L3SessionPlan;
    expect(plan.items.map((item) => item.contextIds)).toEqual([["ctx-1"], ["ctx-2"], []]);
  });

  it("produces the same plan for the same seed across two runs", async () => {
    const repo = makeSessionRepo({
      sampleContextIds: vi.fn(async (input) => (input.seed === "seed-x" ? ["ctx-1", "ctx-2"] : ["ctx-9"])),
    });
    const service = makeService(repo, makeFsrsSpies(), makeTxRunner());

    await service.createPlan({ userId: "u1", type: "cram_pack", contextCount: 2, days: 2, seed: "seed-x" });
    await service.createPlan({ userId: "u1", type: "cram_pack", contextCount: 2, days: 2, seed: "seed-x" });

    const plans = vi.mocked(repo.insertSession).mock.calls.map((call) => call[0].plan);
    expect(plans[0]).toEqual(plans[1]);
  });
});

describe("L3SessionService.getSession", () => {
  it("re-renders the plan ids into current contexts, preserving order and dropping deleted ids", async () => {
    const repo = makeSessionRepo({
      findSessionByIdForUser: vi.fn(async () => SESSION_ROW),
      // ctx-2 已被删除；返回顺序故意打乱。
      findContextsByIds: vi.fn(async () => [CONTEXT_3, CONTEXT_1]),
    });
    const fsrs = makeFsrsSpies();
    const service = makeService(repo, fsrs, makeTxRunner());

    const result = await service.getSession({ userId: "u1", sessionId: "sess-1" });

    expect(repo.findContextsByIds).toHaveBeenCalledWith("u1", ["ctx-1", "ctx-2", "ctx-3"]);
    expect(result.session).toBe(SESSION_ROW);
    expect(result.items).toEqual([
      { day: 1, contexts: [CONTEXT_1] },
      { day: 2, contexts: [CONTEXT_3] },
    ]);
    expectNoFsrsWrites(fsrs);
  });

  it("skips the context read for a plan without ids", async () => {
    const repo = makeSessionRepo({
      findSessionByIdForUser: vi.fn(async () => ({
        ...SESSION_ROW,
        plan: { version: 1, days: 1, seed: "s", items: [{ day: 1, contextIds: [] }] } as L3SessionRow["plan"],
      })),
    });
    const service = makeService(repo, makeFsrsSpies(), makeTxRunner());

    const result = await service.getSession({ userId: "u1", sessionId: "sess-1" });

    expect(result.items).toEqual([{ day: 1, contexts: [] }]);
    expect(repo.findContextsByIds).not.toHaveBeenCalled();
  });

  it("tolerates a plan without days/seed metadata", async () => {
    const repo = makeSessionRepo({
      findSessionByIdForUser: vi.fn(async () => ({
        ...SESSION_ROW,
        plan: { version: 1, items: [{ day: 1, contextIds: ["ctx-1"] }] } as unknown as L3SessionRow["plan"],
      })),
      findContextsByIds: vi.fn(async () => [CONTEXT_1]),
    });
    const service = makeService(repo, makeFsrsSpies(), makeTxRunner());

    const result = await service.getSession({ userId: "u1", sessionId: "sess-1" });

    expect(result.items).toEqual([{ day: 1, contexts: [CONTEXT_1] }]);
  });

  it("maps a missing session to NotFoundError", async () => {
    const repo = makeSessionRepo({ findSessionByIdForUser: vi.fn(async () => null) });
    const service = makeService(repo, makeFsrsSpies(), makeTxRunner());

    await expect(service.getSession({ userId: "u1", sessionId: "missing" })).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("tolerates malformed plan items while keeping well-formed ids (no silent corruption)", async () => {
    const repo = makeSessionRepo({
      findSessionByIdForUser: vi.fn(async () => ({
        ...SESSION_ROW,
        plan: {
          version: 1,
          days: 2,
          seed: "s",
          items: [null, "x", [], { day: "bad", contextIds: [1, "ctx-1", ""] }, { day: 2 }],
        } as unknown as L3SessionRow["plan"],
      })),
      findContextsByIds: vi.fn(async () => [CONTEXT_1]),
    });
    const service = makeService(repo, makeFsrsSpies(), makeTxRunner());

    const result = await service.getSession({ userId: "u1", sessionId: "sess-1" });

    expect(repo.findContextsByIds).toHaveBeenCalledWith("u1", ["ctx-1"]);
    expect(result.items).toEqual([
      { day: 1, contexts: [CONTEXT_1] },
      { day: 2, contexts: [] },
    ]);
  });

  it("rejects plan.version !== 1 (unknown version is not silently degraded)", async () => {
    const base = { days: 1, seed: "s", items: [{ day: 1, contextIds: ["ctx-1"] }] };
    for (const plan of [
      { ...base }, // missing version
      { ...base, version: 2 },
      { ...base, version: "1" },
    ]) {
      const repo = makeSessionRepo({
        findSessionByIdForUser: vi.fn(async () => ({
          ...SESSION_ROW,
          plan: plan as unknown as L3SessionRow["plan"],
        })),
      });
      const service = makeService(repo, makeFsrsSpies(), makeTxRunner());
      await expect(service.getSession({ userId: "u1", sessionId: "sess-1" })).rejects.toBeInstanceOf(
        BusinessRuleError,
      );
      expect(repo.findContextsByIds).not.toHaveBeenCalled();
    }
  });

  it("rejects a plan that is not an object or whose items are not an array", async () => {
    for (const plan of [null, "x", [], { version: 1, items: "nope" }]) {
      const repo = makeSessionRepo({
        findSessionByIdForUser: vi.fn(async () => ({
          ...SESSION_ROW,
          plan: plan as unknown as L3SessionRow["plan"],
        })),
      });
      const service = makeService(repo, makeFsrsSpies(), makeTxRunner());
      await expect(service.getSession({ userId: "u1", sessionId: "sess-1" })).rejects.toBeInstanceOf(
        BusinessRuleError,
      );
    }
  });

  it("rejects empty userId/sessionId", async () => {
    const service = makeService(makeSessionRepo(), makeFsrsSpies(), makeTxRunner());
    await expect(service.getSession({ userId: "", sessionId: "sess-1" })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(service.getSession({ userId: "u1", sessionId: "" })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});

describe("L3SessionService.endSession", () => {
  it("ends an active session and stamps ended_at", async () => {
    const repo = makeSessionRepo();
    const fsrs = makeFsrsSpies();
    const service = makeService(repo, fsrs, makeTxRunner());

    const result = await service.endSession({ userId: "u1", sessionId: "sess-1", status: "completed" });

    expect(repo.updateStatus).toHaveBeenCalledWith("u1", "sess-1", "completed", { ended: true });
    expect(result.status).toBe("completed");
    expect(result.ended_at).toBe("2026-09-11T01:00:00Z");
    expectNoFsrsWrites(fsrs);
  });

  it("is idempotent when the session already carries the requested status", async () => {
    const completed = { ...SESSION_ROW, status: "completed" as const };
    const repo = makeSessionRepo({ findSessionByIdForUser: vi.fn(async () => completed) });
    const service = makeService(repo, makeFsrsSpies(), makeTxRunner());

    const result = await service.endSession({ userId: "u1", sessionId: "sess-1", status: "completed" });

    expect(result).toBe(completed);
    expect(repo.updateStatus).not.toHaveBeenCalled();
  });

  it("rejects ending a session that is already ended with a different status", async () => {
    const repo = makeSessionRepo({
      findSessionByIdForUser: vi.fn(async () => ({ ...SESSION_ROW, status: "abandoned" as const })),
    });
    const service = makeService(repo, makeFsrsSpies(), makeTxRunner());

    await expect(
      service.endSession({ userId: "u1", sessionId: "sess-1", status: "completed" }),
    ).rejects.toBeInstanceOf(BusinessRuleError);
    expect(repo.updateStatus).not.toHaveBeenCalled();
  });

  it("maps a missing session and a lost update race to NotFoundError", async () => {
    const missing = makeService(
      makeSessionRepo({ findSessionByIdForUser: vi.fn(async () => null) }),
      makeFsrsSpies(),
      makeTxRunner(),
    );
    await expect(
      missing.endSession({ userId: "u1", sessionId: "sess-1", status: "abandoned" }),
    ).rejects.toBeInstanceOf(NotFoundError);

    const raced = makeService(
      makeSessionRepo({ updateStatus: vi.fn(async () => null) }),
      makeFsrsSpies(),
      makeTxRunner(),
    );
    await expect(
      raced.endSession({ userId: "u1", sessionId: "sess-1", status: "abandoned" }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("rejects an invalid target status (active is not an end state)", async () => {
    const repo = makeSessionRepo();
    const txRunner = makeTxRunner();
    const service = makeService(repo, makeFsrsSpies(), txRunner);

    await expect(
      service.endSession({ userId: "u1", sessionId: "sess-1", status: "active" as never }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      service.endSession({ userId: "", sessionId: "sess-1", status: "completed" }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(txRunner).not.toHaveBeenCalled();
  });
});
