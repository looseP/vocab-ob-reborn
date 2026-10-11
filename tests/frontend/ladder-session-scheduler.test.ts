/**
 * sessionScheduler 纯函数单元测试（ADR-0036 / 演示页 startSession，LW-1 验收）。
 *
 * 验证点（计划卡指定）：交替性、同词间隔、R3 位置、空队列、单词队列。
 */

import { describe, it, expect } from "vitest";
import { buildLadderSession, enforceNoBackToBack, weave } from "@/frontend/reviewFlow/sessionScheduler";
import type { ReviewCard } from "@/frontend/hooks/useReview";

let seq = 0;
function makeCard(overrides: Partial<ReviewCard> = {}): ReviewCard {
  const id = overrides.progressId ?? `p${++seq}`;
  return {
    progressId: id,
    word: {
      id: `w-${id}`,
      slug: `slug-${id}`,
      title: `Title ${id}`,
      lemma: `lemma${id}`,
      short_definition: "def",
      ipa: null,
      pos: null,
      cefr: null,
    },
    state: "review",
    dueAt: null,
    lastRating: "good",
    reviewCount: 3,
    note_entries: [],
    ...overrides,
  };
}

function makeQueue(specs: Array<{ rung?: number; isNew?: boolean }>): ReviewCard[] {
  return specs.map((s) => makeCard({ ladderRung: s.rung ?? 1, state: s.isNew ? "new" : "review" }));
}

describe("weave（轮内新旧交替）", () => {
  it("复习段与新词逐个穿插", () => {
    expect(weave(["r1", "r2", "r3"], ["n1", "n2"])).toEqual(["r1", "n1", "r2", "n2", "r3"]);
    expect(weave(["r1"], ["n1", "n2", "n3"])).toEqual(["r1", "n1", "n2", "n3"]);
    expect(weave([], ["n1"])).toEqual(["n1"]);
    expect(weave(["r1", "r2"], [])).toEqual(["r1", "r2"]);
  });
});

describe("enforceNoBackToBack（同词不背靠背）", () => {
  it("相邻同词与后方最近异词交换", () => {
    const out = enforceNoBackToBack([
      { progressId: "a" },
      { progressId: "a" },
      { progressId: "b" },
    ]);
    expect(out.map((x) => x.progressId)).toEqual(["a", "b", "a"]);
  });

  it("无冲突时保序；退化（全同词）保持原序", () => {
    expect(enforceNoBackToBack([{ progressId: "a" }, { progressId: "b" }, { progressId: "a" }]).map((x) => x.progressId))
      .toEqual(["a", "b", "a"]);
    expect(enforceNoBackToBack([{ progressId: "a" }, { progressId: "a" }]).map((x) => x.progressId))
      .toEqual(["a", "a"]); // 单词会话退化场景：无其他词可穿插
  });

  // 2026-10-11 审查（S3）：旧实现只检查交换位的**后侧**，漏检前侧，于是
  // 「明明存在合法解」也被判成退化放过。下面这组输入旧实现会原样返回。
  it("2 词队列的背靠背也要修：存在合法解时不得放过", () => {
    const out = enforceNoBackToBack([
      { progressId: "a" },
      { progressId: "b" },
      { progressId: "b" },
      { progressId: "a" },
    ]).map((x) => x.progressId);
    for (let i = 1; i < out.length; i++) {
      expect(out[i], `位置 ${i} 与前一节点同词且存在合法解`).not.toBe(out[i - 1]);
    }
    // 元素集合不变（只换位置，不丢词）
    expect([...out].sort()).toEqual(["a", "a", "b", "b"]);
  });

  it("修复后不引入新的背靠背（交换两侧都要检查）", () => {
    const out = enforceNoBackToBack([
      { progressId: "a" },
      { progressId: "a" },
      { progressId: "b" },
      { progressId: "b" },
      { progressId: "a" },
    ]).map((x) => x.progressId);
    for (let i = 1; i < out.length; i++) {
      expect(out[i]).not.toBe(out[i - 1]);
    }
  });

  // 2026-10-11 审查（S3）连带约束：交换**不得跨轮**。
  // 跨轮交换会把产出轮的词换到巩固轮之前 —— 词变成"先默写再跟写"，三轮语义递进被破坏
  // （实测两词会话被换成 card,card,dictation,dictation,follow,follow）。
  it("分组后交换严格限制在组内：跨轮背靠背保持原序而非乱换", () => {
    const items = [
      { progressId: "a", pass: 1 },
      { progressId: "b", pass: 1 },
      { progressId: "b", pass: 2 }, // 跨轮背靠背（pass1 尾 b 与 pass2 头 b）
      { progressId: "a", pass: 2 },
      { progressId: "a", pass: 3 },
      { progressId: "b", pass: 3 },
    ];
    const out = enforceNoBackToBack(items, (v) => String(v.pass));
    // 各轮的词集合必须原样保持（只允许组内换位）
    for (const p of [1, 2, 3]) {
      const before = items.filter((x) => x.pass === p).map((x) => x.progressId);
      const after = out.filter((x) => x.pass === p).map((x) => x.progressId);
      expect([...after].sort(), `pass${p} 的词集合被跨轮交换破坏`).toEqual([...before].sort());
    }
    // pass 的先后顺序不变（产出轮不能跑到巩固轮前面）
    expect(out.map((x) => x.pass)).toEqual([1, 1, 2, 2, 3, 3]);
  });
});

