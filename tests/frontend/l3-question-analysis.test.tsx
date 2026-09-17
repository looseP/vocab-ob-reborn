/// <reference lib="dom" />
// @vitest-environment jsdom

import { act } from "react";
import { createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { fireEvent, screen, within } from "@testing-library/dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { L3QuestionAnalysis } from "@/frontend/components/l3/L3QuestionAnalysis";
import type { L3Attempt, QuestionAnnotation } from "@/frontend/api/l3Client";

const QUESTION_ID = "00000000-0000-4000-8000-000000000101";

const question = {
  id: QUESTION_ID,
  ordinal: 0,
  stem: "21. 题干",
  options: [
    { key: "A", text: "选项甲" },
    { key: "B", text: "选项乙" },
    { key: "C", text: "选项丙" },
    { key: "D", text: "选项丁" },
  ],
  answer: { choice: "B" },
  explanation: null,
};

const anchored: QuestionAnnotation = {
  id: "ann-1",
  question_id: QUESTION_ID,
  ordinal: 0,
  anchor_start: 12,
  anchor_end: 20,
  excerpt: "trap phrase",
  note: "B 项偷换主语",
  entry_tags: ["推断题"],
  option_tags: { B: ["偷换概念"] },
  stage: "confirmed",
  sheet_id: null,
  review: null,
  status: "active",
  created_at: "2026-09-16T00:00:00Z",
  updated_at: "2026-09-16T00:00:00Z",
};

const loose: QuestionAnnotation = {
  id: "ann-2",
  question_id: QUESTION_ID,
  ordinal: 1,
  anchor_start: null,
  anchor_end: null,
  excerpt: null,
  note: "整题考查主旨归纳",
  entry_tags: ["主旨题"],
  option_tags: {},
  stage: "confirmed",
  sheet_id: null,
  review: null,
  status: "active",
  created_at: "2026-09-16T00:00:00Z",
  updated_at: "2026-09-16T00:00:00Z",
};

const submitted: QuestionAnnotation = {
  id: "ann-3",
  question_id: QUESTION_ID,
  ordinal: 2,
  anchor_start: 4,
  anchor_end: 9,
  excerpt: "phrase",
  note: "待检验的草稿注记",
  entry_tags: ["推断题"],
  option_tags: {},
  stage: "submitted",
  sheet_id: "00000000-0000-4000-8000-000000000401",
  review: null,
  status: "active",
  created_at: "2026-09-16T00:00:00Z",
  updated_at: "2026-09-16T00:00:00Z",
};

const tagDict = {
  entry: ["细节题", "推断题", "主旨题", "态度题", "词汇题", "例证题"],
  option: ["同义替换", "偷换概念", "无中生有", "过度推断", "正反颠倒", "张冠李戴", "答非所问"],
};

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

/** 每个 fireEvent 独立 act 步：仓库无 @testing-library/react，事件间状态需手动让出 flush。 */
async function userEvent(emitter: () => void): Promise<void> {
  await act(async () => {
    emitter();
    await Promise.resolve();
    await Promise.resolve();
  });
}

const mountedRoots: Root[] = [];
async function renderAnalysis(overrides: Record<string, unknown> = {}): Promise<{
  onLocate: ReturnType<typeof vi.fn>;
  onCreate: ReturnType<typeof vi.fn>;
  onPatch: ReturnType<typeof vi.fn>;
  onDelete: ReturnType<typeof vi.fn>;
  onWithdraw: ReturnType<typeof vi.fn>;
  onSaveTagDict: ReturnType<typeof vi.fn>;
}> {
  const fns = {
    onLocate: vi.fn(),
    onCreate: vi.fn(async () => undefined),
    onPatch: vi.fn(async () => undefined),
    onDelete: vi.fn(async () => undefined),
    onWithdraw: vi.fn(async () => undefined),
    onSaveTagDict: vi.fn(async () => undefined),
  };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  const props = { question, annotations: [anchored, loose], tagDict, ...fns, ...overrides };
  await act(async () => {
    root.render(createElement(L3QuestionAnalysis, props as never) as ReactElement);
    await Promise.resolve();
    await Promise.resolve();
  });
  return fns;
}

async function expandSection(): Promise<void> {
  await userEvent(() => fireEvent.click(screen.getByRole("button", { name: /原文分析/ })));
}

afterEach(() => {
  act(() => {
    for (const root of mountedRoots.splice(0)) root.unmount();
  });
  document.body.innerHTML = "";
});

describe("L3QuestionAnalysis 折叠子区", () => {
  it("默认折叠，标题显示计数徽标且不渲染条目内容", async () => {
    await renderAnalysis();
    const header = screen.getByRole("button", { name: /原文分析/ });
    expect(header.textContent).toContain("原文分析");
    expect(header.textContent).toContain("2");
    expect(screen.queryByText("B 项偷换主语")).toBeNull();
  });

  it("展开后渲染摘录/笔记/题型与选项标签", async () => {
    await renderAnalysis();
    await expandSection();
    expect(screen.getByText("B 项偷换主语")).toBeTruthy();
    expect(screen.getByText("整题考查主旨归纳")).toBeTruthy();
    expect(screen.getAllByText("推断题").length).toBeGreaterThan(0);
    expect(screen.getAllByText("偷换概念").length).toBeGreaterThan(0);
  });

  it("有锚点条目提供定位钮，无锚点条目不提供", async () => {
    const { onLocate } = await renderAnalysis();
    await expandSection();
    const locateButtons = screen.getAllByRole("button", { name: /定位/ });
    expect(locateButtons).toHaveLength(1);
    await userEvent(() => fireEvent.click(locateButtons[0]!));
    expect(onLocate).toHaveBeenCalledWith({ start: 12, end: 20 });
  });
});

describe("L3QuestionAnalysis 新增/编辑/删除", () => {
  it("无锚点新增条目：写笔记+选题型后提交 onCreate", async () => {
    const { onCreate } = await renderAnalysis();
    await expandSection();
    await userEvent(() => fireEvent.click(screen.getByRole("button", { name: /添加条目/ })));
    await userEvent(() => fireEvent.change(screen.getByLabelText("分析笔记"), { target: { value: "这题考态度" } }));
    await userEvent(() => fireEvent.click(screen.getByRole("button", { name: "态度题" })));
    await userEvent(() => fireEvent.click(screen.getByRole("button", { name: "保存条目" })));
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({
      questionId: QUESTION_ID,
      note: "这题考态度",
      entryTags: ["态度题"],
    }));
  });

  it("空表单提交被前端拦截，不调 onCreate", async () => {
    const { onCreate } = await renderAnalysis();
    await expandSection();
    await userEvent(() => fireEvent.click(screen.getByRole("button", { name: /添加条目/ })));
    await userEvent(() => fireEvent.click(screen.getByRole("button", { name: "保存条目" })));
    expect(onCreate).not.toHaveBeenCalled();
  });

  it("删除条目调用 onDelete", async () => {
    const { onDelete } = await renderAnalysis();
    await expandSection();
    const list = screen.getByText("B 项偷换主语").closest("li")!;
    await userEvent(() => fireEvent.click(within(list).getByRole("button", { name: "删除" })));
    expect(onDelete).toHaveBeenCalledWith("ann-1");
  });

  it("编辑已有条目时提交 onPatch（题型标签可改）", async () => {
    const { onPatch } = await renderAnalysis();
    await expandSection();
    const list = screen.getByText("整题考查主旨归纳").closest("li")!;
    await userEvent(() => fireEvent.click(within(list).getByRole("button", { name: "编辑" })));
    await userEvent(() => fireEvent.click(screen.getByRole("button", { name: "态度题" })));
    await userEvent(() => fireEvent.click(screen.getByRole("button", { name: "保存条目" })));
    expect(onPatch).toHaveBeenCalledWith("ann-2", expect.objectContaining({
      entryTags: expect.arrayContaining(["主旨题", "态度题"]),
    }));
  });
});

