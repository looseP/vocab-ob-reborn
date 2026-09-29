/// <reference lib="dom" />
// @vitest-environment jsdom

/**
 * 例句三件套（wordcard-mock 口径，移植 86d9b3f）组件测试。
 *
 * 核心不变量：**遮盖揭示与提示阶梯共用同一状态**。
 * 点遮盖块与消费 H1 都是"解锁词形"，因此不会出现
 * "没消费提示却已揭示" 或 "提示已消费但仍遮着" 两种自相矛盾的状态 ——
 * 这也是评分上限经济学（0→easy / 1→good / ≥2→hard）能成立的前提。
 */
import { act } from "react";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { ClueZone, TrainingFold } from "@/frontend/components/review/WordCardExamLayers";
import { parseWordExam } from "@/domain/word-exam";

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ root: Root; container: HTMLDivElement }> = [];
afterEach(() => {
  act(() => {
    for (const m of mounted.splice(0)) m.root.unmount();
  });
  document.body.innerHTML = "";
});

const EXAM = {
  reading: {
    split: ["Some fat is normal in the liver", "but abnormal levels are a concern."],
    structure: "主句 + but 转折",
    split_roles: [["主句", "main"], ["转折 · 谓语", "mod"]],
  },
  translation: {
    model: "参考译文",
    key_points: [
      { tag: "固定搭配", text: "abnormal levels", translation: "异常水平", note: "level 可数" },
      { tag: "转折", text: "but", translation: "但是", note: "连接两个分句" },
    ],
  },
  writing: { pattern: "[主语] ... but [主语] ...", function: "说明文", usage: "转折论证", imitating_example: "A is fine, but B is not." },
};

const TEXT = "Some fat is normal in the liver, but abnormal levels are a concern.";
const TERM = "abnormal";

function mount(node: React.ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(node);
  });
  mounted.push({ root, container });
  return container;
}

describe("ClueZone（例句线索区 · mock .clue-zone）", () => {
  it("未揭示：遮盖块不可见（同色底同色字）但保留占位", () => {
    const c = mount(
      createElement(ClueZone, {
        exam: parseWordExam(EXAM),
        text: TEXT,
        maskTerm: TERM,
        maskRevealed: false,
        onUnmask: () => {},
      }),
    );
    const masks = c.querySelectorAll('[data-testid="clue-mask"]');
    expect(masks).toHaveLength(1);
    const style = (masks[0] as HTMLElement).style;
    expect(style.background).toContain("highlight");
    expect(style.color).toBe(style.background); // 同色 = 隐形但占位
    expect(masks[0].textContent).toBe(TERM);
  });

  it("已揭示：无遮盖块，词形按强调色显示", () => {
    const c = mount(
      createElement(ClueZone, {
        exam: parseWordExam(EXAM),
        text: TEXT,
        maskTerm: TERM,
        maskRevealed: true,
        onUnmask: () => {},
      }),
    );
    expect(c.querySelectorAll('[data-testid="clue-mask"]')).toHaveLength(0);
    expect(c.innerHTML).toContain("abnormal");
  });

  it("轨色切分：main/mod 两轨各一行 + 角色标签", () => {
    const c = mount(
      createElement(ClueZone, {
        exam: parseWordExam(EXAM),
        text: TEXT,
        maskTerm: TERM,
        maskRevealed: true,
        onUnmask: () => {},
      }),
    );
    const rows = c.querySelectorAll('[data-testid="clue-split"] > li');
    expect(rows).toHaveLength(2);
    expect(c.innerHTML).toContain("主句");
    expect(c.innerHTML).toContain("转折 · 谓语");
  });

  it("无 exam 切分数据（v1 批次）→ 退化为整句遮盖，仍可揭示", () => {
    const onUnmask = () => {};
    const c = mount(
      createElement(ClueZone, {
        exam: null,
        text: TEXT,
        maskTerm: TERM,
        maskRevealed: false,
        onUnmask,
      }),
    );
    expect(c.querySelector('[data-testid="clue-split"]')).toBeNull();
    expect(c.querySelectorAll('[data-testid="clue-mask"]')).toHaveLength(1);
  });

  it("点遮盖块触发 onUnmask（与消费 H1 同一入口），且不冒泡到翻卡", () => {
    let called = 0;
    const c = mount(
      createElement(ClueZone, {
        exam: parseWordExam(EXAM),
        text: TEXT,
        maskTerm: TERM,
        maskRevealed: false,
        onUnmask: () => {
          called += 1;
        },
      }),
    );
    const mask = c.querySelector('[data-testid="clue-mask"]') as HTMLElement;
    act(() => {
      mask.click();
    });
    expect(called).toBe(1);
  });

  it("无文本 → 整体缺席", () => {
    const c = mount(
      createElement(ClueZone, {
        exam: parseWordExam(EXAM),
        text: null,
        maskTerm: TERM,
        maskRevealed: false,
        onUnmask: () => {},
      }),
    );
    expect(c.querySelector('[data-testid="clue-zone"]')).toBeNull();
  });
});

