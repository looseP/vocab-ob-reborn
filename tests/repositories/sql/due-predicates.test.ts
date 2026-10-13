/**
 * 「到期」谓词唯一定义处的测试（2026-10-13）。
 *
 * 2026-10-12 的事故（仪表盘 1 / 队列 0，用户以为调度坏了）根因是同一概念多处各写
 * 一遍、口径写着写着就漂了。这个文件锁住两件事：
 *   1. 每个概念的 SQL 文本稳定（调用点的既有断言因此继续成立 ⇒ 无行为变化）；
 *   2. **必须同口径的概念确实同口径** —— 尤其是 dueNow 与 dueToday 的状态过滤，
 *      那正是上次漂掉的地方。
 */
import { describe, expect, it } from "vitest";
import {
  dueNowSql,
  dueTodaySql,
  learningSql,
  matureDueSql,
  matureNotDueSql,
} from "../../../src/repositories/sql/duePredicates";

describe("duePredicates — 到期谓词的唯一定义处", () => {
  it("别名可替换（各查询的表别名不同：uwp. / p.）", () => {
    expect(matureDueSql("uwp")).toContain("uwp.state = 'review'");
    expect(matureDueSql("p")).toContain("p.state = 'review'");
    expect(dueNowSql("p")).not.toContain("uwp.");
  });

  it("五个概念的文本稳定（调用点既有断言继续成立）", () => {
    expect(matureDueSql("uwp")).toBe(
      "uwp.state = 'review' AND (uwp.due_at IS NULL OR uwp.due_at <= now())",
    );
    expect(learningSql("uwp")).toBe("uwp.state IN ('learning', 'relearning')");
    expect(matureNotDueSql("uwp")).toBe("uwp.state = 'review' AND uwp.due_at > now()");
    expect(dueNowSql("uwp")).toBe(
      "uwp.state NOT IN ('suspended', 'new') AND (uwp.due_at IS NULL OR uwp.due_at <= now())",
    );
    expect(dueTodaySql("uwp", "$3")).toBe(
      "uwp.state NOT IN ('suspended', 'new') AND uwp.due_at IS NOT NULL AND uwp.due_at < $3::timestamptz + interval '1 day'",
    );
  });

  it("不变量：dueNow 与 dueToday 共用同一句状态口径（上次就是这里漂的）", () => {
    // 2026-10-12：facet 写 `state <> 'suspended'`、真源写 `NOT IN ('suspended','new')`
    // ⇒ 仪表盘与队列对不上。现在两者必须逐字相同。
    const scope = "state NOT IN ('suspended', 'new')";
    expect(dueNowSql("uwp")).toContain(scope);
    expect(dueTodaySql("uwp", "$3")).toContain(scope);
    expect(dueTodaySql("uwp", "$6")).toContain(scope);
  });

  it("不变量：dueNow = matureDue ∪ learning（缺 learning 就是漏算学习中）", () => {
    // dueNow 的谓词必须同时覆盖 matureDue 的状态集与 learning 的状态集：
    // 前者是 state='review'，后者是 learning/relearning，并集正是 NOT IN ('suspended','new')。
    const dueNow = dueNowSql("uwp");
    expect(dueNow).toContain("state NOT IN ('suspended', 'new')");
    expect(dueNow).toContain("due_at IS NULL OR uwp.due_at <= now()");
    // 两个组件的状态集都不在排除名单里
    expect(learningSql("uwp")).not.toMatch(/suspended/);
    expect(matureDueSql("uwp")).not.toMatch(/suspended/);
  });

  it("dueToday 要求 due_at 非空（与 dueNow 的唯一差别，故 dueToday ≤ dueNow + laterToday）", () => {
    expect(dueTodaySql("uwp", "$3")).toContain("due_at IS NOT NULL");
    // 日历日上沿：明天零点，且不设下沿（否则漏积压）
    expect(dueTodaySql("uwp", "$3")).toContain("interval '1 day'");
    expect(dueTodaySql("uwp", "$3")).not.toContain("due_at >");
    // 占位符由调用方给（不同查询用 $3 / $6）
    expect(dueTodaySql("uwp", "$6")).toContain("$6::timestamptz");
  });
});
