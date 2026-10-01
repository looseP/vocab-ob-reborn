/**
 * `scripts/backfill-content-hash.ts` 与 `scripts/backfill-word-pinyin.ts` 的回归锁。
 *
 * ## 为什么锁这个
 *
 * 这两个脚本曾在 main 上以「看起来成功」的方式静默失败：用 `getPool()`（`vocab_app`
 * 角色），而迁移 0025 给该角色建的 UPDATE policy 只放行 stub 行
 * （`USING (definition_md = '' ...)`）。词库内容行全都有真实释义，于是每次 UPDATE
 * 都**命中 0 行且不报错** —— Postgres 把它当「行对当前角色不可见」。
 *
 * content-hash 那个脚本一路打印「Done. Total: 6767 words backfilled.」，
 * 而库里 6767 条 l1_content_hash 全是 NULL。
 * （word-pinyin 的数据是 0025 之前跑出来的，侥幸没中招，但形状完全一样。）
 *
 * 0025 迁移的注释已经写明约定「writes go through the dedicated batch-import role」，
 * 脚本违反的正是这条 —— 而没有任何编译期/运行期机制会阻止它再违反一次。
 *
 * 没有测试会发现这件事，因为：
 *   - `tests/db/content-hash.test.ts` 只测 `computeL1Hash` 等纯函数，不碰连接
 *   - 「UPDATE 影响 0 行」不抛异常，`rowCount` 不查就看不出
 *
 * 本套件钉四件事：
 *   1. 必须用 batch-import 池 —— **按「是否调用了 getPool」判定，不按字符串形态**
 *   2. 两道防线（rowCount 校验 + 写后自检）必须在，且自检要覆盖全部写入的列
 *   3. 文件头写明 0025 policy 的来龙去脉（否则后人看不懂为什么换角色）
 *   4. 纯计算部分 `computeHashes` 可用、确定、分层隔离
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { computeHashes } from "../../scripts/backfill-content-hash";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

const CONTENT_HASH = "scripts/backfill-content-hash.ts";
const PINYIN = "scripts/backfill-word-pinyin.ts";

/**
 * 判定「是否用了应用角色」，用 AST 之外的可靠手段：剥掉注释与字符串字面量后，
 * 查找 `getPool` 这个标识符。上一版断言 `const pool = getPool()` 这个字面形态，
 * 写成 `const p: Pool = getPool()` 就绕过了 —— 锁形不锁义，等于没锁。
 */