describe("buildLadderSession（三轮编排）", () => {
  it("空队列 → 空会话", () => {
    expect(buildLadderSession([])).toEqual([]);
  });

  it("单词队列：R1 词三 pass 齐全（单词会话退化，同词相邻不可避免）", () => {
    const queue = makeQueue([{ rung: 1 }]);
    const visits = buildLadderSession(queue);
    expect(visits.map((v) => v.pass)).toEqual([1, 2, 3]);
    expect(visits.map((v) => v.stage)).toEqual(["card", "follow", "dictation"]);
    expect(visits.every((v) => v.qi === 0)).toBe(true);
  });

  it("R3 词只进产出轮（无卡面/巩固），且排在产出轮最前", () => {
    const queue = makeQueue([{ rung: 1 }, { rung: 3 }]);
    const visits = buildLadderSession(queue);
    const pass1 = visits.filter((v) => v.pass === 1);
    const pass2 = visits.filter((v) => v.pass === 2);
    const pass3 = visits.filter((v) => v.pass === 3);
    // pass1/pass2 只有 R1 词（qi=0）
    expect(pass1.map((v) => v.qi)).toEqual([0]);
    expect(pass2.map((v) => v.qi)).toEqual([0]);
    // 产出轮 R3（qi=1）在前，R1 在后
    expect(pass3.map((v) => v.qi)).toEqual([1, 0]);
    // R3 词的卡面阶段不存在
    expect(visits.filter((v) => v.qi === 1 && (v.stage === "card" || v.stage === "follow"))).toEqual([]);
  });

  it("R2 词卡面阶段为 card-no-hints（拍板③）", () => {
    const queue = makeQueue([{ rung: 2 }]);
    const visits = buildLadderSession(queue);
    expect(visits[0].stage).toBe("card-no-hints");
  });

  it("新词走 card-encode 进三轮（R0 模板）；复习段按 rung 降序参与交替", () => {
    const queue = makeQueue([{ rung: 1 }, { isNew: true }, { rung: 2 }]);
    const visits = buildLadderSession(queue);
    const pass1 = visits.filter((v) => v.pass === 1);
    // revs 按 rung 降序 = [qi2(R2), qi0(R1)]；weave(r1r2, news=[1]) → 2,1,0
    expect(pass1.map((v) => v.qi)).toEqual([2, 1, 0]);
    expect(pass1.find((v) => v.qi === 1)?.stage).toBe("card-encode");
    // 巩固轮反序 weave([0,2],[1]) = [0,1,2]；no-back-to-back 修复 pass1 尾(qi0)
    // 与 pass2 头(qi0) 的跨轮背靠背 → 与最近异词交换 → [1,0,2]（拍板⑥ 跨轮生效）
    const pass2 = visits.filter((v) => v.pass === 2);
    expect(pass2.map((v) => v.qi)).toEqual([1, 0, 2]);
    // 修复后全队列无相邻同词
    for (let i = 1; i < visits.length; i++) {
      expect(visits[i].progressId).not.toBe(visits[i - 1].progressId);
    }
  });

  it("同词不背靠背：全队列相邻节点 progressId 互异（多词场景）", () => {
    const queue = makeQueue([
      { rung: 1 },
      { rung: 2 },
      { isNew: true },
      { rung: 3 },
    ]);
    const visits = buildLadderSession(queue);
    for (let i = 1; i < visits.length; i++) {
      expect(visits[i].progressId).not.toBe(visits[i - 1].progressId);
    }
  });
});
