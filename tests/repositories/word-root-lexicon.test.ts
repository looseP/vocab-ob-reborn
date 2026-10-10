/**
 * 词根词典读取的**仓储级**测试（plaza 词根释义分支，2026-10-10）。
 *
 * 为什么必须是仓储级：本次改的是受管层`src/repositories/word.repository.ts`
 * （+32 行），而 `scripts/report-layered-coverage.ts` 把落在 function 区间内的变更行
 * 全算可执行行 —— service 层拿 `vi.fn()` fake 仓储（「我调用了它并传了对的参数」）
 * 覆盖不到真正的 JSON 解析与降级分支，PR #220 第三轮 CI 的 diff coverage
 * 就是这样被判红（67.13% < 85%）。**受管层改方法 ⇒ 必须补真仓储级单测。**
 *
 * 本文件钉住 `findRootLexiconByTokens` 的真实行为：
 *  1. SQL 走 `token = ANY($1::text[])` 批量取（不是 N+1）；
 *  2. `notes` 列的释义分支 JSON 能解析成 `senses`；
 *  3. **坏 JSON 降级为无分支**（不抛错）—— curated 数据唯一写入方是 seed 脚本，
 *     但仓储不能因为一行脏数据让整个广场页500；
 *  4. 形状不合格的分支被过滤掉（meaning 空/非字符串、words 非数组或为空）；
 *  5. `variants` 为 NULL 时回落空数组（别把 null 漏给前端）。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockPool } from "../helpers/mock-db";

const mock = createMockPool();
vi.mock("@/db/connection", () => ({
  getPool: () => mock.pool,
  getBatchImportPool: () => mock.pool,
  resetPool: vi.fn(),
  checkPoolHealth: vi.fn(),
}));

import { WordRepository } from "@/repositories/word.repository";

beforeEach(() => mock.reset());

function lexiconRow(overrides: Record<string, unknown> = {}) {
  return {
    token: "par",
    meaning_zh: "equal / together",
    variants: ["par", "peer"],
    notes: null,
    ...overrides,
  };
}

describe("WordRepository.findRootLexiconByTokens — 词根释义分支", () => {
  it("按token 批量取，一次查询而非 N+1", async () => {
    mock.setRows([lexiconRow({ token: "par" }), lexiconRow({ token: "bene" })]);
    const repo = new WordRepository();

    const result = await repo.findRootLexiconByTokens(["par", "bene"]);

    expect(result.size).toBe(2);
    // 只有一条 SQL —— 批量是这一层的核心收益（广场页要渲染几百个词根）
    expect(mock.lastQuery?.text).toContain("token = ANY($1::text[])");
    expect(mock.lastQuery?.params?.[0]).toEqual(["par", "bene"]);
  });

  it("空 token 数组直接返回空 Map，不发查询", async () => {
    const repo = new WordRepository();

    await expect(repo.findRootLexiconByTokens([])).resolves.toEqual(new Map());
    expect(mock.pool.query).not.toHaveBeenCalled();
  });

  it("notes 的释义分支 JSON 解析成 senses", async () => {
    mock.setRows([
      lexiconRow({
        token: "par",
        notes: JSON.stringify([
          { meaning: "相等", words: ["par", "peer"] },
          { meaning: "共同", words: ["partner"] },
        ]),
      }),
    ]);
    const repo = new WordRepository();

    const result = await repo.findRootLexiconByTokens(["par"]);

    expect(result.get("par")?.senses).toEqual([
      { meaning: "相等", words: ["par", "peer"] },
      { meaning: "共同", words: ["partner"] },
    ]);
  });

  it("notes 为空串/NULL 时senses 为空数组（不是 null）", async () => {
    mock.setRows([lexiconRow({ notes: null }), lexiconRow({ token: "bene", notes: "" })]);
    const repo = new WordRepository();

    const result = await repo.findRootLexiconByTokens(["par", "bene"]);

    expect(result.get("par")?.senses).toEqual([]);
    expect(result.get("bene")?.senses).toEqual([]);
  });

  it("坏 JSON 降级为无分支，不抛错（curated 数据也可能有脏行）", async () => {
    mock.setRows([lexiconRow({ notes: "{不是合法 JSON" })]);
    const repo = new WordRepository();

    const result = await repo.findRootLexiconByTokens(["par"]);

    // 关键：一行脏数据不能让整个广场页 500
    expect(result.get("par")?.senses).toEqual([]);
    expect(result.get("par")?.meaningZh).toBe("equal / together");
  });

  it("形状不合格的分支被过滤：meaning 空 / 非字符串 / words 空或非数组", async () => {
    mock.setRows([
      lexiconRow({
        notes: JSON.stringify([
          { meaning: "保留", words: ["keep"] },
          { meaning: "   ", words: ["blank"] },        // meaning 空白
          { meaning: "", words: ["empty"] },              // meaning 空串
          { words: ["noMeaning"] },                       // 缺meaning
          { meaning: "无词", words: [] },// words 空数组
          { meaning: "词非数组", words: "keep" },         // words 非数组
          null,                                           // null 项
        ]),
      }),
    ]);
    const repo = new WordRepository();

    const result = await repo.findRootLexiconByTokens(["par"]);

    expect(result.get("par")?.senses).toEqual([{ meaning: "保留", words: ["keep"] }]);
  });

  it("notes 是 JSON 但不是数组（如对象）⇒ 视为无分支", async () => {
    mock.setRows([lexiconRow({ notes: JSON.stringify({ meaning: "x", words: ["y"] }) })]);
    const repo = new WordRepository();

    const result = await repo.findRootLexiconByTokens(["par"]);

    expect(result.get("par")?.senses).toEqual([]);
  });

  it("variants 为 NULL 时回落空数组（别把 null 漏给前端）", async () => {
    mock.setRows([lexiconRow({ variants: null })]);
    const repo = new WordRepository();

    const result = await repo.findRootLexiconByTokens(["par"]);

    expect(result.get("par")?.variants).toEqual([]);
  });

  it("查无此token 时不进 Map（前端据此判断该词根未收录）", async () => {
    mock.setRows([]);
    const repo = new WordRepository();

    const result = await repo.findRootLexiconByTokens(["nonexistent"]);

    expect(result.has("nonexistent")).toBe(false);
    expect(result.size).toBe(0);
  });
});