/**
 * 6767 词条语料（`data/corpus/`）的完整性契约锁。
 *
 * ## 为什么锁这个
 *
 * `words.source_path` 指向 `data/corpus/` 下的文件。这批文件纳管进版本库的目的
 * 是**让词库可复现** —— 如果语料被改坏（少文件、少词条、词条名对不上库），
 * 重建词库就会静默产出与现在不同的结果，而没有任何人会发现。
 *
 * 纳管时的实测基准（2026-09-30）：
 *   264 个 .md / 4 个语料库 / 6767 个词条 / 去重后仍 6767（无重复）
 *   与 DB 逐库相等：L0_单词集合 867、L0_基础词 1487、L0_超纲词 967、L1_雅思词汇 3446
 *
 * 本套件只做**离线**校验（读文件、数词条），不连库 —— DB 侧的一致性由
 * `data/corpus/README.md` 里的自查 SQL 覆盖。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CORPUS = path.join(REPO_ROOT, "data", "corpus");

/** 语料里的词条以 markdown 二级标题标识：`## aboard` */
const HEADING = /^##\s+(\S.*?)\s*$/gm;

const EXPECTED = {
  "L0_单词集合": { files: 91, words: 867 },
  "L0_基础词": { files: 85, words: 1487 },
  "L0_超纲词": { files: 66, words: 967 },
  "L1_雅思词汇": { files: 22, words: 3446 },
} as const;
const TOTAL_FILES = 264;
const TOTAL_WORDS = 6767;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

function allMarkdown(): string[] {
  return walk(CORPUS).filter((p) => p.toLowerCase().endsWith(".md"));
}

/** 语料正文的 md（排除本目录自带的 README.md —— 它是纳管说明，不是语料） */
function corpusMarkdown(): string[] {
  return allMarkdown().filter((p) => path.relative(CORPUS, p) !== "README.md");
}

function wordsIn(file: string): string[] {
  const text = readFileSync(file, "utf8");
  return [...text.matchAll(HEADING)].map((m) => m[1]!.trim());
}

function wordsInDir(dir: string): string[] {
  const target = path.join(CORPUS, dir);
  return allMarkdown()
    .filter((p) => p.startsWith(target + path.sep))
    .flatMap(wordsIn);
}

describe("data/corpus 语料完整性", () => {
  it("共 264 个语料 .md 文件（不含本目录的 README）", () => {
    expect(corpusMarkdown().length).toBe(TOTAL_FILES);
  });

  it("除 264 语料 + README 外没有其他文件混入", () => {
    const everything = walk(CORPUS);
    const corpus = new Set(corpusMarkdown().map((p) => path.resolve(p)));
    const readme = path.resolve(CORPUS, "README.md");
    const extra = everything
      .filter((p) => !corpus.has(path.resolve(p)) && path.resolve(p) !== readme)
      .map((p) => path.relative(CORPUS, p));
    expect(extra).toEqual([]);
  });

  it("恰好 4 个语料库子目录", () => {
    const dirs = readdirSync(CORPUS, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    expect(dirs.sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it.each(Object.entries(EXPECTED))(
    "%s：%i 个文件 / %i 个词条",
    (lib, want) => {
      const target = path.join(CORPUS, lib);
      const files = corpusMarkdown().filter((p) => p.startsWith(target + path.sep));
      expect(files.length, `${lib} 的文件数变了`).toBe(want.files);
      expect(wordsInDir(lib).length, `${lib} 的词条数变了`).toBe(want.words);
    },
  );

  it(`合计 ${TOTAL_WORDS} 个词条`, () => {
    const total = Object.keys(EXPECTED).reduce((n, l) => n + wordsInDir(l).length, 0);
    expect(total).toBe(TOTAL_WORDS);
  });

  it("词条无重复（去重后仍 6767）", () => {
    const all = Object.keys(EXPECTED).flatMap(wordsInDir);
    const lower = all.map((w) => w.toLowerCase());
    const dups = lower.filter((w, i) => lower.indexOf(w) !== i);
    expect(dups, `重复词条：${[...new Set(dups)].slice(0, 10).join(", ")}`).toEqual([]);
    expect(new Set(lower).size).toBe(TOTAL_WORDS);
  });

  it("无编码损坏（不含 U+FFFD 替换字符）", () => {
    const bad = corpusMarkdown().filter((p) => {
      const buf = readFileSync(p);
      return buf.includes(Buffer.from("�", "utf8"));
    });
    expect(bad.map((p) => path.relative(CORPUS, p))).toEqual([]);
  });

  it("每个词条文件非空（防止占位文件混入）", () => {
    const empty = corpusMarkdown()
      .filter((p) => statSync(p).size === 0)
      .map((p) => path.relative(CORPUS, p));
    expect(empty).toEqual([]);
  });
});

describe("data/corpus README 记录了四份副本的关系", () => {
  const readme = readFileSync(path.join(CORPUS, "README.md"), "utf8");

  it("列出了四个语料库的词条数（便于对账）", () => {
    for (const [lib, n] of Object.entries(EXPECTED)) {
      expect(readme, `README 未记录 ${lib} 的词条数`).toContain(lib);
      expect(readme).toContain(String(n.words));
    }
  });

  it("写明了 l0-024 比库多 10 个词这一已知差异", () => {
    // 这条差异若被静默抹平，说明有人改过语料却没同步 DB —— 必须留痕。
    expect(readme).toContain("l0-024");
    expect(readme).toMatch(/多 10 个/);
  });

  it("写明了导入必须用 batch-import 角色（否则静默命中 0 行）", () => {
    expect(readme).toContain("BATCH_IMPORT_DATABASE_URL");
    expect(readme).toMatch(/静默命中 0 行/);
  });
});
