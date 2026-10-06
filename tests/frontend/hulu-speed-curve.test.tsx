/// <reference lib="dom" />
// @vitest-environment jsdom

/**
 * 缩时曲线组件测试（完备设计 §九 / 执行计划 P2-3）。
 *
 * 三条验收条款：
 *  1. **可回溯**：每个柱子恰好对应 `hulu_rounds` 的一行 —— 断言 `data-round-id`
 *     与 `data-elapsed-seconds` 逐一对上传入的行（柱高只由该行的 elapsed_seconds 决定，
 *     禁止用词数/通过率反推）；
 *  2. 只画**已收尾**轮（`ended_at` 非空）、按 `round_no` 升序；
 *  3. **免责声明**两层意思都在（代理指标非掌握证明 + 长中断虚高）。
 */

import { act } from "react";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HuluSpeedCurve } from "@/frontend/components/review/HuluSpeedCurve";
import type { HuluRoundRow } from "@/domain/hulu-sprint";

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

const mountedRoots: Array<{ root: Root; container: HTMLDivElement }> = [];

afterEach(() => {
  act(() => {
    for (const mounted of mountedRoots.splice(0)) mounted.root.unmount();
  });
  document.body.innerHTML = "";
});

/** 造一行 hulu_rounds（列名与 DB 一致）。 */
function round(overrides: Partial<HuluRoundRow> & { round_no: number }): HuluRoundRow {
  return {
    id: `round-id-${overrides.round_no}`,
    plan_id: "plan-1",
    user_id: "u-1",
    started_at: "2026-10-06T00:00:00Z",
    ended_at: "2026-10-06T01:00:00Z",
    elapsed_seconds: 3600,
    pages_passed: 5,
    words_passed: 100,
    words_total: 100,
    kind: "recall",
    word_set_fingerprint: "aaaaaaaabbbbbbbb",
    ...overrides,
  };
}

function render(props: Parameters<typeof HuluSpeedCurve>[0]) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(createElement(HuluSpeedCurve, props));
  });
  mountedRoots.push({ root, container });
  return container;
}

const bodyText = (container: HTMLElement) => container.textContent?.replace(/\s+/g, " ") ?? "";

describe("缩时曲线：每个柱子可回溯到 hulu_rounds 的一行", () => {
  it("柱子数与已收尾轮数一致，且 data-round-id / data-elapsed-seconds 逐一对上", () => {
    const rounds = [
      round({ round_no: 1, id: "r-1", elapsed_seconds: 7200 }),
      round({ round_no: 2, id: "r-2", elapsed_seconds: 5400 }),
      round({ round_no: 3, id: "r-3", elapsed_seconds: 3600 }),
    ];
    const container = render({ rounds, targetRounds: 4, examDate: "2026-12-20", today: "2026-10-06" });

    const bars = Array.from(container.querySelectorAll("[data-round-id]"));
    expect(bars).toHaveLength(rounds.length);

    for (const [index, row] of rounds.entries()) {
      const bar = bars[index]!;
      // 每个数字都能回溯到具体一行：id 与耗时都来自该行
      expect(bar.getAttribute("data-round-id")).toBe(row.id);
      expect(bar.getAttribute("data-round-no")).toBe(String(row.round_no));
      expect(bar.getAttribute("data-elapsed-seconds")).toBe(String(row.elapsed_seconds));
      // 柱内文案也由该行耗时格式化而来（7200 → 2 时 00 分 / 5400 → 1 时 30 分）
      const minutes = Math.floor((row.elapsed_seconds ?? 0) / 60);
      const expected = `${Math.floor(minutes / 60)} 时 ${String(minutes % 60).padStart(2, "0")} 分`;
      expect(bar.textContent).toContain(`第 ${row.round_no} 轮`);
      expect(bar.textContent).toContain(expected);
    }
  });

  it("只画已收尾轮（ended_at 非空）：未收尾轮不进柱子，也不影响剩余轮数之外的计算", () => {
    const rounds = [
      round({ round_no: 1, id: "r-1", elapsed_seconds: 3600 }),
      round({ round_no: 2, id: "r-2", ended_at: null, elapsed_seconds: null }), // 进行中
      round({ round_no: 3, id: "r-3", elapsed_seconds: 1800 }),
    ];
    const container = render({ rounds, targetRounds: 4, examDate: "2026-12-20", today: "2026-10-06" });

    const ids = Array.from(container.querySelectorAll("[data-round-id]"))
      .map((bar) => bar.getAttribute("data-round-id"));
    expect(ids).toEqual(["r-1", "r-3"]);
    expect(ids).not.toContain("r-2");
  });

  it("按 round_no 升序画（传入乱序也一样）", () => {
    const rounds = [
      round({ round_no: 3, id: "r-3", elapsed_seconds: 1000 }),
      round({ round_no: 1, id: "r-1", elapsed_seconds: 5000 }),
      round({ round_no: 2, id: "r-2", elapsed_seconds: 3000 }),
    ];
    const container = render({ rounds, targetRounds: 4, examDate: "2026-12-20", today: "2026-10-06" });

    const nos = Array.from(container.querySelectorAll("[data-round-no]"))
      .map((bar) => bar.getAttribute("data-round-no"));
    expect(nos).toEqual(["1", "2", "3"]);
  });
});

