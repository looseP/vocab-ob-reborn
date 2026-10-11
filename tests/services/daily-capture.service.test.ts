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
import { CUSTOM_TYPE_DEFAULT_HINT } from "@/domain/daily-capture";
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

type RepoSpy = ReturnType<typeof vi.fn>;

function makeService(
  overrides: {
    insertEntry?: RepoSpy;
    listTypes?: RepoSpy;
    listDay?: RepoSpy;
    listDaySummaries?: RepoSpy;
    findEntry?: RepoSpy;
    updateEntryFields?: RepoSpy;
    findTypeByKey?: RepoSpy;
    countVisibleTypes?: RepoSpy;
    insertType?: RepoSpy;
    updateType?: RepoSpy;
  } = {},
) {
  const raw = makeRow({ entry_date: "2026-10-10", entry_type: "phrase", content: "harness the power", meta: null });
  const dailyCapture = {
    ensureDefaultTypes: vi.fn(async () => undefined),
    listTypes: overrides.listTypes ?? vi.fn(async () => [makeType("phrase"), makeType("sentence")]),
    insertEntry:
      overrides.insertEntry ??
      vi.fn(async (input: { entry_date: string; entry_type: string; content: string; meta: unknown }) =>
        makeRow(input),
      ),
    listDay: overrides.listDay ?? vi.fn(async () => []),
    listDaySummaries: overrides.listDaySummaries ?? vi.fn(async () => []),
    findEntry: overrides.findEntry ?? vi.fn(async () => raw),
    updateEntryFields: overrides.updateEntryFields ?? vi.fn(async () => raw),
    findTypeByKey: overrides.findTypeByKey ?? vi.fn(async () => null),
    countVisibleTypes: overrides.countVisibleTypes ?? vi.fn(async () => 6),
    insertType:
      overrides.insertType ??
      vi.fn(async (input: { type_key: string; label: string; absorption_hint: string | null; sort: number }) =>
        makeType(input.type_key),
      ),
    updateType: overrides.updateType ?? vi.fn(async () => makeType("slang")),
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

  it("entryType 空/超 40 字符 422；entryDate 非 YYYY-MM-DD 形状 422（都不触仓库）", async () => {
    const { service, dailyCapture } = makeService();
    await expect(service.appendEntry({ userId: USER, entryType: "   ", content: "x" })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    await expect(
      service.appendEntry({ userId: USER, entryType: "a".repeat(41), content: "x" }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(
      service.appendEntry({ userId: USER, entryType: "phrase", content: "x", entryDate: "2026/10/10" }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(dailyCapture.ensureDefaultTypes).not.toHaveBeenCalled();
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

// ── M2 回顾面：读面 + 状态流转 + 类型管理 ─────────────────────────────────────

describe("DailyCaptureService 读面（listTypes / listDays / getDay）", () => {
  it("listTypes / listDays 经事务透传（actorId 口径）", async () => {
    const { service, dailyCapture, txRunner } = makeService();
    expect((await service.listTypes(USER)).map((type) => type.type_key)).toEqual(["phrase", "sentence"]);
    expect(txRunner).toHaveBeenLastCalledWith(expect.any(Function), { actorId: USER });

    (dailyCapture.listDaySummaries as RepoSpy).mockResolvedValue([
      { date: "2026-10-10", total: 2, raw: 1, reviewed: 1, absorbed: 0 },
    ]);
    expect(await service.listDays(USER, 30)).toEqual([
      { date: "2026-10-10", total: 2, raw: 1, reviewed: 1, absorbed: 0 },
    ]);
    expect(dailyCapture.listDaySummaries).toHaveBeenCalledWith(USER, 30);
  });

  it("getDay 日期形状前置校验 422（不触仓库）；合法形状原样回传", async () => {
    const { service, dailyCapture } = makeService();
    await expect(service.getDay(USER, "2026/10/10")).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(dailyCapture.listTypes).not.toHaveBeenCalled();

    const day = await service.getDay(USER, "2026-10-10");
    expect(day.date).toBe("2026-10-10");
    expect(day.entries).toEqual([]);
  });
});

describe("DailyCaptureService.patchEntry（回顾流转 + 置要）", () => {
  const raw = makeRow({ entry_date: "2026-10-10", entry_type: "phrase", content: "harness the power", meta: null });

  it("空 patch 422（status 与 important 全缺，不进事务）", async () => {
    const { service, txRunner } = makeService();
    await expect(service.patchEntry(USER, "e-1", {})).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(txRunner).not.toHaveBeenCalled();
  });

  it("status 前向流转落库；同状态 PATCH = 幂等 no-op", async () => {
    const updateEntryFields = vi.fn(async () => ({ ...raw, status: "reviewed" as const }));
    const { service } = makeService({ updateEntryFields });
    expect((await service.patchEntry(USER, "e-1", { status: "reviewed" })).status).toBe("reviewed");
    expect(updateEntryFields).toHaveBeenCalledWith(USER, "e-1", { status: "reviewed" });

    const noop = makeService({
      findEntry: vi.fn(async () => ({ ...raw, status: "absorbed" })),
      updateEntryFields: vi.fn(async () => ({ ...raw, status: "absorbed" })),
    });
    await noop.service.patchEntry(USER, "e-1", { status: "absorbed" });
    expect(noop.dailyCapture.updateEntryFields).toHaveBeenCalledWith(USER, "e-1", { status: "absorbed" });
  });

  it("非法流转（终态回流/跳级）422 BUSINESS_RULE，不写库", async () => {
    const { service, dailyCapture } = makeService({
      findEntry: vi.fn(async () => ({ ...raw, status: "absorbed" })),
    });
    await expect(service.patchEntry(USER, "e-1", { status: "reviewed" })).rejects.toMatchObject({
      code: "BUSINESS_RULE",
    });
    expect(dailyCapture.updateEntryFields).not.toHaveBeenCalled();

    const fromReviewed = makeService({ findEntry: vi.fn(async () => ({ ...raw, status: "reviewed" })) });
    await expect(fromReviewed.service.patchEntry(USER, "e-1", { status: "raw" })).rejects.toMatchObject({
      code: "BUSINESS_RULE",
    });
  });

  it("未命中（不存在/已隐藏）404；updateEntryFields 0 行同样 404", async () => {
    const missing = makeService({ findEntry: vi.fn(async () => null) });
    await expect(missing.service.patchEntry(USER, "e-1", { important: true })).rejects.toMatchObject({ httpStatus: 404 });

    const raced = makeService({ updateEntryFields: vi.fn(async () => null) });
    await expect(raced.service.patchEntry(USER, "e-1", { status: "reviewed" })).rejects.toMatchObject({ httpStatus: 404 });
  });

  it("important=true 合并进 meta；false 摘除键；与 status 同 patch 时两字段齐发", async () => {
    const on = makeService({
      findEntry: vi.fn(async () => ({ ...raw, meta: { meaning: "利用" } })),
      updateEntryFields: vi.fn(async () => raw),
    });
    await on.service.patchEntry(USER, "e-1", { important: true });
    expect(on.dailyCapture.updateEntryFields).toHaveBeenCalledWith(USER, "e-1", {
      meta: { meaning: "利用", important: true },
    });

    const off = makeService({
      findEntry: vi.fn(async () => ({ ...raw, meta: { important: true, meaning: "利用" } })),
      updateEntryFields: vi.fn(async () => raw),
    });
    await off.service.patchEntry(USER, "e-1", { important: false });
    expect(off.dailyCapture.updateEntryFields).toHaveBeenCalledWith(USER, "e-1", { meta: { meaning: "利用" } });

    const both = makeService({
      findEntry: vi.fn(async () => ({ ...raw, meta: null })),
      updateEntryFields: vi.fn(async () => raw),
    });
    await both.service.patchEntry(USER, "e-1", { status: "archived", important: true });
    expect(both.dailyCapture.updateEntryFields).toHaveBeenCalledWith(USER, "e-1", {
      status: "archived",
      meta: { important: true },
    });
  });
});

describe("DailyCaptureService M2 类型管理（createType / patchType）", () => {
  it("createType：typeKey 形状与 label 长度前置校验 422（不进事务）", async () => {
    const { service, txRunner } = makeService();
    await expect(service.createType(USER, { typeKey: "Slang", label: "俚语" })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    await expect(service.createType(USER, { typeKey: "slang", label: "   " })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    await expect(service.createType(USER, { typeKey: "slang", label: "标".repeat(13) })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    expect(txRunner).not.toHaveBeenCalled();
  });

  it("createType：key 冲突 409（先 seed 再查重）；可见上限 10 触发 422", async () => {
    const conflict = makeService({ findTypeByKey: vi.fn(async () => makeType("slang")) });
    await expect(conflict.service.createType(USER, { typeKey: "slang", label: "俚语" })).rejects.toMatchObject({
      httpStatus: 409,
    });
    expect(conflict.dailyCapture.ensureDefaultTypes).toHaveBeenCalledWith(USER);
    expect(conflict.dailyCapture.insertType).not.toHaveBeenCalled();

    const capped = makeService({ countVisibleTypes: vi.fn(async () => 10) });
    await expect(capped.service.createType(USER, { typeKey: "slang", label: "俚语" })).rejects.toMatchObject({
      code: "BUSINESS_RULE",
    });
    expect(capped.dailyCapture.insertType).not.toHaveBeenCalled();
  });

  it("createType：缺省 hint = CUSTOM_TYPE_DEFAULT_HINT，sort = maxSort+1；显式值去空白后原样", async () => {
    const { service, dailyCapture } = makeService({
      listTypes: vi.fn(async () => [makeType("phrase"), { ...makeType("method"), sort: 3 }]),
    });
    await service.createType(USER, { typeKey: "slang", label: "俚语" });
    expect(dailyCapture.insertType).toHaveBeenCalledWith({
      user_id: USER,
      type_key: "slang",
      label: "俚语",
      absorption_hint: CUSTOM_TYPE_DEFAULT_HINT,
      sort: 4,
    });

    const explicit = makeService();
    await explicit.service.createType(USER, { typeKey: "slang", label: "俚语", absorptionHint: "  自行改写  ", sort: 0 });
    expect(explicit.dailyCapture.insertType).toHaveBeenCalledWith(
      expect.objectContaining({ absorption_hint: "自行改写", sort: 0 }),
    );
  });

  it("patchType：label / sort 越界前置校验 422（不进事务）", async () => {
    const { service, txRunner } = makeService();
    await expect(service.patchType(USER, "phrase", { label: "  " })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(service.patchType(USER, "phrase", { label: "标".repeat(13) })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    await expect(service.patchType(USER, "phrase", { sort: -1 })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(service.patchType(USER, "phrase", { sort: 100 })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(txRunner).not.toHaveBeenCalled();
  });

  it("patchType：类型不存在 404；updateType 0 行同样 404", async () => {
    const missing = makeService({ findTypeByKey: vi.fn(async () => null) });
    await expect(missing.service.patchType(USER, "slang", { label: "俚语" })).rejects.toMatchObject({ httpStatus: 404 });

    const raced = makeService({ updateType: vi.fn(async () => null) });
    await expect(raced.service.patchType(USER, "slang", { label: "俚语" })).rejects.toMatchObject({ httpStatus: 404 });
  });

  it("patchType：unhide 超可见上限 422；未到上限照常放行（hidden 类型才计数）", async () => {
    const hidden = makeType("idea", true);
    const capped = makeService({
      findTypeByKey: vi.fn(async () => hidden),
      countVisibleTypes: vi.fn(async () => 10),
    });
    await expect(capped.service.patchType(USER, "idea", { hidden: false })).rejects.toMatchObject({
      code: "BUSINESS_RULE",
    });
    expect(capped.dailyCapture.updateType).not.toHaveBeenCalled();

    const ok = makeService({ findTypeByKey: vi.fn(async () => hidden), countVisibleTypes: vi.fn(async () => 9) });
    await ok.service.patchType(USER, "idea", { hidden: false });
    expect(ok.dailyCapture.updateType).toHaveBeenCalledWith(USER, "idea", { hidden: false });
  });

  it("patchType：多字段同更 —— label 去空白、hint 空串清为 null、sort/hidden 透传", async () => {
    const { service, dailyCapture } = makeService({ findTypeByKey: vi.fn(async () => makeType("slang")) });
    await service.patchType(USER, "slang", { label: "  俚语（改）  ", absorptionHint: "   ", sort: 9, hidden: true });
    expect(dailyCapture.updateType).toHaveBeenCalledWith(USER, "slang", {
      label: "俚语（改）",
      absorption_hint: null,
      sort: 9,
      hidden: true,
    });
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
  return {
    service,
    dailyCapture,
    words,
    l3Context,
    wordbooks,
    reviews,
    outbox,
    txRunner: txRunner as unknown as ReturnType<typeof vi.fn>,
  };
}

describe("DailyCaptureService.getEvidencePack（agent 唯一读面的数据源）", () => {
  it("markdown + 结构化条目：label/hint/关联词释义与既有语境计数；未入库词跳过；无 meta/未注册类型回退 null", async () => {
    const listDay = vi.fn(async () => [
      makeRow({
        entry_date: "2026-10-10",
        entry_type: "sentence",
        content: "She harnessed her frustration.",
        meta: { wordSlugs: ["harness", "ghost"] },
      }),
      makeRow({
        entry_date: "2026-10-10",
        entry_type: "orphan",
        content: "无 meta 且类型未注册的条目",
        meta: null,
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
    expect(pack.entries[1].label).toBeNull(); // 类型未注册 → 回退 null（不是抛错）
    expect(pack.entries[1].absorption_hint).toBeNull();
    expect(pack.entries[1].words).toEqual([]);
    expect(words.findBySlug).toHaveBeenCalledTimes(2); // 只按已登记的 slug 查库（harness/ghost）
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

  it("action 白名单外的值 / 需词动作缺 wordSlug / 需词书动作缺 wordbookId：422 且不进事务", async () => {
    const { service, txRunner } = makeAbsorbService();
    await expect(
      service.absorbEntry({ userId: USER, id: "e-1", action: "boom" as never }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(
      service.absorbEntry({ userId: USER, id: "e-1", action: "enqueue_review", wordbookId: "wb-1" }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(
      service.absorbEntry({ userId: USER, id: "e-1", action: "add_word", wordSlug: "harness" }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(txRunner).not.toHaveBeenCalled();
  });

  it("条目不存在/已隐藏 404", async () => {
    const { service } = makeAbsorbService({ findEntry: vi.fn(async () => null) });
    await expect(service.absorbEntry({ userId: USER, id: "e-1", action: "none" })).rejects.toMatchObject({
      httpStatus: 404,
    });
  });

  it("add_word：入词书，回执目标 = wordbook（id = wordbookId）", async () => {
    const { service, wordbooks } = makeAbsorbService();
    const { receipt } = await service.absorbEntry({
      userId: USER, id: "e-1", action: "add_word", wordSlug: "harness", wordbookId: "wb-9",
    });
    expect(wordbooks.addWords).toHaveBeenCalledWith("wb-9", ["w-1"]);
    expect(receipt.target).toBe("wordbook");
    expect(receipt.id).toBe("wb-9");
  });

  it("并发重复采纳：appendAbsorption 0 行 → 读回终态按 deduped 幂等收尾；读回非终态/无行 404", async () => {
    const raced = makeAbsorbService({
      findEntry: vi.fn()
        .mockResolvedValueOnce(RAW_ENTRY)
        .mockResolvedValueOnce({ ...RAW_ENTRY, status: "absorbed" }),
      appendAbsorption: vi.fn(async () => null),
    });
    const done = await raced.service.absorbEntry({ userId: USER, id: "e-1", action: "none" });
    expect(done.receipt.deduped).toBe(true);
    expect(done.entry.status).toBe("absorbed");

    const archived = makeAbsorbService({
      findEntry: vi.fn()
        .mockResolvedValueOnce(RAW_ENTRY)
        .mockResolvedValueOnce({ ...RAW_ENTRY, status: "archived" }),
      appendAbsorption: vi.fn(async () => null),
    });
    const closed = await archived.service.absorbEntry({ userId: USER, id: "e-1", action: "none" });
    expect(closed.receipt.deduped).toBe(true);
    expect(closed.entry.status).toBe("archived");

    const lost = makeAbsorbService({
      findEntry: vi.fn().mockResolvedValueOnce(RAW_ENTRY).mockResolvedValueOnce(null),
      appendAbsorption: vi.fn(async () => null),
    });
    await expect(lost.service.absorbEntry({ userId: USER, id: "e-1", action: "none" })).rejects.toMatchObject({
      httpStatus: 404,
    });
  });
});
