import { describe, it, expect, vi } from "vitest";
import { ValidationError } from "@/errors";
import type { L3PracticeAttemptRow } from "@/domain";
import type { IL3PracticeRepository, IRepositories } from "@/repositories/interfaces";
import { L3PracticeService } from "@/services/l3-practice.service";

type TxRunner = typeof import("@/db/transaction").withTransaction;

const ATTEMPT_ROW: L3PracticeAttemptRow = {
  id: "att-1",
  user_id: "u1",
  context_id: "ctx-1",
  occurrence_id: null,
  session_id: null,
  practice_type: "essay_dictation",
  outcome: "wrong",
  payload: { taskId: "essay_dictation:aaaaaaaaaaaaaaaa" },
  created_at: "2026-09-11T00:00:00Z",
};

/** FSRS/L1/L2 写方法的间谍：断言零调用（"L3 有记录、无调度"红线）。 */
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

function makePracticeRepo(overrides: Partial<IL3PracticeRepository> = {}): IL3PracticeRepository {
  return {
    insertAttempt: vi.fn(async (input) => ({
      ...ATTEMPT_ROW,
      context_id: input.context_id,
      occurrence_id: input.occurrence_id,
      session_id: input.session_id,
      practice_type: input.practice_type,
      outcome: input.outcome,
      payload: input.payload,
    })),
    lockAttemptIdentity: vi.fn(async () => {}),
    findAttemptByTaskId: vi.fn(async () => null),
    listAttempts: vi.fn(async () => ({ items: [ATTEMPT_ROW], total: 1, limit: 20, offset: 0 })),
    listWrongAttempts: vi.fn(async () => ({ items: [ATTEMPT_ROW], total: 1, limit: 20, offset: 0 })),
    ...overrides,
  };
}

function makeTxRunner(): TxRunner {
  return vi.fn(async <T>(callback: (tx: never) => Promise<T>): Promise<T> =>
    callback({} as never),
  ) as unknown as TxRunner;
}

function makeService(
  practice: IL3PracticeRepository,
  fsrs: FsrsSpies,
  txRunner: TxRunner,
): L3PracticeService {
  return new L3PracticeService({
    txRunner,
    repositoryFactory: () =>
      ({
        l3Practice: practice,
        l2Progress: { saveL2Answer: fsrs.saveL2Answer, insert: fsrs.insertL2 },
        reviews: { saveAnswer: fsrs.saveAnswer },
      }) as unknown as IRepositories,
  });
}

describe("L3PracticeService defaults", () => {
  it("falls back to the real withTransaction/repository factory when deps are omitted", () => {
    const service = new L3PracticeService();
    expect(service).toBeInstanceOf(L3PracticeService);
  });
});