describe("缩时曲线：两点递减（相对第一轮的降幅）", () => {
  it("第二轮比第一轮快 → 降幅为正、方向正确（两点递减）", () => {
    const rounds = [
      round({ round_no: 1, id: "r-1", elapsed_seconds: 7200 }),
      round({ round_no: 2, id: "r-2", elapsed_seconds: 5400 }),
    ];
    const container = render({ rounds, targetRounds: 4, examDate: "2026-12-20", today: "2026-10-06" });

    // (7200 - 5400) / 7200 = 25%
    expect(container.querySelector('[data-testid="hulu-curve-drop-2"]')?.textContent).toContain("比基准轮快 25%");
    // 第一轮是基准
    expect(container.querySelector('[data-testid="hulu-curve-drop-1"]')?.textContent).toContain("基准轮");
  });

  it("变慢的轮次标「比首轮慢」，不伪装成提速", () => {
    const rounds = [
      round({ round_no: 1, id: "r-1", elapsed_seconds: 3600 }),
      round({ round_no: 2, id: "r-2", elapsed_seconds: 7200 }),
    ];
    const container = render({ rounds, targetRounds: 4, examDate: "2026-12-20", today: "2026-10-06" });

    expect(container.querySelector('[data-testid="hulu-curve-drop-2"]')?.textContent).toContain("比基准轮慢 100%");
  });
});

describe("缩时曲线：剩余轮数与距考天数", () => {
  it("剩余轮数 = 目标轮数 − 已收尾轮数；距考天数按日历日", () => {
    const rounds = [
      round({ round_no: 1, id: "r-1", elapsed_seconds: 3600 }),
      round({ round_no: 2, id: "r-2", elapsed_seconds: 3600 }),
    ];
    const container = render({ rounds, targetRounds: 5, examDate: "2026-10-16", today: "2026-10-06" });

    expect(container.querySelector('[data-testid="hulu-curve-remaining"]')?.textContent).toContain("剩余 3 轮");
    expect(container.querySelector('[data-testid="hulu-curve-days-left"]')?.textContent).toContain("距考试 10 天");
  });

  it("考试日已过 → 明示（不静默显示负数天）", () => {
    const container = render({ rounds: [], targetRounds: 4, examDate: "2026-10-01", today: "2026-10-06" });

    expect(container.querySelector('[data-testid="hulu-curve-days-left"]')?.textContent).toContain("考试日已过");
  });

  it("还没有已收尾轮 → 空态文案（不画假柱子）", () => {
    const container = render({ rounds: [], targetRounds: 4, examDate: "2026-12-20", today: "2026-10-06" });

    expect(container.querySelector('[data-testid="hulu-curve-empty"]')).toBeTruthy();
    expect(container.querySelectorAll("[data-round-id]")).toHaveLength(0);
    expect(container.querySelector('[data-testid="hulu-curve-remaining"]')?.textContent).toContain("剩余 4 轮");
  });
});

