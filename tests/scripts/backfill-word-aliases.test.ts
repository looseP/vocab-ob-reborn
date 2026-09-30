/**
 * `scripts/backfill-word-aliases.ts` 的纯逻辑回归锁。
 *
 * 不连库：只测 `validateManifest` / `planAliasBackfill` 两个纯函数。
 * 之所以值得锁 —— 这个脚本要往 6767 词的生产词库里写数据，而它最容易出错的
 * 地方全是「以为不会发生但真会发生」的那几类：
 *   1. 同一个 lemma 有多个待补形式时，后一条把前一条挤掉（丢数据）
 *   2. aliases 为空数组（补登前 1712 个词条是这个状态）时拼出 `[undefined]`
 *   3. 大小写混存导致重复登记（库里本来就有 `Marxists` / `Realtor` 这类）
 *   4. 基词在库中不存在时写出一批孤儿 aliases
 *   5. 所有格形式（today's）被当成复数归一，撇号被吃掉
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  planAliasBackfill,
  validateManifest,
  type InflectionKind,
  type Manifest,
} from "../../scripts/backfill-word-aliases";

function manifestOf(entries: Manifest["entries"]): Manifest {
  return { entries };
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SHIPPED_MANIFEST = path.join(REPO_ROOT, "data", "word-aliases", "2025-en2-inflections.json");

describe("随仓库发布的清单 data/word-aliases/2025-en2-inflections.json", () => {
  const manifest = JSON.parse(readFileSync(SHIPPED_MANIFEST, "utf8")) as Manifest;

  it("自身校验通过", () => {
    expect(validateManifest(manifest)).toEqual([]);
  });

  it("26 条、25 个基词（introduce 出现两次：过去式 + 动名词）", () => {
    expect(manifest.entries).toHaveLength(26);
    expect(new Set(manifest.entries.map((e) => e.lemma)).size).toBe(25);
  });

  it("kind 只取约定的五类", () => {
    const allowed = new Set<InflectionKind>([
      "plural",
      "past",
      "gerund",
      "third-person",
      "possessive",
    ]);
    for (const e of manifest.entries) {
      expect(allowed.has(e.kind), `${e.form} 的 kind=${e.kind} 不在约定集合内`).toBe(true);
    }
  });

  it("所有格形式按带撇号的字面量登记", () => {
    const possessive = manifest.entries.filter((e) => e.kind === "possessive");
    expect(possessive).toEqual([{ form: "today's", lemma: "today", kind: "possessive" }]);
  });

  it("meta 记录了覆盖率前后对比与未做的部分", () => {
    const meta = manifest.meta as Record<string, string>;
    expect(meta.coverageBefore).toContain("79.4%");
    expect(meta.coverageAfter).toContain("81.5%");
    // 「没做什么」必须留在文件里，否则下一个人会以为洞已经补完了。
    expect(meta.notDone).toContain("1491");
  });

  // 回归锁：1712 是**补登前**的口径，补登后是 1698（26 个形式落在 15 个
  // 原为空的词条上）。曾把 1712 写成当前状态而被误读 —— 两个时点都必须写明。
  it("meta 的空 aliases 数字同时标明补登前/后两个时点", () => {
    const meta = manifest.meta as Record<string, string>;
    expect(meta.notDone).toContain("1712");
    expect(meta.notDone).toContain("1698");
    expect(meta.notDone).toContain("补登前");
    expect(meta.notDone).toContain("补登后");
  });
});

describe("validateManifest", () => {
  it("接受合法的清单", () => {
    expect(
      validateManifest(
        manifestOf([
          { form: "gaps", lemma: "gap", kind: "plural" },
          { form: "today's", lemma: "today", kind: "possessive" },
        ]),
      ),
    ).toEqual([]);
  });

  it("拒绝空清单", () => {
    expect(validateManifest(manifestOf([]))).toEqual(["清单 entries 为空"]);
  });

  it("拒绝形式与基词相同（补登无意义）", () => {
    const problems = validateManifest(manifestOf([{ form: "gap", lemma: "gap", kind: "plural" }]));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("形式与基词相同");
  });

  it("大小写不同也算相同", () => {
    const problems = validateManifest(manifestOf([{ form: "Gap", lemma: "gap", kind: "plural" }]));
    expect(problems[0]).toContain("形式与基词相同");
  });

  it("拒绝重复形式", () => {
    const problems = validateManifest(
      manifestOf([
        { form: "gaps", lemma: "gap", kind: "plural" },
        { form: "gaps", lemma: "gape", kind: "plural" },
      ]),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("形式重复");
  });

  it("拒绝空串 form / lemma", () => {
    const problems = validateManifest(
      manifestOf([{ form: "  ", lemma: "gap", kind: "plural" }]),
    );
    expect(problems.some((p) => p.includes("form 为空"))).toBe(true);
  });
});

describe("planAliasBackfill", () => {
  it("基词缺失时列入 missingLemmas，不产生任何写入计划", () => {
    const plan = planAliasBackfill(
      manifestOf([
        { form: "gaps", lemma: "gap", kind: "plural" },
        { form: "hospitals", lemma: "hospital", kind: "plural" },
      ]),
      [{ lemma: "gap", aliases: [] }],
    );
    expect(plan.missingLemmas).toEqual(["hospital"]);
    expect(plan.lemmaUpdates).toHaveLength(1);
    expect(plan.lemmaUpdates[0].lemma).toBe("gap");
  });

  it("同一 lemma 的多个形式累积进同一份终态，不互相覆盖", () => {
    const plan = planAliasBackfill(
      manifestOf([
        { form: "introduced", lemma: "introduce", kind: "past" },
        { form: "introducing", lemma: "introduce", kind: "gerund" },
      ]),
      [{ lemma: "introduce", aliases: [] }],
    );
    expect(plan.lemmaUpdates).toHaveLength(1);
    expect(plan.lemmaUpdates[0].after).toEqual(["introduced", "introducing"]);
    expect(plan.appends).toHaveLength(2);
  });

  it("累积时保留原有 aliases 且不改动其大小写", () => {
    const plan = planAliasBackfill(
      manifestOf([{ form: "reflects", lemma: "reflect", kind: "third-person" }]),
      [{ lemma: "reflect", aliases: ["Reflex", "reflexive"] }],
    );
    expect(plan.lemmaUpdates[0].after).toEqual(["Reflex", "reflexive", "reflects"]);
  });

  it("aliases 为空数组时正常追加，不产生 undefined / 空串", () => {
    const plan = planAliasBackfill(
      manifestOf([{ form: "systems", lemma: "system", kind: "plural" }]),
      [{ lemma: "system", aliases: [] }],
    );
    expect(plan.lemmaUpdates[0].before).toEqual([]);
    expect(plan.lemmaUpdates[0].after).toEqual(["systems"]);
    expect(plan.lemmaUpdates[0].after).not.toContain("");
  });

  it("已存在则跳过（幂等），且不改动 aliases", () => {
    const plan = planAliasBackfill(
      manifestOf([{ form: "hospitals", lemma: "hospital", kind: "plural" }]),
      [{ lemma: "hospital", aliases: ["hospice", "hospitals"] }],
    );
    expect(plan.appends).toHaveLength(0);
    expect(plan.alreadyPresent).toHaveLength(1);
    expect(plan.lemmaUpdates).toHaveLength(0);
  });

  it("大小写不同的既有 alias 视为已登记", () => {
    const plan = planAliasBackfill(
      manifestOf([{ form: "gaps", lemma: "gap", kind: "plural" }]),
      [{ lemma: "gap", aliases: ["GAPS"] }],
    );
    expect(plan.alreadyPresent).toHaveLength(1);
    expect(plan.appends).toHaveLength(0);
  });

  it("所有格形式保留撇号，不被归一成 today", () => {
    const plan = planAliasBackfill(
      manifestOf([{ form: "today's", lemma: "today", kind: "possessive" }]),
      [{ lemma: "today", aliases: [] }],
    );
    expect(plan.lemmaUpdates[0].after).toEqual(["today's"]);
  });

  it("新登记的形式一律小写", () => {
    const plan = planAliasBackfill(
      manifestOf([{ form: "Hospitals", lemma: "hospital", kind: "plural" }]),
      [{ lemma: "hospital", aliases: [] }],
    );
    expect(plan.lemmaUpdates[0].after).toEqual(["hospitals"]);
  });

  it("清单里重复的形式只处理一次", () => {
    const plan = planAliasBackfill(
      manifestOf([
        { form: "gaps", lemma: "gap", kind: "plural" },
        { form: "gaps", lemma: "gap", kind: "plural" },
      ]),
      [{ lemma: "gap", aliases: [] }],
    );
    expect(plan.entries).toHaveLength(1);
    expect(plan.lemmaUpdates[0].after).toEqual(["gaps"]);
  });

  it("missingLemmas 去重且排序", () => {
    const plan = planAliasBackfill(
      manifestOf([
        { form: "a", lemma: "zebra", kind: "plural" },
        { form: "b", lemma: "zebra", kind: "plural" },
        { form: "c", lemma: "apple", kind: "plural" },
      ]),
      [],
    );
    expect(plan.missingLemmas).toEqual(["apple", "zebra"]);
  });

  it("库现状缺 aliases 字段（NULL）时按空数组处理", () => {
    const rows = [{ lemma: "gap", aliases: undefined as unknown as string[] }];
    const plan = planAliasBackfill(
      manifestOf([{ form: "gaps", lemma: "gap", kind: "plural" }]),
      rows,
    );
    expect(plan.lemmaUpdates[0].after).toEqual(["gaps"]);
  });
});
