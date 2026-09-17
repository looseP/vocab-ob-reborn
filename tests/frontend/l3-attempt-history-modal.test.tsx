/// <reference lib="dom" />
// @vitest-environment jsdom

import { act } from "react";
import { createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { fireEvent, screen } from "@testing-library/dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { L3AttemptHistoryModal } from "@/frontend/components/l3/L3AttemptHistoryModal";
import type { L3Attempt, QuestionAnnotation } from "@/frontend/api/l3Client";

const QUESTION_ID = "00000000-0000-4000-8000-000000000101";
const SHEET_ID = "00000000-0000-4000-8000-000000000401";
const SOURCE_ID = "00000000-0000-4000-8000-000000000002";

const question = { id: QUESTION_ID, stem: "21. Why did the author mention the tip culture?" };

function attemptFixture(overrides: Partial<L3Attempt> = {}): L3Attempt {
  return {
    id: "00000000-0000-4000-8000-000000000501",
    user_id: "00000000-0000-4000-8000-000000000001",
    question_id: QUESTION_ID,
    sheet_id: SHEET_ID,
    venue: "file",
    answer: { choice: "B" },
    self_assessment: null,
    status: "active",
    deleted_at: null,
    created_at: "2026-09-17T01:00:00Z",
    ...overrides,
  };
}

function annotationFixture(overrides: Partial<QuestionAnnotation> = {}): QuestionAnnotation {
  return {
    id: "ann-1",
    question_id: QUESTION_ID,
    ordinal: 0,
    anchor_start: 4,
    anchor_end: 15,
    excerpt: "trap phrase",
    note: "B 项偷换主语",
    entry_tags: ["推断题"],
    option_tags: {},
    stage: "confirmed",
    sheet_id: null,
    review: null,
    status: "active",
    created_at: "2026-09-16T00:00:00Z",
    updated_at: "2026-09-16T00:00:00Z",
    ...overrides,
  };
}

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
async function renderModal(overrides: Record<string, unknown> = {}): Promise<{
  onDelete: ReturnType<typeof vi.fn>;
  onClose: ReturnType<typeof vi.fn>;
}> {
  const fns = { onDelete: vi.fn(), onClose: vi.fn() };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  const props = {
    question,
    attempts: [attemptFixture()],
    annotations: [annotationFixture()],
    deepLink: { venue: "reading_choice", fileKey: SOURCE_ID },
    ...fns,
    ...overrides,
  };
  await act(async () => {
    root.render(
      createElement(MemoryRouter, null,
        createElement(L3AttemptHistoryModal, props as never) as ReactElement),
    );
    await Promise.resolve();
  });
  return fns;
}

afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.innerHTML = "";
});

describe("L3AttemptHistoryModal 作答历史 modal（批次二）", () => {
  it("渲染题干、venue 徽标与答案摘要时间线", async () => {
    await renderModal();
    expect(screen.getByRole("dialog", { name: "作答历史" })).toBeTruthy();
    expect(screen.getByText(/21\. Why did the author/)).toBeTruthy();
    expect(screen.getByText("题型空间")).toBeTruthy();
    expect(screen.getByText("选 B")).toBeTruthy();
    expect(screen.getByText("作答记录 · 1 次")).toBeTruthy();
  });

  it("渲染本题注记摘要并给草稿注记打标", async () => {
    await renderModal({ annotations: [annotationFixture(), annotationFixture({ id: "ann-2", note: "草稿判据", stage: "draft" })] });
    expect(screen.getByText("本题注记 · 2 条")).toBeTruthy();
    expect(screen.getByText("草稿")).toBeTruthy();
  });

  it("单条删除走内联确认：先确认再回调 onDelete", async () => {
    const { onDelete } = await renderModal();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "删除" }));
    });
    expect(onDelete).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    });
    expect(onDelete).toHaveBeenCalledWith("00000000-0000-4000-8000-000000000501");
  });

  it("内容被遮蔽的条目显示「内容已清理」", async () => {
    await renderModal({
      attempts: [attemptFixture({ answer: null, self_assessment: null })],
    });
    expect(screen.getByText("内容已清理")).toBeTruthy();
  });

  it("深链指向题型空间 ?venue=&file=", async () => {
    await renderModal();
    const link = screen.getByRole("link", { name: /去题型空间打开此文/ });
    expect(link.getAttribute("href")).toBe(`/l3?venue=reading_choice&file=${SOURCE_ID}`);
  });

  it("无文件身份时不渲染深链", async () => {
    await renderModal({ deepLink: null });
    expect(screen.queryByRole("link", { name: /去题型空间/ })).toBeNull();
  });
});