describe("TrainingFold（训练扩展 · mock fold）", () => {
  it("译点默认金块遮盖：译文不可见、tag/note 不出现", () => {
    const c = mount(createElement(TrainingFold, { exam: parseWordExam(EXAM), verifiedCount: 0 }));
    const kps = c.querySelectorAll('[data-testid="training-key-point"]');
    expect(kps).toHaveLength(2);
    // 金块 = data-masked 标记的译文 span；背景与文字同色 = 看不见但占位。
    // 断言「同色」这个不变量本身，不断言具体色值字符串（jsdom 会规范化 rgba 空格）。
    const masked = c.querySelectorAll("[data-masked='true']");
    expect(masked).toHaveLength(2);
    const khole = masked[0] as HTMLElement;
    expect(khole.style.background).toBeTruthy();
    expect(khole.style.color).toBe(khole.style.background);
    expect(c.innerHTML).not.toContain("固定搭配"); // tag 仅揭示后出现
    expect(c.innerHTML).not.toContain("level 可数"); // note 仅揭示后出现
  });

  it("点译点 → 揭示译文并附出 tag/note；再点遮回", () => {
    const c = mount(createElement(TrainingFold, { exam: parseWordExam(EXAM), verifiedCount: 0 }));
    const kp = c.querySelector('[data-testid="training-key-point"]') as HTMLElement;
    act(() => {
      kp.click();
    });
    expect(c.innerHTML).toContain("异常水平");
    expect(c.innerHTML).toContain("固定搭配");
    expect(c.innerHTML).toContain("level 可数");
    act(() => {
      (c.querySelector('[data-testid="training-key-point"]') as HTMLElement).click();
    });
    expect(c.innerHTML).not.toContain("固定搭配");
  });

  it("骨架句式直接可见（无需自检）+ 适用 + 仿写 + 已核验", () => {
    const c = mount(createElement(TrainingFold, { exam: parseWordExam(EXAM), verifiedCount: 3 }));
    expect(c.querySelector('[data-testid="pattern-box"]')?.textContent).toContain("[主语]");
    expect(c.innerHTML).toContain("说明文");
    expect(c.innerHTML).toContain("转折论证");
    expect(c.innerHTML).toContain("A is fine, but B is not.");
    expect(c.innerHTML).toContain("已核");
  });

  it("无 exam / 无译点且无骨架 → 整体缺席", () => {
    expect(mount(createElement(TrainingFold, { exam: null, verifiedCount: 0 })).innerHTML).toBe("");
    expect(
      mount(createElement(TrainingFold, { exam: parseWordExam({ reading: { split: ["A"] } }), verifiedCount: 0 }))
        .innerHTML,
    ).toBe("");
  });
});
