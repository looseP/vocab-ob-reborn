/// <reference lib="dom" />
// @vitest-environment jsdom
/**
 * 官方证据录入器（2026-09-26）。
 *
 * 这是"让人手填 offset"与"在原文里框选"之间的分界：测试锁死后者真的能用 ——
 * 选区 → 最小句段 → 锚点区间落在正文内，且重复/越界/无选区都**如实提示**而不是
 * 静默产生一个坏锚点。
 */
import { act } from "react";
import { createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { fireEvent, screen, waitFor } from "@testing-library/dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/frontend/api/client", () => ({ apiFetch: vi.fn() }));
import { apiFetch } from "@/frontend/api/client";
import { QuestionEvidenceEditor, type EvidenceAnchor } from "@/frontend/components/l3/QuestionEvidenceEditor";

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

const SOURCE_ID = "00000000-0000-4000-8000-000000000302";
/**
 * 两行正文（换行用 fromCharCode 显式构造：证据锚点靠换行分句，夹具必须**真的**
 * 含换行，逃逸写法在此环境下不可靠 —— 夹具本身坏掉时断言会指向错误的原因）。
 */
const NL = String.fromCharCode(10);
const PASSAGE = ["The trend will continue.", "Growth is expected next year."].join(NL);
/** 首句区间 = [0, 换行位置)；第二句 = [换行+1, 末尾]。用算出来的边界，不写死偏移。 */
const SENTENCE_ONE = { start: 0, end: PASSAGE.indexOf(NL) };
const SENTENCE_TWO = { start: PASSAGE.indexOf(NL) + 1, end: PASSAGE.length };

const mounted: Array<{ root: Root; container: HTMLDivElement }> = [];

function mockDetail(content: string | null = PASSAGE) {
  (apiFetch as ReturnType<typeof vi.fn>).mockImplementation(async () => ({
    question_type: "reading_choice",
    source: { id: SOURCE_ID, title: "2023 Text2" },
    source_content: content,
    file_key: null,
    questions: [],
  }));
}

/**
 * 在正文块里造一个覆盖 [from,to) 字符的选区（真实 Selection 对象，走同一路径）。
 * ⚠️ 每次 locate 都新建 TreeWalker —— 复用已耗尽的 walker 会让第二次查询从下一个
 * 文本节点开始（曾把本组件误判成 bug）。
 */
