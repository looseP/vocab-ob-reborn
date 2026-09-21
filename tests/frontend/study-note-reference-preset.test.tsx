/// <reference lib="dom" />
// @vitest-environment jsdom

/**
 * Task 09B · 当前题目/素材快捷引用入口测试（先红后绿）。
 *
 * 语义（任务书 §1.5/§1.6 + 缺口 I1）：
 *  - `StudyReferencePicker` 原有 props 无预置目标能力（实测），本批**新增**可选
 *    `initialTarget`：入口携带「当前题目/当前素材」的真实身份（questionId/sourceId，
 *    **不是**纸张 ID/attempt ID/展示序号）；
 *  - 点击入口本身**不写正文、不新建引用**：只能经只读 `preview` 后再由用户显式「插入引用」；
 *  - 未点「插入引用」就关闭/取消：零 PUT、零写入（引用集合与正文均不变）；
 *  - 预置目标是**真实身份**：传给 preview 的必须是 questionId/sourceId 本体。
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { fireEvent, screen, waitFor } from "@testing-library/dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StudyNotesClient } from "@/frontend/api/studyNotesClient";
import { StudyReferencePicker } from "@/frontend/components/studyNotes/StudyReferencePicker";

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

const QUESTION_ID = "00000000-0000-4000-8000-000000000902";
const SOURCE_ID = "00000000-0000-4000-8000-000000000901";

type FakeClient = StudyNotesClient & {
  preview: ReturnType<typeof vi.fn>;
};

function makeClient(): FakeClient {
  const preview = vi.fn(async (target: { kind: string }) => ({
    liveTitle: target.kind === "source" ? "来源A" : null,
    displaySnapshot:
      target.kind === "source"
        ? { kind: "source", title: "来源A", excerpt: "摘录A" }
        : { kind: "question", stem: "题干A", excerpt: "题干A" },
  }));
  return {
    preview,
    searchTargets: vi.fn(async () => ({ items: [], nextCursor: null })),
    list: vi.fn(async () => ({ items: [], nextCursor: null })),
    create: vi.fn(),
    get: vi.fn(),
    save: vi.fn(),
    backlinks: vi.fn(),
    listTopics: vi.fn(async () => ({ items: [] })),
  } as unknown as FakeClient;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render(element: React.ReactElement): Promise<void> {
  await act(async () => {
    root.render(element);
  });
}

describe("StudyReferencePicker · 预置当前题目/素材（Task 09B）", () => {
  it("预置题目：挂载即只读预览，且不调用任何写入方法", async () => {
    const client = makeClient();
    const onInsert = vi.fn(() => true);

    await render(
      createElement(StudyReferencePicker, {
        client,
        onInsert,
        onClose: () => {},
        initialTarget: { kind: "question", questionId: QUESTION_ID },
      } as never),
    );

    await waitFor(() => {
      expect(screen.getByTestId("ref-preview-card")).toBeTruthy();
    });

    // 预置目标即真实身份：preview 收到 questionId 本体。
    expect(client.preview).toHaveBeenCalledWith({ kind: "question", questionId: QUESTION_ID });
    // 零写入：未点「插入引用」，onInsert 不得被调用。
    expect(onInsert).not.toHaveBeenCalled();
  });

  it("预置素材：preview 收到 sourceId 本体（不是纸张/attempt/展示序号）", async () => {
    const client = makeClient();

    await render(
      createElement(StudyReferencePicker, {
        client,
        onInsert: vi.fn(() => true),
        onClose: () => {},
        initialTarget: { kind: "source", sourceId: SOURCE_ID },
      } as never),
    );

    await waitFor(() => {
      expect(client.preview).toHaveBeenCalledWith({ kind: "source", sourceId: SOURCE_ID });
    });
  });

  it("入口本身零写：仅显式点击「插入引用」才回调 onInsert", async () => {
    const client = makeClient();
    const onInsert = vi.fn(() => true);
    const onClose = vi.fn();

    await render(
      createElement(StudyReferencePicker, {
        client,
        onInsert,
        onClose,
        initialTarget: { kind: "question", questionId: QUESTION_ID },
      } as never),
    );

    await waitFor(() => expect(screen.getByTestId("ref-preview-card")).toBeTruthy());
    expect(onInsert).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByTestId("ref-picker-insert"));
    });

    expect(onInsert).toHaveBeenCalledTimes(1);
    expect(onInsert.mock.calls[0][0]).toEqual({ kind: "question", questionId: QUESTION_ID });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("预览后取消：零写入（onInsert 不被调用）", async () => {
    const client = makeClient();
    const onInsert = vi.fn(() => true);

    await render(
      createElement(StudyReferencePicker, {
        client,
        onInsert,
        onClose: () => {},
        initialTarget: { kind: "question", questionId: QUESTION_ID },
      } as never),
    );

    await waitFor(() => expect(screen.getByTestId("ref-preview-card")).toBeTruthy());
    await act(async () => {
      fireEvent.click(screen.getByTestId("ref-picker-cancel"));
    });

    expect(onInsert).not.toHaveBeenCalled();
    expect(screen.queryByTestId("ref-preview-card")).toBeNull();
  });

  it("无预置目标：保持既有行为（不自动预览、不写入）", async () => {
    const client = makeClient();
    const onInsert = vi.fn(() => true);

    await render(
      createElement(StudyReferencePicker, { client, onInsert, onClose: () => {} }),
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(client.preview).not.toHaveBeenCalled();
    expect(onInsert).not.toHaveBeenCalled();
    expect(screen.queryByTestId("ref-preview-card")).toBeNull();
  });

  it("预置目标预览失败：可见错误，且仍不写入", async () => {
    const client = makeClient();
    client.preview.mockRejectedValueOnce(
      Object.assign(new Error("未找到"), { status: 404 }),
    );
    const onInsert = vi.fn(() => true);

    await render(
      createElement(StudyReferencePicker, {
        client,
        onInsert,
        onClose: () => {},
        initialTarget: { kind: "question", questionId: QUESTION_ID },
      } as never),
    );

    await waitFor(() => expect(screen.getByTestId("ref-preview-error")).toBeTruthy());
    expect(onInsert).not.toHaveBeenCalled();
  });
});