describe("L3QuestionAnalysis 撤回收口（submitted 锁定，v2 §4.7 验收）", () => {
  it("submitted 注记：显示「已提交」徽标与「撤回」按钮（无「编辑」，保留「删除」）", async () => {
    await renderAnalysis({ annotations: [submitted] });
    await expandSection();
    const list = screen.getByText("待检验的草稿注记").closest("li")!;
    expect(within(list).getByText("已提交")).toBeTruthy();
    expect(within(list).getByRole("button", { name: "撤回" })).toBeTruthy();
    expect(within(list).queryByRole("button", { name: "编辑" })).toBeNull();
    expect(within(list).getByRole("button", { name: "删除" })).toBeTruthy();
  });

  it("点击「撤回」调用 onWithdraw（stopPropagation，折叠区不受影响）", async () => {
    const { onWithdraw } = await renderAnalysis({ annotations: [submitted] });
    await expandSection();
    const list = screen.getByText("待检验的草稿注记").closest("li")!;
    await userEvent(() => fireEvent.click(within(list).getByRole("button", { name: "撤回" })));
    expect(onWithdraw).toHaveBeenCalledWith("ann-3");
    expect(within(list).getByRole("button", { name: "撤回" })).toBeTruthy();
  });

  it("draft/confirmed 注记不受影响：无「已提交」徽标，编辑钮在位（回归）", async () => {
    await renderAnalysis();
    await expandSection();
    expect(screen.queryByText("已提交")).toBeNull();
    expect(screen.getAllByRole("button", { name: "编辑" })).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "撤回" })).toBeNull();
  });
});

