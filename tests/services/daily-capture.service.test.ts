/**
 * DailyCaptureService 单测（注入式 txRunner / repoFactory，同 review-cards 先例）。
 *
 * 锁的口径：
 *  - 追加先幂等 seed 再校验类型（同事务，未知/隐藏类型 422）；
 *  - entry_date 缺省 = 显示时区今天（与服务端日文件口径同源）；
 *  - content 空白 422；23505 冲突**重开事务**重试（Postgres abort 语义）；
 *  - getDayFile = domain 确定性渲染器组装（formatClock 经仓储注入）。
 */
import { describe, expect, it, vi } from "vitest";
import { DailyCaptureService } from "@/services/daily-capture.service";
import { todayKeyInDisplayTz } from "@/db/timezone";
import type { IRepositories } from "@/repositories/interfaces";
import type { DailyCaptureEntryRow, DailyCaptureTypeRow } from "@/domain/daily-capture";

const USER = "11111111-1111-4111-8111-111111111111";

function makeType(key: string, hidden = false): DailyCaptureTypeRow {
  return { user_id: USER, type_key: key, label: key, absorption_hint: null, sort: 0, hidden, created_at: "2026-10-10T00:00:00Z" };
}

function makeRow(input: { entry_date: string; entry_type: string; content: string; meta: unknown }): DailyCaptureEntryRow {
  return {
    id: "e-1",
    user_id: USER,
    entry_date: input.entry_date,
    seq: 7,
    entry_type: input.entry_type,
    content: input.content,
    meta: (input.meta ?? null) as DailyCaptureEntryRow["meta"],
    status: "raw",
    absorption: null,
    created_at: "2026-10-10T01:02:00Z",
    hidden_at: null,
  };
}

function makeService(overrides: { insertEntry?: ReturnType<typeof vi.fn>; listTypes?: ReturnType<typeof vi.fn> } = {}) {
  const dailyCapture = {
    ensureDefaultTypes: vi.fn(async () => undefined),
    listTypes: overrides.listTypes ?? vi.fn(async () => [makeType("phrase"), makeType("sentence")]),
    insertEntry:
      overrides.insertEntry ??
      vi.fn(async (input: { entry_date: string; entry_type: string; content: string; meta: unknown }) =>
        makeRow(input),
      ),
    listDay: vi.fn(async () => []),
    listDaySummaries: vi.fn(async () => []),
  };
  const repoFactory = () => ({ dailyCapture }) as unknown as IRepositories;
  const txRunner = vi.fn(
    async (fn: (tx: unknown) => Promise<unknown>, _options?: unknown) => fn({}),
  ) as unknown as typeof import("@/db/transaction").withTransaction;
  const service = new DailyCaptureService(txRunner, repoFactory);
  return { service, dailyCapture, txRunner: txRunner as unknown as ReturnType<typeof vi.fn> };
}

