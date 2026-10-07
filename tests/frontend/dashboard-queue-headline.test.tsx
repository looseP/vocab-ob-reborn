/**
 * `DashboardPage.queueHeadline` 的口径回归锁。
 *
 * 这条文案修的是一个**会撒谎的界面**：此前写「{dueToday} 张卡片待复习」，而你点进去
 * 看到的是**队列总数**（2026-10-07 实测：文案说 14，队列是 22 —— 差的 8 张是新卡）。
 * 锁住的规矩：
 *   1. 文案里的数必须是**会被你看见的那个数**（队列总数），不是「今天到期数」；
 *   2. 分桶（到期 / 新卡）只在**拿全了条目**时才算，否则只报总数 —— 宁可少说，不编拆分；
 *   3. 空队列、纯新卡、纯到期三条边界各有明确文案。
 */
import { describe, expect, it } from "vitest";
import { queueHeadline } from "@/frontend/pages/DashboardPage";

const items = (labels: string[]) => labels.map((queueLabel) => ({ queueLabel }));

describe("queueHeadline（仪表盘「开始复习」的文案口径）", () => {
  it("拿全条目时按真实分桶报「到期 + 新卡」", () => {
    const q = items([...Array(14).fill("重新核对"), ...Array(8).fill("新卡片")]);
    expect(queueHeadline({ total: 22 }, q)).toBe("14 张到期 + 8 张新卡待复习");
  });

  it("只有新卡 / 只有到期，文案各自成立（不带多余的 0）", () => {
    expect(queueHeadline({ total: 3 }, items(["新卡片", "新卡片", "新卡片"]))).toBe("3 张新卡片待复习");
    expect(queueHeadline({ total: 2 }, items(["学习中", "重新核对"]))).toBe("2 张到期卡片待复习");
  });

  it("条目没拿全（分页截断）时只报总数，**不编**分桶", () => {
    // 队列总量 500 但只带回 100 条 —— 此时任何分桶都是错的
    expect(queueHeadline({ total: 500 }, items(Array(100).fill("新卡片")))).toBe("共 500 张待复习");
  });

  it("队列为空 / 数据未到位时给安全文案", () => {
    expect(queueHeadline({ total: 0 }, [])).toBe("暂无待复习卡片");
    expect(queueHeadline(null, null)).toBe("暂无待复习卡片");
    // 有总数但 items 还在路上（null）→ 只报总数
    expect(queueHeadline({ total: 22 }, null)).toBe("共 22 张待复习");
  });
});
