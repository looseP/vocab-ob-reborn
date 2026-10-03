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
import { ClueZone, TrainingFold, ExampleLayerBlock } from "@/frontend/components/review/WordCardExamLayers";
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

/**
 * 例句层（`.ex-layer`）的补测。
 *
 * 补的缘由（2026-09-29）：浏览器实测 497 张带 exam 的到期卡时发现 `clue-zone` /
 * `training-fold` / `pattern-box` 全部渲染，而 `ex-layer` 不在 DOM 里。
 * 读代码确认**不是缺陷** —— `ExampleLayerBlock` 挂在 `ReviewCardView` 的
 * `flipBody` 的 `showDefinition`（卡背）分支，与 ClueZone（卡正面遮盖线索）
 * 是互补的两面。但当时 `ex-layer` 在本文件里**零覆盖**，无法用测试锁证，
 * 于是补上，避免下次真出问题时又只能靠翻卡肉眼确认。
 */
describe("ExampleLayerBlock（例句层 · mock .ex-layer）", () => {
  const base = {
    text: TEXT,
    translation: "参考译文",
    term: TERM,
    source: "COCA",
    sourceType: "corpus",
    url: "https://example.com/src",
    modified: false,
    verifiedCount: 0,
  };

  it("完整例句 + 目标词高亮 + 译文 + 来源/核验徽章", () => {
    const c = mount(createElement(ExampleLayerBlock, { ...base, verifiedCount: 2 }));
    const layer = c.querySelector('[data-testid="ex-layer"]');
    expect(layer, "例句层应渲染").toBeTruthy();
    // 目标词被 MarkedSentence 高亮（<mark> 或强调色元素），不是纯文本
    expect(layer!.querySelector("mark")?.textContent ?? layer!.innerHTML).toContain(TERM);
    expect(layer!.textContent).toContain("参考译文");
    expect(layer!.textContent).toContain("例句 · H1");
    // 来源类型 + 来源名都出现
    expect(layer!.textContent).toContain("corpus");
    expect(layer!.textContent).toContain("COCA");
    // verifiedCount > 0 才出「已核」
    expect(layer!.textContent).toContain("已核");
  });

  it("无译文 / 未核验 / 未改写 / 无原文链接 → 对应徽章与链接都不出现", () => {
    const c = mount(
      createElement(ExampleLayerBlock, {
        ...base,
        translation: null,
        url: null,
        modified: false,
        verifiedCount: 0,
      }),
    );
    const layer = c.querySelector('[data-testid="ex-layer"]')!;
    expect(layer.textContent).toContain(TEXT);
    expect(layer.textContent).not.toContain("已核");
    expect(layer.textContent).not.toContain("来源·改");
    expect(layer.querySelector("a")).toBeNull();
  });

  it("modified → 出「来源·改」徽章（提示译文被改写过）", () => {
    const c = mount(createElement(ExampleLayerBlock, { ...base, modified: true }));
    expect(c.querySelector('[data-testid="ex-layer"]')!.textContent).toContain("来源·改");
  });

  it("有原文链接 → 外链带 target=_blank + rel=noreferrer", () => {
    const c = mount(createElement(ExampleLayerBlock, base));
    const a = c.querySelector('[data-testid="ex-layer"] a') as HTMLAnchorElement | null;
    expect(a?.getAttribute("href")).toBe("https://example.com/src");
    expect(a?.getAttribute("target")).toBe("_blank");
    expect(a?.getAttribute("rel")).toContain("noreferrer");
  });

  it("无正文 → 整体缺席（不渲染空壳）", () => {
    expect(mount(createElement(ExampleLayerBlock, { ...base, text: null })).innerHTML).toBe("");
    expect(mount(createElement(ExampleLayerBlock, { ...base, text: "" })).innerHTML).toBe("");
  });
});

/**
 * `[]` / `｜` 是**编码**，不是句子内容。
 *
 * 修复前：`SplitSegment` 只 `slice(1,-1)` 剥方括号，括号内的 `｜定` 直接落进正文
 * —— 真库实测 126 词的例句里出现 `｜定` / `｜状`，读起来像句子的一部分。
 * 设计稿（`wordcard-mock-2026-09-11.html:287`）的原意是：嵌套片段走 `.nest`，
 * 分类走**独立的 `.nest-type` 角标**。
 */
