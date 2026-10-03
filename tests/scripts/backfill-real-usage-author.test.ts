/**
 * `scripts/backfill-real-usage-author.ts` 的纯逻辑回归锁。
 *
 * 不连库：只测 `validateManifest` / `planAuthorBackfill` / `extractRealUsage` 两个纯函数。
 * 之所以值得锁 —— 这个脚本要往生产词库写**署名**，而署名错比署名缺更糟：
 *   1. 清单与库不同步时，把 A 句的作者写到 B 句上（静默的错署名）
 *   2. 抓不到作者的条目被填上占位符（如 "unknown"）冒充已署名
 *   3. 重复执行把已有 author 覆盖成别的东西（幂等性破坏）
 *   4. 库中该条目已有 author 时无法识别「已写入」，每次重跑都报改动
 *   5. `examples` 是 jsonb，形状不受类型系统保护 —— 缺 verified / real_usage 非数组
 *      时不能抛错，要降级成「该词没有 real_usage」
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  extractRealUsage,
  planAuthorBackfill,
  reportLine,
  validateManifest,
  type ExistingRealUsage,
  type Manifest,
  type ManifestEntry,
} from "../../scripts/backfill-real-usage-author";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SHIPPED_MANIFEST = path.join(
  REPO_ROOT,
  "data",
  "real-usage-authors",
  "2026-10-03.json",
);

function entry(over: Partial<ManifestEntry> = {}): ManifestEntry {
  return {
    slug: "accuse",
    sentence_url: "https://tatoeba.org/en/sentences/show/13855315",
    author: "someone",
    license: "CC BY 2.0 FR",
    fetched_at: "2026-10-03T00:00:00.000Z",
    status: "ok",
    ...over,
  };
}

function manifestOf(entries: ManifestEntry[]): Manifest {
  return { entries };
}

function rowsOf(...rows: ExistingRealUsage[]): ExistingRealUsage[] {
  return rows;
}

describe("validateManifest（清单自身校验）", () => {
  it("空清单直接判不合格", () => {
    expect(validateManifest({ entries: [] })).toEqual(["清单 entries 为空"]);
  });

  it("缺 slug / sentence_url 判不合格", () => {
    const problems = validateManifest(
      manifestOf([entry({ slug: "", sentence_url: "" })]),
    );
    expect(problems.some((p) => p.includes("slug 为空"))).toBe(true);
    expect(problems.some((p) => p.includes("sentence_url 为空"))).toBe(true);
  });

  it("author 既不是非空字符串也不是 null → 判不合格（不许占位符）", () => {
    const problems = validateManifest(
      manifestOf([entry({ author: "" as unknown as string })]),
    );
    expect(problems.some((p) => p.includes("既不是非空字符串也不是 null"))).toBe(true);
  });

  it("有 author 但缺 fetched_at / license → 判不合格（无从复核）", () => {
    const problems = validateManifest(
      manifestOf([entry({ fetched_at: null, license: null })]),
    );
    expect(problems.some((p) => p.includes("缺 fetched_at"))).toBe(true);
    expect(problems.some((p) => p.includes("缺 license"))).toBe(true);
  });

  it("author 为 null 的待补条目是合法的（允许缺 fetched_at）", () => {
    expect(
      validateManifest(
        manifestOf([
          entry({ author: null, status: "missing", reason: "http-404", fetched_at: null, license: "CC BY 2.0 FR" }),
        ]),
      ),
    ).toEqual([]);
  });

  it("slug 重复判不合格", () => {
    const problems = validateManifest(manifestOf([entry(), entry()]));
    expect(problems.some((p) => p.includes("slug 重复"))).toBe(true);
  });
});

describe("planAuthorBackfill（清单 + 库现状 → 执行计划）", () => {
  it("库中无 author → set-author", () => {
    const plan = planAuthorBackfill(
      manifestOf([entry()]),
      rowsOf({ slug: "accuse", items: [{ url: entry().sentence_url, author: null }] }),
    );
    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0]).toMatchObject({ slug: "accuse", author: "someone", currentAuthor: null });
    expect(plan.alreadyPresent).toHaveLength(0);
  });

  it("库中 author 与清单一致 → already-present（幂等的判据）", () => {
    const plan = planAuthorBackfill(
      manifestOf([entry()]),
      rowsOf({ slug: "accuse", items: [{ url: entry().sentence_url, author: "someone" }] }),
    );
    expect(plan.updates).toHaveLength(0);
    expect(plan.alreadyPresent).toHaveLength(1);
  });

  it("库中 author 与清单不同 → set-author（纠正错署名）", () => {
    const plan = planAuthorBackfill(
      manifestOf([entry()]),
      rowsOf({ slug: "accuse", items: [{ url: entry().sentence_url, author: "wrong-person" }] }),
    );
    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0].currentAuthor).toBe("wrong-person");
  });

  it("清单 author 为 null → skip-no-author，不进 updates（不填占位符）", () => {
    const plan = planAuthorBackfill(
      manifestOf([entry({ author: null, status: "missing" })]),
      rowsOf({ slug: "accuse", items: [{ url: entry().sentence_url, author: null }] }),
    );
    expect(plan.updates).toHaveLength(0);
    expect(plan.skippedNoAuthor).toHaveLength(1);
    expect(plan.skippedNoAuthor[0].author).toBeNull();
  });

  it("slug 不在库中 → missingSlugs 非空（调用方据此整体拒绝）", () => {
    const plan = planAuthorBackfill(manifestOf([entry()]), rowsOf());
    expect(plan.missingSlugs).toEqual(["accuse"]);
    expect(plan.updates).toHaveLength(0);
  });

  it("sentence_url 与该词 real_usage 对不上 → unmatchedUrls 非空（防错署名）", () => {
    const plan = planAuthorBackfill(
      manifestOf([entry()]),
      rowsOf({ slug: "accuse", items: [{ url: "https://tatoeba.org/en/sentences/show/999", author: null }] }),
    );
    expect(plan.unmatchedUrls).toHaveLength(1);
    expect(plan.updates).toHaveLength(0);
  });

  it("同一词有多条 real_usage 时按 url 精确命中，不串条", () => {
    const urlA = "https://tatoeba.org/en/sentences/show/111";
    const urlB = "https://tatoeba.org/en/sentences/show/222";
    const plan = planAuthorBackfill(
      manifestOf([entry({ sentence_url: urlB, author: "author-b" })]),
      rowsOf({
        slug: "accuse",
        items: [
          { url: urlA, author: "author-a" },
          { url: urlB, author: null },
        ],
      }),
    );
    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0].sentenceUrl).toBe(urlB);
    expect(plan.updates[0].currentAuthor).toBeNull();
  });

  it("CC BY 2.0 FR 的补齐口径独立统计（「补到 N / 79」）", () => {
    const plan = planAuthorBackfill(
      manifestOf([
        entry({ slug: "a", sentence_url: "u1", license: "CC BY 2.0 FR" }),
        entry({ slug: "b", sentence_url: "u2", license: "CC BY 2.0 FR", author: null, status: "missing" }),
        entry({ slug: "c", sentence_url: "u3", license: "CC0 1.0" }),
      ]),
      rowsOf(
        { slug: "a", items: [{ url: "u1", author: null }] },
        { slug: "b", items: [{ url: "u2", author: null }] },
        { slug: "c", items: [{ url: "u3", author: null }] },
      ),
    );
    expect(plan.ccBy).toEqual({ total: 2, resolved: 1, missing: 1 });
    expect(reportLine(plan)).toBe(
      "补到 1 / 2，缺 1（口径：CC BY 2.0 FR 条目；另有 CC0 1.0 等无署名义务条目见上）",
    );
  });
});

describe("extractRealUsage（jsonb 降级，不抛错）", () => {
  it("正常形状抽出 url/author", () => {
    const out = extractRealUsage("x", [
      { verified: { real_usage: [{ url: "u", author: "a", text: "t" }] } },
    ]);
    expect(out).toEqual({ slug: "x", items: [{ url: "u", author: "a" }] });
  });

  it("无 author 键 → author 为 null（不是 undefined）", () => {
    const out = extractRealUsage("x", [{ verified: { real_usage: [{ url: "u" }] } }]);
    expect(out.items[0].author).toBeNull();
  });

  it("空 author 串视为缺失", () => {
    const out = extractRealUsage("x", [{ verified: { real_usage: [{ url: "u", author: "  " }] } }]);
    expect(out.items[0].author).toBeNull();
  });

  it.each([
    ["examples 非数组", {}],
    ["examples 为空数组", []],
    ["首条非对象", ["nope"]],
    ["无 verified", [{ text: "t" }]],
    ["verified 非对象", [{ verified: "nope" }]],
    ["real_usage 非数组", [{ verified: { real_usage: {} } }]],
  ])("%s → 降级为空 items，不抛错", (_label, examples) => {
    expect(extractRealUsage("x", examples)).toEqual({ slug: "x", items: [] });
  });
});

describe("随仓库发布的清单 data/real-usage-authors/2026-10-03.json", () => {
  const manifest = JSON.parse(readFileSync(SHIPPED_MANIFEST, "utf8")) as Manifest;

  it("自身校验通过", () => {
    expect(validateManifest(manifest)).toEqual([]);
  });

  it("81 条、81 个 slug（每词一条 real_usage）", () => {
    expect(manifest.entries).toHaveLength(81);
    expect(new Set(manifest.entries.map((e) => e.slug)).size).toBe(81);
  });

  it("79 条 CC BY 2.0 FR + 2 条 CC0 1.0（与库内许可分布一致）", () => {
    const byLicense = new Map<string, number>();
    for (const e of manifest.entries) {
      byLicense.set(e.license ?? "(null)", (byLicense.get(e.license ?? "(null)") ?? 0) + 1);
    }
    expect(byLicense.get("CC BY 2.0 FR")).toBe(79);
    expect(byLicense.get("CC0 1.0")).toBe(2);
  });

  it("每条 sentence_url 都指向 Tatoeba 句子页", () => {
    for (const e of manifest.entries) {
      expect(e.sentence_url, `${e.slug} 的 URL`).toMatch(
        /^https:\/\/tatoeba\.org\/en\/sentences\/show\/\d+$/,
      );
    }
  });

  it("每条都带 fetched_at（可复核「哪次抓的」）", () => {
    for (const e of manifest.entries) {
      expect(e.fetched_at, `${e.slug} 缺 fetched_at`).toBeTruthy();
    }
  });
});
