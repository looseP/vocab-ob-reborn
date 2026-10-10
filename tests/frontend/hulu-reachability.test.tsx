/// <reference lib="dom" />
// @vitest-environment jsdom

/**
 * 葫芦冲刺可达性与隔离（ADR-0041，P1）。
 *
 * 三条**结构不变式**（不是运行时行为，故直接查源码）：
 *  1. 葫芦是 `reviewModes` 里的**显式第 6 个模式**，由 `reviewMode === "hulu"`
 *     分支直达；不选它 ⇒ 分支不可达（同 ADR-0036 §4 修订对阶梯的处理）。
 *  2. 三个既有会话体（`ReviewSession` / `DrillSession` / `LadderReviewSession`）
 *     的源码**不含 `hulu`** —— 葫芦不劫持、不寄生任何现行复习流。
 *     `ReviewSession` 不是独立文件，它是 `ReviewPage.tsx` 里的一个函数
 *     （与 `ReviewPage` / `BootstrapReviewSession` 同文件），故按函数边界切片断言。
 *  3. 葫芦的会话体是新文件 `HuluSprintSession.tsx`，且**不嵌 `ReviewCardView`**
 *     （那是服务评分流、会写 FSRS 的组件）。
 *
 * 源码读取用 cwd 相对路径（与本目录既有前端测试同口径）。
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** 剥掉块注释与整行行注释，只留代码（注释里引述历史写法不算代码路径）。 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

const REVIEW_PAGE = "src/frontend/pages/ReviewPage.tsx";
const HULU_SESSION = "src/frontend/components/review/HuluSprintSession.tsx";

function readCode(path: string): string {
  return stripComments(readFileSync(path, "utf8"));
}

/** 取 `function <name>(...) { ... }` 的函数体（按下一个顶层 `function` 声明切边界）。 */
function functionBody(code: string, name: string): string {
  const start = code.indexOf(`function ${name}(`);
  expect(start, `${name} 未找到`).toBeGreaterThanOrEqual(0);
  const rest = code.slice(start);
  const nextMatch = rest.slice(1).search(/\n(?:export )?function /);
  return nextMatch === -1 ? rest : rest.slice(0, nextMatch + 1);
}

/** 取两个标记之间的源码片段（含起点、不含终点）。 */
function between(code: string, from: string, to: string): string {
  const start = code.indexOf(from);
  expect(start, `${from} 未找到`).toBeGreaterThanOrEqual(0);
  const end = code.indexOf(to, start + from.length);
  expect(end, `${to} 未找到`).toBeGreaterThan(start);
  return code.slice(start, end);
}

describe("葫芦冲刺是显式模式（不选则分支不可达）", () => {
  it('ReviewPage 有 reviewMode === "hulu" 的显式分支，与 ladder/cram 并列', () => {
    const code = readCode(REVIEW_PAGE);

    expect(code).toContain('reviewMode === "hulu"');
    // 三个显式模式分支并列（cram / ladder / hulu 各一条）
    expect(code).toContain('reviewMode === "cram"');
    expect(code).toContain('reviewMode === "ladder"');
    // 葫芦走独立组件，不进 ReviewSession
    expect(code).toContain("HuluSprintSession");
  });

  it("模式清单恰 6 项且 hulu 末位", async () => {
    const { reviewModesForTest } = await import("@/frontend/pages/ReviewPage");
    const modes = reviewModesForTest();
    expect(modes.map((mode) => mode.key)).toEqual(["review", "cram", "preview", "zen", "ladder", "hulu"]);
  });

  it("模式网格不再有 xl:grid-cols-5，且次级网格留有余量不产生孤行", () => {
    const code = readCode(REVIEW_PAGE);
    expect(code).not.toContain("xl:grid-cols-5");
    // 2026-10-10 通道隔离后布局改了：review/zen 升级为顶部大卡片，剩下
    // cram/preview/ladder/hulu 四项走 `lg:grid-cols-4` 网格 —— 四项在四列下
    // **不产生孤行**（6 项在三列下才是 2+2+2，4 项在 4 列下是 1×4）。
    // 原断言写死 `lg:grid-cols-3` 是针对「6 项模式网格」，该网格已不复存在。
    expect(code).toContain("lg:grid-cols-4");
  });
});

describe("三个既有会话体不含 hulu（葫芦不寄生现行复习流）", () => {
  it('ReviewPage.tsx 的 ReviewSession 函数体（剥注释）不含 "hulu"', () => {
    const body = functionBody(readCode(REVIEW_PAGE), "ReviewSession");
    expect(body.toLowerCase()).not.toContain("hulu");
  });

  for (const component of [
    "src/frontend/components/review/DrillSession.tsx",
    "src/frontend/components/review/LadderReviewSession.tsx",
  ]) {
    it(`${component} 剥注释后不含 "hulu"`, () => {
      expect(readCode(component).toLowerCase()).not.toContain("hulu");
    });
  }

  it("useReview 也不含 hulu（P1 不改既有 hook）", () => {
    expect(readCode("src/frontend/hooks/useReview.ts").toLowerCase()).not.toContain("hulu");
  });
});

describe("葫芦会话体是独立只读组件（不嵌 ReviewCardView）", () => {
  it("不嵌 ReviewCardView（那是服务评分流、会写 FSRS 的组件）", () => {
    const code = readCode(HULU_SESSION);
    expect(code).not.toContain("ReviewCardView");
    expect(code).not.toContain("useReview");
  });

  it("单卡路径零请求：翻开 / 自认的函数体里没有 apiFetch / fetch", () => {
    const code = readCode(HULU_SESSION);
    // flip 与 judge 都是组件内的箭头函数常量；按相邻声明切出各自的函数体。
    const flipBody = between(code, "const flip =", "const judge =");
    const judgeBody = between(code, "const judge =", "const alive =");
    for (const body of [flipBody, judgeBody]) {
      expect(body).not.toContain("apiFetch");
      expect(body).not.toContain("fetch(");
    }
  });

  it("闸门读计划行列值（huluGateDecision 传入 plan.gate_ratio），不写死 0.8", () => {
    const code = readCode(HULU_SESSION);
    expect(code).toContain("huluGateDecision");
    expect(code).toContain("plan.gate_ratio");
    // 不得出现 0.8 / 0.80 作为闸门字面量（域默认值住在 domain 常量里）
    expect(code).not.toMatch(/\b0\.8\d*\b/);
  });

  it("会话恢复用 localStorage + 独立前缀 vocab:hulu:sprint:（禁用 sessionStorage / 30min）", () => {
    const code = readCode(HULU_SESSION);
    expect(code).toContain("vocab:hulu:sprint:");
    expect(code).toContain("localStorage");
    expect(code).not.toContain("sessionStorage");
    // 24h TTL（R3）；禁止 30min
    expect(code).toContain("24 * 60 * 60 * 1000");
    expect(code).not.toContain("30 * 60 * 1000");
  });

  it("页载荷走 /hulu/plans/:id/pages/:no，不复用 preview queue", () => {
    const code = readCode(HULU_SESSION);
    expect(code).toContain("/hulu/plans/");
    expect(code).toContain("/pages/");
    expect(code).not.toContain("/review/queue");
    expect(code).not.toContain("mode=preview");
  });
});