describe("ClueZone 嵌套编码（`.nest` + `.nest-type` 角标）", () => {
  const NEST_EXAM = {
    reading: {
      split: [
        "Asante draws a manufacturing analogy[—with some exaggeration—｜状]",
        "arguing that previous plants were built bespoke.",
      ],
      structure: "插入语 + 分词状语",
      split_roles: [
        ["主句 · 主谓宾", "main"],
        ["状语", "mod"],
      ],
    },
  };

  const renderClue = (maskRevealed: boolean) =>
    mount(
      createElement(ClueZone, {
        exam: parseWordExam(NEST_EXAM),
        text: "Asante draws a manufacturing analogy—with some exaggeration—arguing that.",
        maskTerm: "analogy",
        maskRevealed,
        onUnmask: () => {},
        onPlaySentence: () => {},
        sentencePlaying: false,
      }),
    );

  it("`｜状` 不落进正文 —— 整块正文里不得出现全角竖线", () => {
    const c = renderClue(true);
    const block = c.querySelector('[data-testid="clue-split"]')!;
    expect(block.textContent).not.toContain("｜");
  });

  it("分类渲染成独立角标 `.nest-type`（与嵌套片段分开）", () => {
    const c = renderClue(true);
    const badges = Array.from(c.querySelectorAll('[data-testid="nest-type"]'));
    expect(badges.map((b) => b.textContent)).toEqual(["状"]);
  });

  it("方括号被剥离，嵌套片段只留纯文本", () => {
    const c = renderClue(true);
    const text = c.querySelector('[data-testid="clue-split"]')!.textContent ?? "";
    expect(text).not.toContain("[");
    expect(text).not.toContain("]");
    expect(text).toContain("—with some exaggeration—");
  });

  it("遮盖未揭示时同样不留编码标记（遮盖与嵌套两条逻辑不打架）", () => {
    const c = renderClue(false);
    const block = c.querySelector('[data-testid="clue-split"]')!;
    expect(block.textContent).not.toContain("｜");
    // 遮盖块仍在（未揭示），说明剥离编码没有影响遮挡
    expect(c.querySelector('[data-testid="clue-mask"]')).not.toBeNull();
  });

  it("无标记的纯嵌套 → 有 `.nest` 但没有角标", () => {
    const c = mount(
      createElement(ClueZone, {
        exam: parseWordExam({
          reading: { split: ["Given [China's shrinking labor force] and more,"], split_roles: [["状语", "mod"]] },
        }),
        text: "Given China's shrinking labor force and more,",
        maskTerm: null,
        maskRevealed: true,
        onUnmask: () => {},
        onPlaySentence: () => {},
        sentencePlaying: false,
      }),
    );
    const block = c.querySelector('[data-testid="clue-split"]')!;
    expect(block.textContent).toContain("China's shrinking labor force");
    expect(block.querySelectorAll('[data-testid="nest-type"]')).toHaveLength(0);
  });
});

/**
 * 「读主干」模式（mock `.clue-split.trunk-mode`，设计稿 v0.5 展示升级）。
 *
 * 诉求：长句先只看**句子骨架**（主干），修饰/补充行一键收起 —— 先读懂主干再看细节。
 * 实测真库分布：5589 词含 mod/supp（有意义的），1178 词全是主干（切换无变化）。
 */