describe("L3PracticeService.recordAttempt", () => {
  it("locks, looks up, then inserts once inside one actor-scoped transaction", async () => {
    const repo = makePracticeRepo();
    const fsrs = makeFsrsSpies();
    const txRunner = makeTxRunner();
    const service = makeService(repo, fsrs, txRunner);

    const row = await service.recordAttempt({
      userId: "u1",
      contextId: "ctx-1",
      occurrenceId: "occ-1",
      sessionId: "sess-1",
      practiceType: "essay_dictation",
      outcome: "wrong",
      payload: { taskId: "essay_dictation:aaaaaaaaaaaaaaaa" },
    });

    expect(txRunner).toHaveBeenCalledTimes(1);
    expect(txRunner).toHaveBeenCalledWith(expect.any(Function), { actorId: "u1" });
    expect(repo.lockAttemptIdentity).toHaveBeenCalledWith("u1", "essay_dictation:aaaaaaaaaaaaaaaa");
    expect(repo.findAttemptByTaskId).toHaveBeenCalledWith("u1", "essay_dictation:aaaaaaaaaaaaaaaa");
    expect(repo.insertAttempt).toHaveBeenCalledWith({
      user_id: "u1",
      context_id: "ctx-1",
      occurrence_id: "occ-1",
      session_id: "sess-1",
      practice_type: "essay_dictation",
      outcome: "wrong",
      payload: { taskId: "essay_dictation:aaaaaaaaaaaaaaaa" },
    });
    expect(row.context_id).toBe("ctx-1");
    expectNoFsrsWrites(fsrs);
  });

  it("defaults optional occurrence/session to null", async () => {
    const repo = makePracticeRepo();
    const service = makeService(repo, makeFsrsSpies(), makeTxRunner());

    await service.recordAttempt({
      userId: "u1",
      contextId: "ctx-1",
      practiceType: "context_quiz",
      outcome: "correct",
      payload: { taskId: "t-2" },
    });

    expect(repo.insertAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ occurrence_id: null, session_id: null }),
    );
  });

  it("returns the existing row on an idempotent replay without inserting", async () => {
    const existing = { ...ATTEMPT_ROW, id: "existing" };
    const repo = makePracticeRepo({ findAttemptByTaskId: vi.fn(async () => existing) });
    const fsrs = makeFsrsSpies();
    const service = makeService(repo, fsrs, makeTxRunner());

    const row = await service.recordAttempt({
      userId: "u1",
      contextId: "ctx-9",
      practiceType: "essay_dictation",
      outcome: "correct",
      payload: { taskId: "t-1" },
    });

    expect(row).toBe(existing);
    expect(repo.insertAttempt).not.toHaveBeenCalled();
    expectNoFsrsWrites(fsrs);
  });

  it("rejects invalid enums before opening a transaction", async () => {
    const repo = makePracticeRepo();
    const txRunner = makeTxRunner();
    const service = makeService(repo, makeFsrsSpies(), txRunner);

    await expect(
      service.recordAttempt({
        userId: "u1",
        contextId: "ctx-1",
        practiceType: "nope" as never,
        outcome: "wrong",
        payload: { taskId: "t-1" },
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      service.recordAttempt({
        userId: "u1",
        contextId: "ctx-1",
        practiceType: "essay_dictation",
        outcome: "maybe" as never,
        payload: { taskId: "t-1" },
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(txRunner).not.toHaveBeenCalled();
    expect(repo.insertAttempt).not.toHaveBeenCalled();
  });

  it("rejects empty userId/contextId", async () => {
    const repo = makePracticeRepo();
    const service = makeService(repo, makeFsrsSpies(), makeTxRunner());

    await expect(
      service.recordAttempt({
        userId: "   ",
        contextId: "ctx-1",
        practiceType: "essay_dictation",
        outcome: "wrong",
        payload: { taskId: "t-1" },
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      service.recordAttempt({
        userId: "u1",
        contextId: undefined as unknown as string,
        practiceType: "essay_dictation",
        outcome: "wrong",
        payload: { taskId: "t-1" },
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("requires an object payload carrying a non-empty taskId", async () => {
    const repo = makePracticeRepo();
    const txRunner = makeTxRunner();
    const service = makeService(repo, makeFsrsSpies(), txRunner);

    const base = {
      userId: "u1",
      contextId: "ctx-1",
      practiceType: "essay_dictation" as const,
      outcome: "wrong" as const,
    };
    await expect(service.recordAttempt({ ...base, payload: null })).rejects.toBeInstanceOf(ValidationError);
    await expect(service.recordAttempt({ ...base, payload: [] })).rejects.toBeInstanceOf(ValidationError);
    await expect(service.recordAttempt({ ...base, payload: "oops" })).rejects.toBeInstanceOf(ValidationError);
    await expect(service.recordAttempt({ ...base, payload: {} })).rejects.toBeInstanceOf(ValidationError);
    await expect(service.recordAttempt({ ...base, payload: { taskId: "   " } })).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(txRunner).not.toHaveBeenCalled();
  });
});

describe("L3PracticeService.listAttempts", () => {
  it("resolves optional filters to null and applies pagination defaults", async () => {
    const repo = makePracticeRepo();
    const fsrs = makeFsrsSpies();
    const service = makeService(repo, fsrs, makeTxRunner());

    await service.listAttempts({ userId: "u1" });

    expect(repo.listAttempts).toHaveBeenCalledWith({
      userId: "u1",
      practiceType: null,
      outcome: null,
      space: null,
      direction: null,
      limit: 20,
      offset: 0,
    });
    expectNoFsrsWrites(fsrs);
  });

  it("passes the two-axis filters and clamps limit/offset", async () => {
    const repo = makePracticeRepo();
    const service = makeService(repo, makeFsrsSpies(), makeTxRunner());

    await service.listAttempts({
      userId: "u1",
      practiceType: "context_quiz",
      outcome: "correct",
      space: "阅读",
      direction: "考研",
      limit: 250,
      offset: -3,
    });

    expect(repo.listAttempts).toHaveBeenCalledWith({
      userId: "u1",
      practiceType: "context_quiz",
      outcome: "correct",
      space: "阅读",
      direction: "考研",
      limit: 100,
      offset: 0,
    });
  });

  it("falls back to the default limit for non-positive/fractional values and keeps an integer offset", async () => {
    const repo = makePracticeRepo();
    const service = makeService(repo, makeFsrsSpies(), makeTxRunner());

    await service.listAttempts({ userId: "u1", limit: 0, offset: 1.5 });
    expect(repo.listAttempts).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 20, offset: 0 }));

    await service.listAttempts({ userId: "u1", limit: 1.5, offset: 5 });
    expect(repo.listAttempts).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 20, offset: 5 }));
  });

  it("rejects invalid optional enum filters before querying", async () => {
    const repo = makePracticeRepo();
    const service = makeService(repo, makeFsrsSpies(), makeTxRunner());

    await expect(
      service.listAttempts({ userId: "u1", practiceType: "nope" as never }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      service.listAttempts({ userId: "u1", outcome: "maybe" as never }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      service.listAttempts({ userId: "u1", space: "数学" as never }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      service.listAttempts({ userId: "u1", direction: "法语" as never }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(repo.listAttempts).not.toHaveBeenCalled();
  });

  it("rejects an empty userId", async () => {
    const service = makeService(makePracticeRepo(), makeFsrsSpies(), makeTxRunner());
    await expect(service.listAttempts({ userId: "" })).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("L3PracticeService.errorBook", () => {
  it("derives the error book from wrong attempts with defaults", async () => {
    const repo = makePracticeRepo();
    const fsrs = makeFsrsSpies();
    const service = makeService(repo, fsrs, makeTxRunner());

    const page = await service.errorBook({ userId: "u1" });

    expect(repo.listWrongAttempts).toHaveBeenCalledWith({
      userId: "u1",
      space: null,
      direction: null,
      limit: 20,
      offset: 0,
    });
    expect(repo.listAttempts).not.toHaveBeenCalled();
    expect(page.items).toEqual([ATTEMPT_ROW]);
    expectNoFsrsWrites(fsrs);
  });

  it("filters the error book by sub-space and direction", async () => {
    const repo = makePracticeRepo();
    const service = makeService(repo, makeFsrsSpies(), makeTxRunner());

    await service.errorBook({ userId: "u1", space: "作文", direction: "雅思", limit: 5, offset: 10 });

    expect(repo.listWrongAttempts).toHaveBeenCalledWith({
      userId: "u1",
      space: "作文",
      direction: "雅思",
      limit: 5,
      offset: 10,
    });
  });

  it("rejects invalid axes and empty userId", async () => {
    const repo = makePracticeRepo();
    const service = makeService(repo, makeFsrsSpies(), makeTxRunner());

    await expect(service.errorBook({ userId: "u1", space: "数学" as never })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(service.errorBook({ userId: "u1", direction: "法语" as never })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(service.errorBook({ userId: " " })).rejects.toBeInstanceOf(ValidationError);
    expect(repo.listWrongAttempts).not.toHaveBeenCalled();
  });
});
