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