describe("缩时曲线：免责声明（两层意思缺一不可）", () => {
  it("① 代理指标、不证明掌握；② 长中断按墙钟计入、使该轮虚高", () => {
    const container = render({
      rounds: [round({ round_no: 1 })], targetRounds: 4, examDate: "2026-12-20", today: "2026-10-06",
    });

    const disclaimer = container.querySelector('[data-testid="hulu-curve-disclaimer"]');
    expect(disclaimer, "免责声明必须存在").toBeTruthy();
    const text = bodyText(disclaimer as HTMLElement);
    // ① 代理指标，不证明掌握
    expect(text).toContain("代理指标");
    expect(text).toContain("不证明掌握");
    expect(text).toContain("背完可能仍然记不住");
    // ② 长中断按墙钟计入 → 虚高
    expect(text).toContain("墙钟");
    expect(text).toContain("虚高");
  });
});

describe("缩时曲线：不引入第二数据源", () => {
  it("组件源码不读计划字数/通过率，也不自己算耗时", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("src/frontend/components/review/HuluSpeedCurve.tsx", "utf8");
    // 只从 rounds 行取数：不碰 words_total / words_passed / pages_passed
    expect(source).not.toContain("words_total");
    expect(source).not.toContain("words_passed");
    expect(source).not.toContain("pages_passed");
    // 不发请求（数据由父组件从 GET /plans/:id 传入）
    expect(source).not.toContain("apiFetch");
    expect(source).not.toContain("fetch(");
  });

  it("R13：可比性判据走 huluSameWordSet（domain 纯函数），不自己实现指纹比较", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("src/frontend/components/review/HuluSpeedCurve.tsx", "utf8");
    expect(source).toContain("huluSameWordSet");
    // 不引 node:crypto（指纹计算在 service 层，前端只比较）
    expect(source).not.toContain("node:crypto");
  });
});

