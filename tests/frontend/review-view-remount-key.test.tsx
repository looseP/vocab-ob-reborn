/**
 * 复习视图重挂载键护栏（2026-09-29，PR 修 P0 巩固轮死锁 + 评分上限污染）。
 *
 * 本文件只做源码扫描，**刻意不用 jsdom**：`node:fs` / `node:path` 在 jsdom 环境下
 * 会被 vite externalize 并抛 `No such built-in module: node:`。默认 node 环境即可。
 *
 * 缺陷背景（浏览器实测复现，非推理）：
 *   `LadderReviewSession` 与 `ReviewPage` 渲染四个带本地 `useState` 的复习视图时
 *   **都没给 `key`**。React 对同类型同位置的元素按位置复用实例，于是上一张卡的
 *   本地状态被带进下一张：
 *
 *   | 视图 | 残留状态 | 后果 |
 *   |---|---|---|
 *   | FollowCopyView | `finished` + useTypingFlow 的 `typedLength`/`doneRef` | **死锁** |
 *   | TypingDictationView | `finished`/`hintChars` + useTypingFlow | 同类死锁 |
 *   | ReviewCardView | `hintLevel`/`viaH4`/`revealed`/`shown` | 评分上限错 → 污染 FSRS；剧透 |
 *   | EncodeCardView | `revealed` | 剧透 |
 *
 * 死锁链路：上一卡已跟写完成（`doneRef=true`、`finished=true`）→ 换卡后组件被复用
 * → 新词比旧词短时 `done` 立即为真 → 输入框消失、`onDone` 因 `doneRef` 已置位永不
 * 触发 → 卡面停在「跟写完成」且**无任何按钮可点**，会话无法推进。
 *
 * 为什么单靠 hook 测试不够：`useTypingFlow` 现在会在目标词变化时自我清零
 * （见 ladder-use-typing-flow.test.tsx），但它管不到 `finished`/`hintLevel` 这些
 * 组件内的 state。本护栏锁的是**父组件必须提供 key** 这件事本身。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const LADDER = join(process.cwd(), "src/frontend/components/review/LadderReviewSession.tsx");
const REVIEW_PAGE = join(process.cwd(), "src/frontend/pages/ReviewPage.tsx");

/** 抽出源码中**所有** `<Component` 出现处的标签头（key= 若存在必在其中）。 */
function openingTags(source: string, component: string): string[] {
  const lines = source.split("\n");
  const found: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trimStart().startsWith(`<${component}`)) {
      found.push(lines.slice(i, i + 3).join("\n"));
    }
  }
  expect(found.length, `未在源码中定位到 <${component}`).toBeGreaterThan(0);
  return found;
}

describe("复习视图重挂载键（跨卡状态污染护栏）", () => {
  it("LadderReviewSession：四个 stage 视图的每一处渲染都带 key", () => {
    const src = readFileSync(LADDER, "utf8");
    for (const component of [
      "FollowCopyView",
      "TypingDictationView",
      "EncodeCardView",
      "ReviewCardView",
    ]) {
      // ReviewCardView 出现两次（meaning 分支与默认分支），两处都要查——
      // 少查一处就等于给回归留一个洞。
      for (const tag of openingTags(src, component)) {
        expect(tag, `<${component} 缺 key —— 换卡时其本地 useState 会跨卡残留`).toMatch(
          /\bkey=\{cardKey\}/,
        );
      }
    }
  });

  it("LadderReviewSession：meaning 分支的包裹 div 也带 key（双保险）", () => {
    const src = readFileSync(LADDER, "utf8");
    const line = src.split("\n").find((l) => l.includes('data-testid="meaning-review"'));
    expect(line, "未能定位 meaning 分支的 div").toBeDefined();
    // 外层 div 的 key 本身已能让整棵子树重挂载；内层 ReviewCardView 另有一份
    // （见上一条断言）。两处都留，避免将来 div 被换成 Fragment/条件分支时静默失效。
    expect(line).toMatch(/\bkey=\{cardKey\}/);
  });

  it("LadderReviewSession：cardKey 由 progressId + stage 组成（换 stage 也须重挂载）", () => {
    const src = readFileSync(LADDER, "utf8");
    const line = src.split("\n").find((l) => l.includes("const cardKey"));
    expect(line, "未能定位 cardKey 定义").toBeDefined();
    expect(line).toContain("current.progressId");
    expect(line).toContain("current.stage");
  });

  it("ReviewPage：ReviewCardView 带 key（onUndo 回退与普通换卡都会中招）", () => {
    const src = readFileSync(REVIEW_PAGE, "utf8");
    for (const tag of openingTags(src, "ReviewCardView")) {
      expect(tag, "ReviewPage 的 <ReviewCardView 缺 key").toMatch(
        /\bkey=\{currentCard\?\.progressId \?\? "review-no-card"\}/,
      );
    }
  });
});
