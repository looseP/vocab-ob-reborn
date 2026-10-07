/**
 * `scripts/clean-source-pending-web-verify.ts` 的纯逻辑回归锁。
 *
 * 不连库：只测 `cleanSource` / `planClean` 与两个口径常量。
 * 之所以值得锁 —— 这个脚本要**改写生产词库的来源标注**，最怕的不是"没改到"，
 * 而是"改错了"：
 *   1. 把只剩一半的残缺串（只剥到一半）当成正常结果写回去
 *   2. 把**不是**「构造参考 · <lemma>」形态的条目也一起剥（覆盖掉别的口径）
 *   3. 尾巴不在末尾时仍剥离（留下中缀垃圾）
 *   4. 重复执行时无法识别"已清洗"（幂等失效）
 *   5. SQL 判据（`LIKE '%待网页核验%'`）与剥离用的尾巴常量脱钩（判据命中但剥不掉）
 */
import { describe, expect, it } from "vitest";
import {
  EXPECTED_TOTAL,
  PENDING_FIELD,
  PENDING_MARKER,
  PENDING_WEB_VERIFY_TAIL,
  cleanSource,
  planClean,
  type SourceRow,
} from "../../scripts/clean-source-pending-web-verify";

/** 造一条带尾巴的命中行（库内实测形态）。 */
function tailRow(slug: string, checkedCount = 3): SourceRow {
  return {
    slug,
    source: `构造参考 · ${slug}${PENDING_WEB_VERIFY_TAIL}`,
    checkedCount,
  };
}

describe("口径常量（唯一真源）", () => {
  it("尾巴是库内实测的唯一形态，且含判据标记", () => {
    expect(PENDING_WEB_VERIFY_TAIL).toBe("（迁移包 SD 取材，待网页核验）");
    // 判据用的是 LIKE '%待网页核验%'，剥离用的是整条尾巴 ——
    // 尾巴必须包含标记，否则会出现「SQL 命中但 cleanSource 返回 null」的假拒绝。
    expect(PENDING_WEB_VERIFY_TAIL).toContain(PENDING_MARKER);
  });

  it("基线总数 = 216（2026-10-07 双库实测）", () => {
    expect(EXPECTED_TOTAL).toBe(216);
    expect(PENDING_FIELD).toBe("pending_web_check");
  });
});

describe("cleanSource（剥尾巴：只在能确定形态时才动手）", () => {
  it("剥掉末尾尾巴，得到与既有 22 条同款的「构造参考 · <lemma>」", () => {
    expect(cleanSource(`构造参考 · absolutist${PENDING_WEB_VERIFY_TAIL}`)).toBe("构造参考 · absolutist");
    expect(cleanSource(`构造参考 · aggressiveness${PENDING_WEB_VERIFY_TAIL}`)).toBe(
      "构造参考 · aggressiveness",
    );
  });

  it("两词 lemma（库内 3 条）同样只剥尾巴，不碰词本身", () => {
    expect(cleanSource(`构造参考 · take off${PENDING_WEB_VERIFY_TAIL}`)).toBe("构造参考 · take off");
  });

  it("已清洗态不属于命中集 → 返回 null（幂等：第二次执行不再改）", () => {
    expect(cleanSource("构造参考 · assertion")).toBeNull();
    expect(cleanSource("构造参考 · futurologist")).toBeNull();
  });

  it("尾巴不在末尾 → 拒绝（防留下中缀垃圾）", () => {
    expect(cleanSource(`构造参考 · x${PENDING_WEB_VERIFY_TAIL}另有后缀`)).toBeNull();
    expect(cleanSource(`构造参考 · x${PENDING_WEB_VERIFY_TAIL}${PENDING_WEB_VERIFY_TAIL}`)).toBeNull();
  });

  it("剥离后不是「构造参考 · 」形态 → 拒绝（不覆盖别的口径）", () => {
    expect(cleanSource(`参考句（取材自迁移包 SD，${PENDING_MARKER}）`)).toBeNull();
    expect(cleanSource(`Cambridge Dictionary · accuse${PENDING_WEB_VERIFY_TAIL}`)).toBeNull();
  });

  it("lemma 为空或剥出残缺标点 → 拒绝（只剥一半的形态）", () => {
    expect(cleanSource(`构造参考 · ${PENDING_WEB_VERIFY_TAIL}`)).toBeNull();
    expect(cleanSource(`构造参考 · x（${PENDING_WEB_VERIFY_TAIL}`)).toBeNull();
    expect(cleanSource(`构造参考 · x，${PENDING_WEB_VERIFY_TAIL}`)).toBeNull();
  });

  it("null / 空串 / 不含尾巴 → 拒绝", () => {
    expect(cleanSource(null)).toBeNull();
    expect(cleanSource("")).toBeNull();
    expect(cleanSource("构造参考 · x")).toBeNull();
    expect(cleanSource(PENDING_WEB_VERIFY_TAIL)).toBeNull();
  });
});

describe("planClean（分流：可改 / 形态异常）", () => {
  it("全命中：逐条给出 before→after，并带出 checked 条目数", () => {
    const plan = planClean([tailRow("absolutist", 4), tailRow("abide", 2)]);
    expect(plan.problems).toEqual([]);
    expect(plan.changes.map((c) => [c.slug, c.after, c.checkedCount])).toEqual([
      ["absolutist", "构造参考 · absolutist", 4],
      ["abide", "构造参考 · abide", 2],
    ]);
  });

  it("形态异常的条目进 problems（调用方据此整体拒绝执行）", () => {
    const plan = planClean([tailRow("ok-one"), { slug: "weird", source: `人工改过${PENDING_MARKER}`, checkedCount: 0 }]);
    expect(plan.changes.map((c) => c.slug)).toEqual(["ok-one"]);
    expect(plan.problems).toHaveLength(1);
    expect(plan.problems[0]).toContain("weird");
    expect(plan.problems[0]).toContain("不覆盖");
  });

  it("不改入参（纯函数，库行对象原样保留）", () => {
    const row = tailRow("anchor", 5);
    const snapshot = { ...row };
    planClean([row]);
    expect(row).toEqual(snapshot);
  });
});
