/// <reference lib="dom" />
// @vitest-environment jsdom

import { act, useState } from "react";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { fireEvent, screen } from "@testing-library/dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/frontend/api/client", () => ({ apiFetch: vi.fn() }));
const { addToastMock } = vi.hoisted(() => ({ addToastMock: vi.fn() }));
vi.mock("@/frontend/components/ui/Toast", () => ({ useToast: () => ({ addToast: addToastMock }) }));

import { apiFetch } from "@/frontend/api/client";
import type { L3Assessment } from "@/frontend/api/l3Client";
import { L3QuestionAssessment } from "@/frontend/components/l3/L3QuestionAssessment";

const QUESTION_ID = "00000000-0000-4000-8000-000000000101";
const USER_ID = "00000000-0000-4000-8000-000000000001";

function assessmentItem(overrides: Record<string, unknown> = {}) {
  return {
    id: "00000000-0000-4000-8000-000000000701",
    user_id: USER_ID,
    question_id: QUESTION_ID,
    content_md: "复盘：B 项判据有效",
    last_editor: "owner",
    created_at: "2026-09-17T00:00:00.000Z",
    updated_at: "2026-09-17T08:30:00.000Z",
    ...overrides,
  };
}

const roots: Root[] = [];

/**
 * 有状态父层（2026-09-27 批量读面后的真实数据流）。
 *
 * 组件不再自取单题 GET —— 数据由父层批量读回后当 prop 下发，保存成功后经 `onSaved`
 * 交回父层。测试必须照这条流走：用一个持有 state 的壳把「保存 → 回写 → 重渲染」走完，
 * 否则测的是组件内部状态，而那已经不是它的职责了。
 */
function Harness({ initial, onSavedSpy }: {
  initial: ReturnType<typeof assessmentItem> | null;
  onSavedSpy?: (row: unknown) => void;
}) {
  const [row, setRow] = useState<L3Assessment | null>(initial as L3Assessment | null);
  return createElement(L3QuestionAssessment, {
    questionId: QUESTION_ID,
    assessment: row,
    onSaved: (next: L3Assessment) => {
      onSavedSpy?.(next);
      setRow(next);
    },
  });
}

async function renderAssessment(options: {
  initial?: ReturnType<typeof assessmentItem> | null;
  onSavedSpy?: (row: unknown) => void;
} = {}): Promise<void> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(createElement(Harness, {
      initial: options.initial ?? null,
      onSavedSpy: options.onSavedSpy,
    }));
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function click(target: Element): Promise<void> {
  await act(async () => {
    fireEvent.click(target);
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  });
}

afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.innerHTML = "";
  (apiFetch as ReturnType<typeof vi.fn>).mockReset();
  addToastMock.mockReset();
});

describe("L3QuestionAssessment（评析子区，v2 §11）", () => {
  it("空态：展开 → 写评析 → PUT 保存 → 交回父层并显示内容与 owner 留痕", async () => {
    const apiFetchMock = apiFetch as ReturnType<typeof vi.fn>;
    apiFetchMock.mockImplementation(async (path: string, init?: { method?: string; body?: string }) => {
      if (String(path).endsWith("/assessment") && init?.method === "PUT") {
        const { contentMd } = JSON.parse(init.body ?? "{}") as { contentMd: string };
        return { item: assessmentItem({ content_md: contentMd }) };
      }
      return {};
    });
    const onSavedSpy = vi.fn();
    await renderAssessment({ onSavedSpy });

    expect(screen.getByText(/评析 · 待沉淀/)).toBeTruthy();
    await click(screen.getByRole("button", { name: /评析 · 待沉淀/ }));
    await click(screen.getByRole("button", { name: "写评析" }));
    const textarea = screen.getByPlaceholderText(/写下对本题的评析/) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "复盘：B 项判据有效" } });
    await click(screen.getByRole("button", { name: "保存评析" }));

    const putCall = apiFetchMock.mock.calls.find(
      ([, init]) => (init as { method?: string } | undefined)?.method === "PUT",
    );
    expect(putCall).toBeTruthy();
    expect(JSON.parse((putCall![1] as { body: string }).body)).toEqual({ contentMd: "复盘：B 项判据有效" });
    // 保存结果交回父层（父层是唯一真源）——契约本身就是断言对象
    expect(onSavedSpy).toHaveBeenCalledWith(expect.objectContaining({
      question_id: QUESTION_ID, content_md: "复盘：B 项判据有效",
    }));
    expect(screen.getByText("复盘：B 项判据有效")).toBeTruthy();
    expect(screen.getByText(/评析 · 已沉淀/)).toBeTruthy();
    expect(screen.getByText(/owner 编辑/)).toBeTruthy();
    expect(addToastMock).toHaveBeenCalledWith("success", "评析已保存");
  });

  it("已有内容（agent 编辑）：渲染预览与 last_editor 留痕；编辑进入 textarea 带初值", async () => {
    const apiFetchMock = apiFetch as ReturnType<typeof vi.fn>;
    apiFetchMock.mockImplementation(async () => ({}));
    await renderAssessment({
      initial: assessmentItem({ content_md: "agent 的解读：标记命中良好", last_editor: "agent" }),
    });

    expect(screen.getByText(/评析 · 已沉淀/)).toBeTruthy();
    expect(screen.getByText(/agent 编辑/)).toBeTruthy();
    await click(screen.getByRole("button", { name: /评析 · 已沉淀/ }));
    expect(screen.getByText("agent 的解读：标记命中良好")).toBeTruthy();
    await click(screen.getByRole("button", { name: "编辑" }));
    const textarea = screen.getByPlaceholderText(/写下对本题的评析/) as HTMLTextAreaElement;
    expect(textarea.value).toBe("agent 的解读：标记命中良好");
    // 数据来自父层 prop ⇒ 挂载**零请求**（N+1 已在批量读面里销掉）
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it("保存失败 → error toast，编辑态保留（不误报成功）", async () => {
    const apiFetchMock = apiFetch as ReturnType<typeof vi.fn>;
    apiFetchMock.mockImplementation(async (_path: string, init?: { method?: string }) => {
      if (init?.method === "PUT") throw new Error("network down");
      return {};
    });
    const onSavedSpy = vi.fn();
    await renderAssessment({ onSavedSpy });
    await click(screen.getByRole("button", { name: /评析 · 待沉淀/ }));
    await click(screen.getByRole("button", { name: "写评析" }));
    fireEvent.change(screen.getByPlaceholderText(/写下对本题的评析/), { target: { value: "会被网络打断" } });
    await click(screen.getByRole("button", { name: "保存评析" }));
    expect(addToastMock).toHaveBeenCalledWith("error", "保存失败，请稍后重试");
    expect(onSavedSpy).not.toHaveBeenCalled();
    expect((screen.getByPlaceholderText(/写下对本题的评析/) as HTMLTextAreaElement).value).toBe("会被网络打断");
  });
});