describe("DailyCaptureService.appendEntry（轻阻力追加）", () => {
  it("先 seed 后校验，缺省 entry_date = 显示时区今天，content 去首尾空白", async () => {
    const { service, dailyCapture } = makeService();
    const row = await service.appendEntry({ userId: USER, entryType: "phrase", content: "  harness the power  " });

    expect(dailyCapture.ensureDefaultTypes).toHaveBeenCalledWith(USER);
    expect(dailyCapture.insertEntry).toHaveBeenCalledWith({
      user_id: USER,
      entry_date: todayKeyInDisplayTz(),
      entry_type: "phrase",
      content: "harness the power",
      meta: null,
    });
    expect(row.seq).toBe(7);
  });

  it("meta 透传（含 wordSlugs 软引用）", async () => {
    const { service, dailyCapture } = makeService();
    await service.appendEntry({
      userId: USER,
      entryType: "sentence",
      content: "She harnessed her frustration.",
      meta: { translation: "她把挫败感转化为产出。", wordSlugs: ["harness"] },
    });
    expect(dailyCapture.insertEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        meta: { translation: "她把挫败感转化为产出。", wordSlugs: ["harness"] },
      }),
    );
  });

  it("空白 content 拒绝（VALIDATION_ERROR），不触仓库", async () => {
    const { service, dailyCapture } = makeService();
    await expect(service.appendEntry({ userId: USER, entryType: "phrase", content: "   " })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    expect(dailyCapture.insertEntry).not.toHaveBeenCalled();
  });

  it("未知类型 422（注册表是软引用，完整性在服务层）", async () => {
    const { service, dailyCapture } = makeService();
    await expect(
      service.appendEntry({ userId: USER, entryType: "nope", content: "x" }),
    ).rejects.toMatchObject({ code: "BUSINESS_RULE" });
    expect(dailyCapture.insertEntry).not.toHaveBeenCalled();
  });

  it("hidden 类型同样拒绝", async () => {
    const { service } = makeService({
      listTypes: vi.fn(async () => [makeType("phrase"), makeType("idea", true)]),
    });
    await expect(service.appendEntry({ userId: USER, entryType: "idea", content: "x" })).rejects.toMatchObject({
      code: "BUSINESS_RULE",
    });
  });

  it("seq 冲突（23505）重开事务重试；非冲突错误原样上抛", async () => {
    const insertEntry = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("dup"), { code: "23505" }))
      .mockResolvedValueOnce(makeRow({ entry_date: "2026-10-10", entry_type: "phrase", content: "x", meta: null }));
    const { service, txRunner } = makeService({ insertEntry });
    const row = await service.appendEntry({ userId: USER, entryType: "phrase", content: "x" });
    expect(row.seq).toBe(7);
    expect(txRunner).toHaveBeenCalledTimes(2);

    const fatal = vi.fn().mockRejectedValue(new Error("boom"));
    const { service: failing } = makeService({ insertEntry: fatal });
    await expect(failing.appendEntry({ userId: USER, entryType: "phrase", content: "x" })).rejects.toThrow("boom");
    expect(txRunner).toHaveBeenCalledTimes(2); // 第二个 service 实例各自计数，这里只证上抛
  });
});

describe("DailyCaptureService.getDayFile（确定性投影）", () => {
  it("组装 types + entries 交给渲染器，输出含稳定 ID 与页脚", async () => {
    const entries: DailyCaptureEntryRow[] = [
      makeRow({ entry_date: "2026-10-10", entry_type: "phrase", content: "harness the power", meta: null }),
    ];
    const { service, dailyCapture } = makeService();
    (dailyCapture.listDay as ReturnType<typeof vi.fn>).mockResolvedValue(entries);

    const { markdown } = await service.getDayFile(USER, "2026-10-10");
    expect(markdown).toContain("# 每日捕获 · 2026-10-10");
    // formatEntryClock = 显示时区（Asia/Shanghai）墙钟：01:02Z → 09:02
    expect(markdown).toContain("[#7] 09:02 harness the power");
    expect(markdown).toContain("共 1 条 · 已回顾 0 · 已吸收 0");
    expect(dailyCapture.listDay).toHaveBeenCalledWith(USER, "2026-10-10");
  });
});

// ── M3 吸收侧 ────────────────────────────────────────────────────────────────

const WORD = {
  id: "w-1",
  slug: "harness",
  title: "harness",
  lemma: "harness",
  ipa: null,
  short_definition: "利用",
};

const RAW_ENTRY = makeRow({ entry_date: "2026-10-10", entry_type: "sentence", content: "She harnessed her frustration.", meta: null });

