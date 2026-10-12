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
    findBySlugs?: RepoSpy;
    listPromotedWordIds?: RepoSpy;
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
  // 词信号投影的两条读线（日视图专属；默认空集 → 条目无挂词时根本不触达）
  const words = { findBySlugs: overrides.findBySlugs ?? vi.fn(async () => []) };
  const l2Progress = {
    listPromotedWordIds: overrides.listPromotedWordIds ?? vi.fn(async () => []),
  };
  const repoFactory = () => ({ dailyCapture, words, l2Progress }) as unknown as IRepositories;
  const txRunner = vi.fn(
    async (fn: (tx: unknown) => Promise<unknown>, _options?: unknown) => fn({}),
  ) as unknown as typeof import("@/db/transaction").withTransaction;
  const service = new DailyCaptureService(txRunner, repoFactory);
  return {
    service,
    dailyCapture,
    words,
    l2Progress,
    txRunner: txRunner as unknown as ReturnType<typeof vi.fn>,
  };
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

describe("DailyCaptureService.getDay（读时词信号投影）", () => {
  /** 词行（信号只读 id/slug/definition_md/updated_at 四个字段）。 */
  const wordRow = (id: string, slug: string, definition: string) => ({
    id,
    slug,
    title: slug,
    lemma: slug,
    ipa: null,
    short_definition: definition === "" ? null : definition,
    definition_md: definition,
    updated_at: "2026-10-09T00:00:00Z",
  });
  const entries = () => [
    makeRow({
      entry_date: "2026-10-10",
      entry_type: "phrase",
      content: "harness the power of…",
      meta: { wordSlugs: ["harness", "wistful", "vanish", "harness"] },
    }),
    makeRow({ entry_date: "2026-10-10", entry_type: "sentence", content: "无挂词的句子", meta: null }),
  ];

  it("三态派生：ready（含 L2 晋升）/ stub（仅词形）/ gone（未命中回落）；重复 slug 去重", async () => {
    const findBySlugs = vi.fn(async () => [
      wordRow("w-1", "harness", "利用…的力量"),
      wordRow("w-2", "wistful", ""),
    ]);
    const listPromotedWordIds = vi.fn(async () => ["w-1"]);
    const { service, txRunner } = makeService({
      listDay: vi.fn(async () => entries()),
      findBySlugs,
      listPromotedWordIds,
    });

    const day = await service.getDay(USER, "2026-10-10");

    // 去重后一次批量取词；未命中的 vanish 由服务回落 gone（不报错）
    expect(findBySlugs).toHaveBeenCalledTimes(1);
    expect(findBySlugs).toHaveBeenCalledWith(["harness", "wistful", "vanish"]);
    expect(listPromotedWordIds).toHaveBeenCalledWith(USER, ["w-1", "w-2"]);
    // 1:1 反映 meta.wordSlugs 原样顺序（去重只发生在查库那一步；投影不重排、不删重）
    expect(day.entries[0].wordSignals).toEqual([
      { slug: "harness", state: "ready", hasDefinition: true, l2Promoted: true, updatedAt: "2026-10-09T00:00:00Z" },
      { slug: "wistful", state: "stub", hasDefinition: false, l2Promoted: false, updatedAt: "2026-10-09T00:00:00Z" },
      { slug: "vanish", state: "gone", hasDefinition: false, l2Promoted: false, updatedAt: null },
      { slug: "harness", state: "ready", hasDefinition: true, l2Promoted: true, updatedAt: "2026-10-09T00:00:00Z" },
    ]);
    expect(day.entries[1].wordSignals).toEqual([]);
    // 投影时刻：整响应一个时钟
    expect(day.observedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    // user_word_l2_progress 是 owner-RLS 表 → 派生必须在携带 actorId 的事务内
    expect(txRunner).toHaveBeenLastCalledWith(expect.any(Function), { actorId: USER });
  });

  it("无挂词条目：产空信号且不空查（两条读线均不触达）", async () => {
    const findBySlugs = vi.fn(async () => []);
    const listPromotedWordIds = vi.fn(async () => []);
    const { service } = makeService({
      listDay: vi.fn(async () => [
        makeRow({ entry_date: "2026-10-10", entry_type: "phrase", content: "无挂词", meta: null }),
      ]),
      findBySlugs,
      listPromotedWordIds,
    });

    const day = await service.getDay(USER, "2026-10-10");
    expect(day.entries[0].wordSignals).toEqual([]);
    expect(findBySlugs).not.toHaveBeenCalled();
    expect(listPromotedWordIds).not.toHaveBeenCalled();
  });

  it("信号是动态投影：不烙进静态日文件（同输入恒同输出）", async () => {
    const { service } = makeService({
      listDay: vi.fn(async () => entries()),
      findBySlugs: vi.fn(async () => [wordRow("w-1", "harness", "利用…的力量")]),
      listPromotedWordIds: vi.fn(async () => ["w-1"]),
    });

    const { markdown } = await service.getDayFile(USER, "2026-10-10");
    expect(markdown).toContain("harness the power of…");
    expect(markdown).not.toContain("待补释义");
    expect(markdown).not.toContain("已补释义");
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

  it("createType：key 冲突 409（先 seed 再查重）；可见上限 11 触发 422", async () => {
    const conflict = makeService({ findTypeByKey: vi.fn(async () => makeType("slang")) });
    await expect(conflict.service.createType(USER, { typeKey: "slang", label: "俚语" })).rejects.toMatchObject({
      httpStatus: 409,
    });
    expect(conflict.dailyCapture.ensureDefaultTypes).toHaveBeenCalledWith(USER);
    expect(conflict.dailyCapture.insertType).not.toHaveBeenCalled();

    // 7 内置 + 4 自定义席位 = 11（word 入 seed 后口径修订）
    const capped = makeService({ countVisibleTypes: vi.fn(async () => 11) });
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
    // 上限 11 = 7 内置 + 4 自定义席位（word 入 seed 后口径修订）
    const capped = makeService({
      findTypeByKey: vi.fn(async () => hidden),
      countVisibleTypes: vi.fn(async () => 11),
    });
    await expect(capped.service.patchType(USER, "idea", { hidden: false })).rejects.toMatchObject({
      code: "BUSINESS_RULE",
    });
    expect(capped.dailyCapture.updateType).not.toHaveBeenCalled();

    const ok = makeService({ findTypeByKey: vi.fn(async () => hidden), countVisibleTypes: vi.fn(async () => 10) });
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
  definition_md: "利用…的力量",
  updated_at: "2026-10-09T00:00:00Z",
};

const RAW_ENTRY = makeRow({ entry_date: "2026-10-10", entry_type: "sentence", content: "She harnessed her frustration.", meta: null });

/** M3 专用 harness：full repos（words/l3Context/wordbooks/reviews/outbox）。 */
function makeAbsorbService(overrides: {
  findEntry?: ReturnType<typeof vi.fn>;
  findBySlug?: ReturnType<typeof vi.fn>;
  findBySlugs?: ReturnType<typeof vi.fn>;
  listPromotedWordIds?: ReturnType<typeof vi.fn>;
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
    // 证据包 / 日视图的词读线（精确 slug 批量）
    findBySlugs: overrides.findBySlugs ?? vi.fn(async () => [WORD]),
    insertMany: vi.fn(async () => undefined),
  };
  const l2Progress = {
    listPromotedWordIds: overrides.listPromotedWordIds ?? vi.fn(async () => []),
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
  const repoFactory = () =>
    ({ dailyCapture, words, l2Progress, l3Context, wordbooks, reviews, outbox }) as unknown as IRepositories;
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
      findBySlugs: vi.fn(async (slugs: string[]) => (slugs.includes("harness") ? [WORD] : [])),
      listPromotedWordIds: vi.fn(async () => ["w-1"]),
    });
    (l3Context.countWordOccurrences as ReturnType<typeof vi.fn>).mockResolvedValue(2);

    const pack = await service.getEvidencePack(USER, "2026-10-10");
    expect(pack.version).toBe(1);
    expect(pack.markdown).toContain("She harnessed her frustration.");
    expect(pack.entries[0].label).toBe("sentence");
    expect(pack.entries[0].absorption_hint).toBeNull();
    expect(pack.entries[0].words).toHaveLength(1); // ghost 未入库 → 跳过
    expect(pack.entries[0].words[0].existing_context_count).toBe(2);
    // 词信号随词条同出（与日视图同一份投影；此处 slug 已精确命中，state 只 stub|ready）
    expect(pack.entries[0].words[0].signal).toEqual({
      slug: "harness",
      state: "ready",
      hasDefinition: true,
      l2Promoted: true,
      updatedAt: "2026-10-09T00:00:00Z",
    });
    expect(pack.entries[1].label).toBeNull(); // 类型未注册 → 回退 null（不是抛错）
    expect(pack.entries[1].absorption_hint).toBeNull();
    expect(pack.entries[1].words).toEqual([]);
    // 只按已登记的 slug 精确批量查库（harness/ghost），不再逐词 findBySlug
    expect(words.findBySlugs).toHaveBeenCalledWith(["harness", "ghost"]);
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

  it("enqueue_review：inserted → 建卡回执；duplicate → deduped（都不再补 outbox）", async () => {
    // 2026-10-12：原断言「inserted → 补一条 outbox」。那条 review.card.enqueued.v1
    // 事件没有消费者（worker 只处理 review.answer.recorded.v1）⇒ 每建一张卡进死信
    // 并把 critical 告警 VocabOutboxDeadLetter 永久点亮（线上实测 522 条）。
    // 建卡本身就是同事务权威写入，故事件已删；回执仍照常产出。
    const inserted = makeAbsorbService({
      insertNewCard: vi.fn(async () => ({ status: "inserted", progressId: "p-1" })),
    });
    const r1 = await inserted.service.absorbEntry({
      userId: USER, id: "e-1", action: "enqueue_review", wordSlug: "harness", wordbookId: "wb-1",
    });
    expect(inserted.reviews.insertNewCard).toHaveBeenCalledWith({
      userId: USER, wordId: "w-1", wordbookId: "wb-1", desiredRetention: "0.850",
    });
    expect(inserted.outbox.enqueue).not.toHaveBeenCalled();
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