describe("L3QuestionAnalysis 选项打标浮层", () => {
  it("为 B 选项勾选错误类型并随新增提交；Esc 关闭浮层", async () => {
    const { onCreate } = await renderAnalysis();
    await expandSection();
    await userEvent(() => fireEvent.click(screen.getByRole("button", { name: /添加条目/ })));
    await userEvent(() => fireEvent.click(screen.getByRole("button", { name: "B 打标" })));
    expect(screen.getByRole("dialog", { name: /B 选项打标/ })).toBeTruthy();
    await userEvent(() => fireEvent.click(screen.getByRole("button", { name: "无中生有" })));
    await userEvent(() => fireEvent.keyDown(document.body, { key: "Escape" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    await userEvent(() => fireEvent.change(screen.getByLabelText("分析笔记"), { target: { value: "B 无依据" } }));
    await userEvent(() => fireEvent.click(screen.getByRole("button", { name: "保存条目" })));
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({
      optionTags: { B: ["无中生有"] },
    }));
  });

  it("浮层内新建标签：先 PUT 字典再选中", async () => {
    const { onSaveTagDict, onCreate } = await renderAnalysis();
    await expandSection();
    await userEvent(() => fireEvent.click(screen.getByRole("button", { name: /添加条目/ })));
    await userEvent(() => fireEvent.click(screen.getByRole("button", { name: "B 打标" })));
    await userEvent(() => fireEvent.change(screen.getByPlaceholderText("新标签名"), { target: { value: "以偏概全" } }));
    await userEvent(() => fireEvent.click(screen.getByRole("button", { name: "＋新建" })));
    expect(onSaveTagDict).toHaveBeenCalledWith(expect.objectContaining({
      option: expect.arrayContaining(["以偏概全"]),
    }));
    await userEvent(() => fireEvent.keyDown(document.body, { key: "Escape" }));
    await userEvent(() => fireEvent.change(screen.getByLabelText("分析笔记"), { target: { value: "带新标签" } }));
    await userEvent(() => fireEvent.click(screen.getByRole("button", { name: "保存条目" })));
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({
      optionTags: { B: ["以偏概全"] },
    }));
  });
});

describe("L3QuestionAnalysis 批次二：历史徽标与覆盖度", () => {
  const attemptFixture = (overrides: Partial<L3Attempt> = {}): L3Attempt => ({
    id: "00000000-0000-4000-8000-000000000501",
    user_id: "00000000-0000-4000-8000-000000000001",
    question_id: QUESTION_ID,
    sheet_id: null,
    venue: "file",
    answer: { choice: "B" },
    self_assessment: null,
    status: "active",
    deleted_at: null,
    created_at: "2026-09-17T01:00:00Z",
    ...overrides,
  });

  it("显示作答徽标「做过 N 次」，点击触发 onOpenHistory", async () => {
    const onOpenHistory = vi.fn();
    await renderAnalysis({ attempts: [attemptFixture(), attemptFixture({ id: "a2" })], onOpenHistory });
    const badge = screen.getByRole("button", { name: /做过 2 次/ });
    await userEvent(() => fireEvent.click(badge));
    expect(onOpenHistory).toHaveBeenCalledTimes(1);
  });

  it("有自评 verdict 时展示「最近 ✓」（批次三评卷接入前优雅降级）", async () => {
    await renderAnalysis({ attempts: [attemptFixture({ self_assessment: { verdict: "correct" } })] });
    expect(screen.getByRole("button", { name: /做过 1 次 · 最近 ✓/ })).toBeTruthy();
  });

  it("无作答历史时不显示徽标", async () => {
    await renderAnalysis();
    expect(screen.queryByRole("button", { name: /做过/ })).toBeNull();
  });

  it("展开后呈现覆盖度「A— B✓ C— D—」（纯函数消费，只呈现不催）", async () => {
    await renderAnalysis();
    await expandSection();
    expect(screen.getByText("A— B✓ C— D—")).toBeTruthy();
  });
});
