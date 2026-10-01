/**
 * `scripts/backfill-content-hash.ts` 的回归锁。
 *
 * ## 为什么锁这个
 *
 * 这个脚本曾在 main 上静默失败：它用 `getPool()`（`vocab_app` 角色），而迁移 0025
 * 给该角色建的 UPDATE policy 只放行 stub 行（`USING (definition_md = '' ...)`）。
 * 词库内容行全都有真实释义，于是每次 UPDATE 都**命中 0 行且不报错** —— 脚本一路
 * 打印「Done. Total: 6767 words backfilled.」，库里 6767 条 hash 实际全是 NULL。
 *
 * 没有测试会发现这件事，因为：
 *   - `tests/db/content-hash.test.ts` 只测 `computeL1Hash` 等纯函数，不碰连接
 *   - 「UPDATE 影响 0 行」不抛异常，`rowCount` 不查就看不出
 *
 * 本套件钉三件事：
 *   1. **必须用 batch-import 池**（纯文本断言，不连库）
 *   2. `computeHashes` 纯计算部分可用且确定
 *   3. rowCount 校验与写后自检这两道防线**必须在**（防止有人图省事删掉）
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { computeHashes } from "../../scripts/backfill-content-hash";

const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "scripts",
  "backfill-content-hash.ts",
);
const source = readFileSync(SCRIPT, "utf8");

describe("backfill-content-hash 的连接身份（防静默 0 行）", () => {
  // 这是本套件最重要的一条。删掉它 = 允许脚本退回 vocab_app = 静默失败重来。
  it("使用 getBatchImportPool，不用 getPool", () => {
    expect(source).toContain("getBatchImportPool");
    expect(
      source.includes("const pool = getPool()"),
      "脚本又用回 getPool() 了 —— vocab_app 的 UPDATE policy 只放行 stub 行，"
        + "改词库内容行会静默命中 0 行",
    ).toBe(false);
  });

  it("不再从 connection 导入 getPool", () => {
    expect(source).not.toMatch(/import\s*\{[^}]*\bgetPool\b[^}]*\}\s*from\s*"[^"]*connection"/);
  });

  it("文件头写明了 0025 policy 这个坑的来龙去脉", () => {
    expect(source).toContain("0025");
    expect(source).toMatch(/definition_md\s*=\s*''/);
    expect(source).toMatch(/命中 0 行/);
  });
});

describe("backfill-content-hash 的两道防线", () => {
  // 不校验 rowCount → 重演「打印 Done 但没写」。这是静默失败的根因。
  it("校验 UPDATE 的 rowCount", () => {
    expect(source).toContain("rowCount");
    expect(source).toMatch(/rowCount\s*!==\s*1/);
  });

  it("有写后自检（重新查库确认不再有 NULL）", () => {
    expect(source).toMatch(/still_null/);
    expect(source).toMatch(/写后自检/);
  });

  it("失败时 exit 1，不吞错误", () => {
    expect(source).toMatch(/process\.exit\(1\)/);
  });
});

describe("computeHashes（纯计算部分）", () => {
  const word = {
    id: "w-1",
    definition_md: "**adj.** 大量存在",
    core_definitions: [{ partOfSpeech: "adj.", senses: [{ def: "大量存在" }] }],
    prototype_text: "水从容器中溢出",
    metadata: { morphology: { raw: "" }, mnemonic: {}, semantic_chain: {} },
    collocations: [],
    corpus_items: [],
    synonym_items: [],
    antonym_items: [],
  };

  it("产出三个 64 位十六进制串", () => {
    const h = computeHashes(word);
    for (const v of [h.l1, h.l2, h.full]) {
      expect(v).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("同输入同输出（确定性）", () => {
    expect(computeHashes(word)).toEqual(computeHashes(word));
  });

  it("L1 变更只影响 l1 与 full，不影响 l2", () => {
    const h = computeHashes(word);
    const changed = computeHashes({ ...word, definition_md: "改了 L1 内容" });
    expect(changed.l1).not.toBe(h.l1);
    expect(changed.l2).toBe(h.l2);
    expect(changed.full).not.toBe(h.full);
  });

  it("L2 变更不影响 l1（L1/L2 分层隔离）", () => {
    const h = computeHashes(word);
    const changedL2 = computeHashes({
      ...word,
      collocations: [{ phrase: "different", gloss: "x" }],
    });
    expect(changedL2.l1).toBe(h.l1);
    expect(changedL2.l2).not.toBe(h.l2);
    expect(changedL2.full).not.toBe(h.full);
  });

  it("null / undefined 字段不炸（库里很多列可空）", () => {
    expect(() =>
      computeHashes({
        id: "w-2",
        definition_md: null,
        core_definitions: null,
        prototype_text: null,
        metadata: null,
        collocations: null,
        corpus_items: null,
        synonym_items: null,
        antonym_items: null,
      }),
    ).not.toThrow();
  });
});