describe("缩时曲线：R13 三态（纯已学 / 含曝光 / 词集漂移不可比）", () => {
  it("纯已学序列（全 recall 同指纹）：基准 = 第 1 轮，其余算降幅", () => {
    const rounds = [
      round({ round_no: 1, id: "r-1", elapsed_seconds: 7200, word_set_fingerprint: "fp-same" }),
      round({ round_no: 2, id: "r-2", elapsed_seconds: 5400, word_set_fingerprint: "fp-same" }),
    ];
    const container = render({ rounds, targetRounds: 4, examDate: "2026-12-20", today: "2026-10-06" });

    expect(container.querySelector('[data-testid="hulu-curve-drop-1"]')?.textContent).toContain("基准轮");
    expect(container.querySelector('[data-testid="hulu-curve-drop-2"]')?.textContent).toContain("比基准轮快 25%");
    // 两轮都可比
    expect(container.querySelector('[data-testid="hulu-curve-bar-1"]')?.getAttribute("data-comparable")).toBe("true");
    expect(container.querySelector('[data-testid="hulu-curve-bar-2"]')?.getAttribute("data-comparable")).toBe("true");
  });

  it("含曝光：曝光轮不进图；基准 = 第一条 recall（不是第 0 轮）", () => {
    const rounds = [
      round({ round_no: 0, kind: "exposure", id: "r-0", elapsed_seconds: 120, word_set_fingerprint: null }),
      round({ round_no: 1, id: "r-1", elapsed_seconds: 7200, word_set_fingerprint: "fp-same" }),
      round({ round_no: 2, id: "r-2", elapsed_seconds: 3600, word_set_fingerprint: "fp-same" }),
    ];
    const container = render({ rounds, targetRounds: 4, examDate: "2026-12-20", today: "2026-10-06" });

    const ids = Array.from(container.querySelectorAll("[data-round-id]")).map((bar) => bar.getAttribute("data-round-id"));
    expect(ids).toEqual(["r-1", "r-2"]);
    expect(ids).not.toContain("r-0");
    // 基准是第 1 轮（recall），不是曝光轮
    expect(container.querySelector('[data-testid="hulu-curve-drop-1"]')?.textContent).toContain("基准轮");
    // 剩余轮数只按复习轮算（2 条已收尾复习轮 → 剩 2）
    expect(container.querySelector('[data-testid="hulu-curve-remaining"]')?.textContent).toContain("剩余 2 轮");
  });

  it("全 legacy 序列：维持旧画法（首个已收尾轮为基准，legacy 不当基准但仍是基准位）", () => {
    const rounds = [
      round({ round_no: 1, kind: "legacy", id: "r-1", elapsed_seconds: 7200, word_set_fingerprint: null }),
      round({ round_no: 2, kind: "legacy", id: "r-2", elapsed_seconds: 5400, word_set_fingerprint: null }),
    ];
    const container = render({ rounds, targetRounds: 4, examDate: "2026-12-20", today: "2026-10-06" });

    // 老计划口径不回改：首个已收尾轮标基准
    expect(container.querySelector('[data-testid="hulu-curve-drop-1"]')?.textContent).toContain("基准轮");
    // 两轮都没有指纹 → 不可比（但第 2 轮照画柱）
    expect(container.querySelector('[data-testid="hulu-curve-bar-2"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="hulu-curve-drop-2"]')?.textContent)
      .toContain("词集已变化，不与基准比较");
  });

  it("legacy 不当基准：含 legacy 的序列里基准 = 第一条 recall", () => {
    const rounds = [
      round({ round_no: 1, kind: "legacy", id: "r-1", elapsed_seconds: 9000, word_set_fingerprint: "fp-old" }),
      round({ round_no: 2, kind: "recall", id: "r-2", elapsed_seconds: 6000, word_set_fingerprint: "fp-new" }),
      round({ round_no: 3, kind: "recall", id: "r-3", elapsed_seconds: 3000, word_set_fingerprint: "fp-new" }),
    ];
    const container = render({ rounds, targetRounds: 4, examDate: "2026-12-20", today: "2026-10-06" });

    // 第 1 轮是 legacy → 不是基准（基准是第 2 轮）
    expect(container.querySelector('[data-testid="hulu-curve-drop-1"]')?.textContent)
      .toContain("词集已变化，不与基准比较");
    expect(container.querySelector('[data-testid="hulu-curve-drop-2"]')?.textContent).toContain("基准轮");
    // 第 3 轮与第 2 轮同指纹 → 可比：比基准快 50%
    expect(container.querySelector('[data-testid="hulu-curve-drop-3"]')?.textContent).toContain("比基准轮快 50%");
  });

  it("词集漂移：指纹不同 → 照画柱但降幅位标「词集已变化，不与基准比较」", () => {
    const rounds = [
      round({ round_no: 1, id: "r-1", elapsed_seconds: 7200, word_set_fingerprint: "fp-before" }),
      round({ round_no: 2, id: "r-2", elapsed_seconds: 3600, word_set_fingerprint: "fp-after" }),
    ];
    const container = render({ rounds, targetRounds: 4, examDate: "2026-12-20", today: "2026-10-06" });

    const bar2 = container.querySelector('[data-testid="hulu-curve-bar-2"]');
    expect(bar2).toBeTruthy();
    // 柱子照画（耗时仍可回溯），但不可比
    expect(bar2?.getAttribute("data-elapsed-seconds")).toBe("3600");
    expect(bar2?.getAttribute("data-comparable")).toBe("false");
    expect(container.querySelector('[data-testid="hulu-curve-drop-2"]')?.textContent)
      .toContain("词集已变化，不与基准比较");
  });

  it("词数相同不构成可比：words_total 相等但指纹不同 → 不可比", () => {
    const rounds = [
      round({ round_no: 1, id: "r-1", elapsed_seconds: 7200, words_total: 24, word_set_fingerprint: "fp-a" }),
      round({ round_no: 2, id: "r-2", elapsed_seconds: 3600, words_total: 24, word_set_fingerprint: "fp-b" }),
    ];
    const container = render({ rounds, targetRounds: 4, examDate: "2026-12-20", today: "2026-10-06" });

    expect(container.querySelector('[data-testid="hulu-curve-drop-2"]')?.textContent)
      .toContain("词集已变化，不与基准比较");
  });
});

describe("缩时曲线：免责声明第三条（R13 词集漂移）", () => {
  it("三条都在：代理指标 / 墙钟虚高 / 只有已结算词集一致的轮才比较耗时", () => {
    const container = render({
      rounds: [round({ round_no: 1 })], targetRounds: 4, examDate: "2026-12-20", today: "2026-10-06",
    });

    const text = bodyText(container.querySelector('[data-testid="hulu-curve-disclaimer"]') as HTMLElement);
    expect(text).toContain("代理指标");
    expect(text).toContain("墙钟");
    // 第三条（R13 追加）
    expect(text).toContain("已结算词集一致");
    expect(text).toContain("词集漂移");
  });
});