function selectWithin(from: number, to: number): void {
  const host = screen.getByTestId("evidence-passage");
  const locate = (offset: number): { node: Text; local: number } => {
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
    let seen = 0;
    let current = walker.nextNode() as Text | null;
    while (current) {
      const next = seen + (current.textContent?.length ?? 0);
      if (offset <= next) return { node: current, local: offset - seen };
      seen = next;
      current = walker.nextNode() as Text | null;
    }
    throw new Error(`offset ${offset} 超出渲染文本长度`);
  };
  const start = locate(from);
  const end = locate(to);
  const range = document.createRange();
  range.setStart(start.node, start.local);
  range.setEnd(end.node, end.local);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

async function mount(props: Partial<React.ComponentProps<typeof QuestionEvidenceEditor>> = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  const onChange = props.onChange ?? vi.fn();
  const onError = props.onError ?? vi.fn();
  await act(async () => {
    root.render(createElement(QuestionEvidenceEditor, {
      sourceId: SOURCE_ID,
      fileKey: null,
      questionType: "reading_choice",
      anchors: [],
      onChange,
      onError,
      ...props,
    } as never) as ReactElement);
    await Promise.resolve();
  });
  return { onChange: onChange as ReturnType<typeof vi.fn>, onError: onError as ReturnType<typeof vi.fn> };
}

async function openEditor() {
  await act(async () => {
    fireEvent.click(screen.getByTestId("evidence-toggle"));
    await Promise.resolve();
  });
  await waitFor(() => expect(screen.getByTestId("evidence-passage")).toBeTruthy());
}

afterEach(() => {
  act(() => {
    for (const { root } of mounted.splice(0)) root.unmount();
  });
  document.body.innerHTML = "";
  window.getSelection()?.removeAllRanges();
});

beforeEach(() => {
  vi.clearAllMocks();
  mockDetail();
});

describe("QuestionEvidenceEditor", () => {
  it("默认收起；点开才拉原文（懒加载，不打扰只建题的用户）", async () => {
    await mount();
    expect(screen.queryByTestId("evidence-passage")).toBeNull();
    expect(apiFetch).not.toHaveBeenCalled();
    await openEditor();
    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(String((apiFetch as ReturnType<typeof vi.fn>).mock.calls[0]![0]))
      .toContain(`/l3/practice-files/detail?questionType=reading_choice&sourceId=${SOURCE_ID}`);
  });

  it("无阅读材料的题型：说明证据不适用，不给假入口", async () => {
    await mount({ sourceId: null, fileKey: "writing:essay-set", questionType: "long_essay" });
    expect(screen.getByText(/官方证据不适用/)).toBeTruthy();
    expect(screen.queryByTestId("evidence-toggle")).toBeNull();
  });

  it("框选一句 → 锚点扩到最小句段（含句读），并给自动标签", async () => {
    const { onChange } = await mount();
    await openEditor();
    // 选 "trend"（句中一段）→ 应扩到整句 "The trend will continue."
    selectWithin(4, 9);
    await act(async () => {
      fireEvent.click(screen.getByTestId("evidence-capture"));
      await Promise.resolve();
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0]![0] as EvidenceAnchor[];
    expect(next).toHaveLength(1);
    expect(PASSAGE.slice(next[0]!.start, next[0]!.end)).toBe("The trend will continue.");
    expect(next[0]!.label.length).toBeLessThanOrEqual(40);
  });

  it("跨行选区也扩到句段（换行是边界）", async () => {
    const { onChange } = await mount();
    await openEditor();
    const secondLine = PASSAGE.indexOf("Growth") + 2;
    selectWithin(secondLine, secondLine + 3);
    await act(async () => {
      fireEvent.click(screen.getByTestId("evidence-capture"));
      await Promise.resolve();
    });
    const next = onChange.mock.calls[0]![0] as EvidenceAnchor[];
    expect(PASSAGE.slice(next[0]!.start, next[0]!.end)).toBe("Growth is expected next year.");
  });

  it("已有锚点在列表里可见（能看到标到了哪句 + 区间），可移除", async () => {
    const anchors: EvidenceAnchor[] = [{ ...SENTENCE_ONE, label: "首句" }];
    const onChange = vi.fn();
    await mount({ anchors, onChange });
    await openEditor();
    expect(screen.getByTestId("evidence-item").textContent).toContain("首句");
    expect(screen.getByTestId("evidence-item").textContent).toContain(`[${SENTENCE_ONE.start}, ${SENTENCE_ONE.end})`);
    await act(async () => {
      fireEvent.click(screen.getByTestId("evidence-remove"));
      await Promise.resolve();
    });
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it("重复标注同一句 → 如实提示，不产生重复锚点", async () => {
    const anchors: EvidenceAnchor[] = [{ ...SENTENCE_ONE, label: "首句" }];
    const { onChange, onError } = await mount({ anchors });
    await openEditor();
    selectWithin(4, 9);
    await act(async () => {
      fireEvent.click(screen.getByTestId("evidence-capture"));
      await Promise.resolve();
    });
    expect(onChange).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.stringContaining("已经是证据"));
  });

  it("没有选区 → 提示先选中（不静默）", async () => {
    const { onChange, onError } = await mount();
    await openEditor();
    window.getSelection()?.removeAllRanges();
    await act(async () => {
      fireEvent.click(screen.getByTestId("evidence-capture"));
      await Promise.resolve();
    });
    expect(onChange).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.stringContaining("请先在原文里选中"));
  });

  it("原文加载失败 → 明确失败态 + 可重试", async () => {
    (apiFetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("boom"));
    await mount();
    await act(async () => {
      fireEvent.click(screen.getByTestId("evidence-toggle"));
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByText(/原文加载失败/)).toBeTruthy());
    expect(screen.getByText("重试")).toBeTruthy();
  });

  it("「清空全部」一次性清空", async () => {
    const onChange = vi.fn();
    await mount({ anchors: [{ ...SENTENCE_ONE, label: "a" }, { ...SENTENCE_TWO, label: "b" }], onChange });
    expect(screen.getByTestId("evidence-clear")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByTestId("evidence-clear"));
      await Promise.resolve();
    });
    expect(onChange).toHaveBeenCalledWith([]);
  });
});