/** M3 专用 harness：full repos（words/l3Context/wordbooks/reviews/outbox）。 */
function makeAbsorbService(overrides: {
  findEntry?: ReturnType<typeof vi.fn>;
  findBySlug?: ReturnType<typeof vi.fn>;
  findWordContextIdByText?: ReturnType<typeof vi.fn>;
  insertNewCard?: ReturnType<typeof vi.fn>;
  appendAbsorption?: ReturnType<typeof vi.fn>;
  listDay?: ReturnType<typeof vi.fn>;
} = {}) {
  const dailyCapture = {
    ensureDefaultTypes: vi.fn(async () => undefined),
    listTypes: vi.fn(async () => [makeType("phrase"), makeType("sentence")]),
    insertEntry: vi.fn(async () => RAW_ENTRY),
    listDay: overrides.listDay ?? vi.fn(async () => [RAW_ENTRY]),
    listDaySummaries: vi.fn(async () => []),
    findEntry: overrides.findEntry ?? vi.fn(async () => RAW_ENTRY),
    appendAbsorption:
      overrides.appendAbsorption ??
      vi.fn(async (_userId: string, _id: string, receipt: { action: string }, status: string) => ({
        ...RAW_ENTRY,
        status,
        absorption: [receipt],
      })),
    updateEntryFields: vi.fn(async () => RAW_ENTRY),
  };
  const words = {
    findBySlug: overrides.findBySlug ?? vi.fn(async () => WORD),
    insertMany: vi.fn(async () => undefined),
  };
  const l3Context = {
    findWordContextIdByText: overrides.findWordContextIdByText ?? vi.fn(async () => null),
    countWordOccurrences: vi.fn(async () => 2),
    createSource: vi.fn(async () => ({ id: "src-1" })),
    createContext: vi.fn(async () => ({ id: "ctx-1" })),
    createOccurrence: vi.fn(async () => ({ id: "occ-1" })),
  };
  const wordbooks = { addWords: vi.fn(async () => undefined) };
  const reviews = {
    insertNewCard: overrides.insertNewCard ?? vi.fn(async () => ({ status: "inserted", progressId: "p-1" })),
  };
  const outbox = { enqueue: vi.fn(async () => ({ id: "ob-1", inserted: true })) };
  const repoFactory = () => ({ dailyCapture, words, l3Context, wordbooks, reviews, outbox }) as unknown as IRepositories;
  const txRunner = vi.fn(
    async (fn: (tx: unknown) => Promise<unknown>, _options?: unknown) => fn({}),
  ) as unknown as typeof import("@/db/transaction").withTransaction;
  const service = new DailyCaptureService(txRunner, repoFactory);
  return { service, dailyCapture, words, l3Context, wordbooks, reviews, outbox };
}

describe("DailyCaptureService.getEvidencePack（agent 唯一读面的数据源）", () => {
  it("markdown + 结构化条目：label/hint/关联词释义与既有语境计数；未入库词跳过", async () => {
    const listDay = vi.fn(async () => [
      makeRow({
        entry_date: "2026-10-10",
        entry_type: "sentence",
        content: "She harnessed her frustration.",
        meta: { wordSlugs: ["harness", "ghost"] },
      }),
    ]);
    const { service, words, l3Context } = makeAbsorbService({
      listDay,
      findBySlug: vi.fn(async (slug: string) => (slug === "harness" ? WORD : null)),
    });
    (l3Context.countWordOccurrences as ReturnType<typeof vi.fn>).mockResolvedValue(2);

    const pack = await service.getEvidencePack(USER, "2026-10-10");
    expect(pack.version).toBe(1);
    expect(pack.markdown).toContain("She harnessed her frustration.");
    expect(pack.entries[0].label).toBe("sentence");
    expect(pack.entries[0].absorption_hint).toBeNull();
    expect(pack.entries[0].words).toHaveLength(1); // ghost 未入库 → 跳过
    expect(pack.entries[0].words[0].existing_context_count).toBe(2);
  });
});