function usesAppPool(src: string): boolean {
  const stripped = src
    .replace(/\/\*[\s\S]*?\*\//g, "") // 块注释
    .replace(/^\s*\/\/.*$/gm, "") // 行注释
    .replace(/"(?:[^"\\]|\\.)*"/g, '""') // 双引号字符串
    .replace(/'(?:[^'\\]|\\.)*'/g, "''") // 单引号字符串
    .replace(/`(?:[^`\\]|\\.)*`/g, "``"); // 模板字符串
  return /\bgetPool\b/.test(stripped);
}

/** 哪些列被 UPDATE 了 —— 自检必须覆盖到每一列，否则某列写失败会被漏报。 */
function updatedColumns(src: string): string[] {
  const m = src.match(/SET\s+([\s\S]*?)\s+WHERE\s+id\s*=/i);
  if (!m) return [];
  return (m[1].match(/(\w+)\s*=\s*\$/g) ?? []).map((s) => s.replace(/\s*=\s*\$/, "").trim());
}

describe.each([
  ["backfill-content-hash", CONTENT_HASH],
  ["backfill-word-pinyin", PINYIN],
])("%s：连接身份", (_name, rel) => {
  const src = read(rel);

  it("使用 getBatchImportPool", () => {
    expect(src).toContain("getBatchImportPool");
  });

  // 本套件最重要的一条。删掉它 = 允许脚本退回 vocab_app = 静默失败重来。
  it("不调用 getPool（按标识符判定，不按字面形态）", () => {
    expect(
      usesAppPool(src),
      `${rel} 又用回 getPool() 了 —— vocab_app 的 UPDATE policy 只放行 stub 行`
        + "（definition_md=''），改词库内容行会静默命中 0 行且不报错",
    ).toBe(false);
  });

  it("从 connection 只导入 batch-import 池", () => {
    expect(src).not.toMatch(
      /import\s*\{[^}]*\bgetPool\b[^}]*\}\s*from\s*["'][^"']*connection["']/,
    );
  });
});

describe.each([
  ["backfill-content-hash", CONTENT_HASH],
  ["backfill-word-pinyin", PINYIN],
])("%s：两道防线", (_name, rel) => {
  const src = read(rel);

  // 不校验 rowCount → 重演「打印 Done 但没写」。这是静默失败的根因。
  it("校验 UPDATE 的 rowCount", () => {
    expect(src).toMatch(/rowCount\s*!==\s*1/);
  });

  it("零行时抛错并 exit 1，不吞错误", () => {
    expect(src).toMatch(/throw new Error/);
    expect(src).toMatch(/process\.exit\(1\)/);
  });

  it("有写后自检（重新查库确认，不只信「跑完了」）", () => {
    expect(src).toMatch(/写后自检/);
    // 断言自检确实在数 NULL，且数的是「表里还有多少行没被写」。
    // 不锁具体变量名 —— 那是实现细节，改个名就误报（这个断言已经误报过一次）。
    expect(src).toMatch(/count\(\*\)[\s\S]{0,80}?FILTER\s*\(\s*WHERE/i);
    expect(src).toMatch(/FROM\s+words/i);
  });

  // 自检必须覆盖 UPDATE 写到的每一列。只查 l1 的话，l2/full 写失败会漏报。
  it("写后自检覆盖全部被写入的列", () => {
    const cols = updatedColumns(src);
    expect(cols.length).toBeGreaterThan(0);
    for (const c of cols) {
      expect(
        src,
        `自检没覆盖 ${c}：它被 UPDATE 写了，但写后自检没查它是否仍为 NULL`,
      ).toContain(c);
    }
  });
});

describe("backfill-content-hash 的类型边界", () => {
  const src = read(CONTENT_HASH);

  // WordForHashing 之前不导出，调用方只能用 `as never` —— 代价是字段名写错也不报错。
  it("WordForHashing 已导出（这样不必用 as never 绕过）", () => {
    const hashSrc = read("src/db/content-hash.ts");
    expect(hashSrc).toMatch(/export interface WordForHashing/);
    expect(src).toMatch(/type WordForHashing/);
  });

  it("computeHashes 不用 as never 绕过类型检查", () => {
    expect(src).not.toMatch(/compute(L1|L2|Full)Hash\(\s*\w+\s+as\s+never/);
  });
});

describe("文件头记录了 0025 policy 这个坑", () => {
  // 没有这段，后人看到换角色会以为是多余的，直接改回去。
  it.each([CONTENT_HASH, PINYIN])("%s 写明来龙去脉", (rel) => {
    const src = read(rel);
    expect(src).toContain("0025");
    expect(src).toMatch(/definition_md\s*=\s*''/);
    expect(src).toMatch(/命中 0 行/);
    expect(src).toMatch(/batch-import|vocab_batch_import/);
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
    const changed = computeHashes({
      ...word,
      collocations: [{ phrase: "different", gloss: "x" }],
    });
    expect(changed.l1).toBe(h.l1);
    expect(changed.l2).not.toBe(h.l2);
    expect(changed.full).not.toBe(h.full);
  });

  it("full 依赖 l1 与 l2 两者", () => {
    const h = computeHashes(word);
    const bothChanged = computeHashes({
      ...word,
      definition_md: "改了",
      collocations: [{ phrase: "different", gloss: "x" }],
    });
    expect(bothChanged.l1).not.toBe(h.l1);
    expect(bothChanged.l2).not.toBe(h.l2);
    expect(bothChanged.full).not.toBe(h.full);
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