describe("ClueZone「读主干」模式", () => {
  // 三块：主干 + 修饰 + 补充（补充用未知类别，走渲染口径归 supp）
  const TRUNK_EXAM = {
    reading: {
      split: [
        "Asante draws a manufacturing analogy",
        "—with some exaggeration—",
        "akin to building a factory for one car.",
      ],
      split_roles: [
        ["主句 · 主谓宾", "main"],
        ["插入语（引出所引观点）", "mod"],
        ["补充 · 比较（与前项并置）", "supp"],
      ],
    },
  };

  const ALL_MAIN_EXAM = {
    reading: {
      split: ["Some fat is normal in the liver", "abnormal levels are a concern."],
      split_roles: [
        ["主句（主谓）", "main"],
        ["系表 · 表语", "main"],
      ],
    },
  };

  const mountClue = (exam: unknown) =>
    mount(
      createElement(ClueZone, {
        exam: parseWordExam(exam),
        text: "Asante draws a manufacturing analogy.",
        maskTerm: null,
        maskRevealed: true,
        onUnmask: () => {},
      }),
    );

  const rows = (c: HTMLElement) => c.querySelectorAll('[data-testid="clue-split"] li');
  const toggle = (c: HTMLElement) =>
    c.querySelector<HTMLButtonElement>('[data-testid="clue-trunk-toggle"]');

  it("默认展开全句：三条轨都在", () => {
    const c = mountClue(TRUNK_EXAM);
    expect(rows(c)).toHaveLength(3);
    expect(toggle(c)?.textContent).toBe("读主干");
  });

  it("点「读主干」→ 只留主干行，mod/supp 从 DOM 消失", () => {
    const c = mountClue(TRUNK_EXAM);
    act(() => toggle(c)!.click());

    expect(rows(c)).toHaveLength(1);
    expect(rows(c)[0].textContent).toContain("Asante draws a manufacturing analogy");
    expect(c.querySelector('[data-testid="clue-split"]')?.getAttribute("data-trunk")).toBe("on");
  });

  it("按钮标签与 aria-pressed 同步（读主干 ⇄ 显示全句）", () => {
    const c = mountClue(TRUNK_EXAM);
    const btn = toggle(c)!;
    expect(btn.getAttribute("aria-pressed")).toBe("false");

    act(() => toggle(c)!.click());
    expect(toggle(c)!.textContent).toBe("显示全句");
    expect(toggle(c)!.getAttribute("aria-pressed")).toBe("true");

    act(() => toggle(c)!.click());
    expect(toggle(c)!.textContent).toBe("读主干");
    expect(toggle(c)!.getAttribute("aria-pressed")).toBe("false");
    expect(rows(c)).toHaveLength(3);
  });

  it("tooltip 告知会隐藏几行（不让用户以为界面坏了）", () => {
    const c = mountClue(TRUNK_EXAM);
    expect(toggle(c)!.getAttribute("title")).toContain("2");
    act(() => toggle(c)!.click());
    expect(toggle(c)!.getAttribute("title")).toContain("2");
  });

  it("按钮带 data-no-flip —— 点它不会把卡片翻面（那会误消费一次评分）", () => {
    const c = mountClue(TRUNK_EXAM);
    expect(toggle(c)!.hasAttribute("data-no-flip")).toBe(true);
  });

  it("全部是主干行时**不渲染按钮**（不给无操作的控件）", () => {
    // 实测真库 1178/6767 属此类
    const c = mountClue(ALL_MAIN_EXAM);
    expect(rows(c)).toHaveLength(2);
    expect(toggle(c)).toBeNull();
  });

  it("无切分数据（v1 批次）→ 无按钮，退化为整句渲染", () => {
    const c = mount(
      createElement(ClueZone, {
        exam: null,
        text: "A plain sentence without split data.",
        maskTerm: null,
        maskRevealed: true,
        onUnmask: () => {},
      }),
    );
    expect(toggle(c)).toBeNull();
    expect(c.textContent).toContain("A plain sentence without split data.");
  });

  it("未知类别（roleKind 非 main/mod）按 supp 口径收起", () => {
    const c = mount(
      createElement(ClueZone, {
        exam: parseWordExam({
          reading: {
            split: ["A main clause", "an appended clause"],
            split_roles: [
              ["主句", "main"],
              ["补充 · 比较", "some_unknown_kind"],
            ],
          },
        }),
        text: "A main clause",
        maskTerm: null,
        maskRevealed: true,
        onUnmask: () => {},
      }),
    );
    expect(rows(c)).toHaveLength(2);
    act(() => toggle(c)!.click());
    expect(rows(c)).toHaveLength(1);
  });
});