describe("DailyCaptureService.absorbEntry（proposal-only 的执行半边）", () => {
  it("bind_l3：复用三件套管道（同事务），回执指向 l3_context，条目置 absorbed", async () => {
    const { service, l3Context, dailyCapture } = makeAbsorbService();
    const { entry, receipt } = await service.absorbEntry({
      userId: USER,
      id: "e-1",
      action: "bind_l3",
      wordSlug: "harness",
      payload: { contextText: "She harnessed her frustration." },
      wordbookId: "wb-1",
    });

    expect(l3Context.createSource).toHaveBeenCalledTimes(1);
    expect(l3Context.createOccurrence).toHaveBeenCalledTimes(1);
    expect(receipt.target).toBe("l3_context");
    expect(receipt.id).toBe("ctx-1");
    expect(receipt.word_slug).toBe("harness");
    expect(dailyCapture.appendAbsorption).toHaveBeenCalledWith(USER, "e-1", receipt, "absorbed");
    expect(entry.status).toBe("absorbed");
  });

  it("bind_l3 同句同词判重（§12-⑥）：命中 → 不写三件套，deduped 回执", async () => {
    const findWordContextIdByText = vi.fn(async () => ({ id: "ctx-9", source_id: "src-9" }));
    const { service, l3Context } = makeAbsorbService({ findWordContextIdByText });
    const { receipt } = await service.absorbEntry({
      userId: USER,
      id: "e-1",
      action: "bind_l3",
      wordSlug: "harness",
      payload: { contextText: "She harnessed her frustration." },
    });
    expect(l3Context.createSource).not.toHaveBeenCalled();
    expect(receipt.deduped).toBe(true);
    expect(receipt.id).toBe("ctx-9");
  });

  it("enqueue_review：inserted → 补 outbox；duplicate → deduped 且不补 outbox", async () => {
    const inserted = makeAbsorbService({
      insertNewCard: vi.fn(async () => ({ status: "inserted", progressId: "p-1" })),
    });
    const r1 = await inserted.service.absorbEntry({
      userId: USER, id: "e-1", action: "enqueue_review", wordSlug: "harness", wordbookId: "wb-1",
    });
    expect(inserted.reviews.insertNewCard).toHaveBeenCalledWith({
      userId: USER, wordId: "w-1", wordbookId: "wb-1", desiredRetention: "0.850",
    });
    expect(inserted.outbox.enqueue).toHaveBeenCalledTimes(1);
    expect(r1.receipt.target).toBe("review_card");
    expect(r1.receipt.id).toBe("p-1");

    const duplicate = makeAbsorbService({
      insertNewCard: vi.fn(async () => ({ status: "duplicate", progressId: null })),
    });
    const r2 = await duplicate.service.absorbEntry({
      userId: USER, id: "e-1", action: "enqueue_review", wordSlug: "harness", wordbookId: "wb-1",
    });
    expect(duplicate.outbox.enqueue).not.toHaveBeenCalled();
    expect(r2.receipt.deduped).toBe(true);
  });

  it("none → 归档；file_method → absorbed 且无写入目标", async () => {
    const archived = makeAbsorbService();
    const r1 = await archived.service.absorbEntry({ userId: USER, id: "e-1", action: "none" });
    expect(archived.dailyCapture.appendAbsorption).toHaveBeenCalledWith(USER, "e-1", r1.receipt, "archived");

    const filed = makeAbsorbService();
    const r2 = await filed.service.absorbEntry({ userId: USER, id: "e-1", action: "file_method" });
    expect(r2.receipt.target).toBeNull();
    expect(filed.dailyCapture.appendAbsorption).toHaveBeenCalledWith(USER, "e-1", r2.receipt, "absorbed");
  });

  it("已 absorbed 409 / archived 422 / 词不在库 422 / 缺 contextText 422", async () => {
    const absorbed = makeAbsorbService({
      findEntry: vi.fn(async () => ({ ...RAW_ENTRY, status: "absorbed" })),
    });
    await expect(absorbed.service.absorbEntry({ userId: USER, id: "e-1", action: "none" })).rejects.toMatchObject({
      httpStatus: 409,
    });

    const archived = makeAbsorbService({
      findEntry: vi.fn(async () => ({ ...RAW_ENTRY, status: "archived" })),
    });
    await expect(archived.service.absorbEntry({ userId: USER, id: "e-1", action: "none" })).rejects.toMatchObject({
      code: "BUSINESS_RULE",
    });

    const noWord = makeAbsorbService({ findBySlug: vi.fn(async () => null) });
    await expect(
      noWord.service.absorbEntry({ userId: USER, id: "e-1", action: "add_word", wordSlug: "ghost", wordbookId: "wb-1" }),
    ).rejects.toMatchObject({ code: "BUSINESS_RULE" });

    const noText = makeAbsorbService();
    await expect(
      noText.service.absorbEntry({ userId: USER, id: "e-1", action: "bind_l3", wordSlug: "harness" }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});
