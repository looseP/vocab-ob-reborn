/// <reference lib="dom" />
// @vitest-environment jsdom

import { act } from "react";
import { createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { fireEvent, screen, waitFor } from "@testing-library/dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { L3ExamPaper, type ExamPaper } from "@/frontend/components/l3/L3ExamPaper";
import { BrowserApiError } from "@/frontend/api/browserRequest";

vi.mock("@/frontend/api/client", () => ({ apiFetch: vi.fn() }));
const { addToastMock } = vi.hoisted(() => ({ addToastMock: vi.fn() }));
vi.mock("@/frontend/components/ui/Toast", () => ({ useToast: () => ({ addToast: addToastMock }) }));
import { apiFetch } from "@/frontend/api/client";

const PAPER_ID = "00000000-0000-4000-8000-000000000009";
const SHEET_ID = "00000000-0000-4000-8000-000000000401";
const Q1 = "00000000-0000-4000-8000-000000000101";
const Q2 = "00000000-0000-4000-8000-000000000102";

const paper: ExamPaper = {
  id: PAPER_ID,
  title: "2025 英语一",
  direction: "考研",
  metadata: { year: 2025 },
  sections: [{
    key: "s1",
    title: "Text 1",
    questionType: "reading_choice",
    sourceId: null,
    fileKey: "rls-file-1",
    questionIds: [Q1, Q2],
    missing: false,
    source_title: null,
    source_content: null,
    questions: [
      {
        id: Q1, ordinal: 0, stem: "21. Why did the author?",
        options: [{ key: "A", text: "甲" }, { key: "B", text: "乙" }],
        answer: { choice: "B" }, explanation: "【词义辨析】测试解析", evidence: [],
      },
      {
        id: Q2, ordinal: 1, stem: "22. What does the phrase mean?",
        options: [{ key: "A", text: "丙" }, { key: "B", text: "丁" }],
        answer: { choice: "A" }, explanation: null, evidence: [],
      },
    ],
  }],
};

function sheetFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: SHEET_ID,
    user_id: "00000000-0000-4000-8000-000000000001",
    scope: "paper",
    scope_key: `paper:${PAPER_ID}`,
    source_id: null,
    question_type: null,
    paper_id: PAPER_ID,
    status: "draft",
    answers: {},
    seal_mode: null,
    summary: null,
    sealed_at: null,
    created_at: "2026-09-17T00:00:00Z",
    updated_at: "2026-09-17T00:00:00Z",
    ...overrides,
  };
}

type MockOptions = {
  sheet?: Record<string, unknown>;
  /** 第一次 seal 抛 409（未答软确认），第二次成功。 */
  sealSoftConfirmOnce?: number;
  /** GET /l3/sheets/:id 的派生 attempts（sealed 结果页）。 */
  derivedAttempts?: unknown[];
};

function setupMock(options: MockOptions = {}) {
  const apiFetchMock = apiFetch as ReturnType<typeof vi.fn>;
  let sealCalls = 0;
  apiFetchMock.mockImplementation(async (path: string, init?: { method?: string; body?: string }) => {
    if (path === "/l3/sheets" && (!init || init.method === "POST")) {
      return { sheet: options.sheet ?? sheetFixture() };
    }
    if (path.startsWith("/l3/sheets/") && path.endsWith("/seal")) {
      sealCalls += 1;
      if (options.sealSoftConfirmOnce != null && sealCalls === 1) {
        throw new BrowserApiError(409, {
          error: "unanswered questions require soft confirmation",
          code: "CONFLICT",
          details: { unansweredCount: options.sealSoftConfirmOnce },
        });
      }
      return {
        sheet: sheetFixture({ status: "sealed", seal_mode: "full" }),
        unansweredCount: options.sealSoftConfirmOnce ?? 0,
        materializedCount: options.derivedAttempts?.length ?? 1,
        promotedAnnotationCount: 0,
      };
    }
    if (path.startsWith("/l3/sheets/") && !init?.method) {
      return { sheet: sheetFixture({ status: "sealed", seal_mode: "full" }), attempts: options.derivedAttempts ?? [] };
    }
    if (path.startsWith("/l3/sheets/") && init?.method === "PATCH") {
      return { sheet: sheetFixture({ answers: init.body ? (JSON.parse(init.body) as { answers: unknown }).answers : {} }) };
    }
    if (path.startsWith("/l3/question-annotations")) return { items: [] };
    if (path === "/l3/annotation-tags") return { entry: [], option: [] };
    return {};
  });
  return apiFetchMock;
}

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): [] { return []; }
}
(globalThis as Record<string, unknown>).IntersectionObserver ??= ResizeObserverStub;

const roots: Root[] = [];
async function renderPaper(target: ExamPaper = paper, flushes = 3): Promise<void> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(createElement(L3ExamPaper, { paper: target, onBack: vi.fn() }) as ReactElement);
    for (let i = 0; i < flushes; i += 1) await Promise.resolve();
  });
}

beforeEach(() => {
  setupMock();
});

afterEach(() => {
  vi.useRealTimers();
  act(() => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.innerHTML = "";
  (apiFetch as ReturnType<typeof vi.fn>).mockReset();
  addToastMock.mockReset();
});

describe("L3ExamPaper 题纸装配（批次二）", () => {
  it("进卷自动开纸（paper venue 幂等）并渲染题纸栏草稿徽标", async () => {
    const apiFetchMock = setupMock();
    await renderPaper();

    await waitFor(() => expect(screen.getByText("题纸")).toBeTruthy());
    const openCall = apiFetchMock.mock.calls.find(([path]) => path === "/l3/sheets");
    expect(openCall).toBeTruthy();
    expect(JSON.parse((openCall![1] as { body: string }).body)).toEqual({ scope: "paper", paperId: PAPER_ID });
    expect(screen.getByText(/草稿/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "定格题纸" })).toBeTruthy();
  });

  it("作答防抖 800ms 后逐题 merge PATCH，并在保存成功后给出时间", async () => {
    vi.useFakeTimers();
    const apiFetchMock = setupMock();
    await renderPaper();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /乙/ }));
      await Promise.resolve();
    });
    // 防抖窗口内不发请求
    const patchCallsBefore = apiFetchMock.mock.calls.filter(
      ([path, init]) => String(path).startsWith("/l3/sheets/") && (init as { method?: string } | undefined)?.method === "PATCH",
    );
    expect(patchCallsBefore).toHaveLength(0);

    await act(async () => {
      vi.advanceTimersByTime(800);
      for (let i = 0; i < 6; i += 1) await Promise.resolve();
    });
    const patchCallsAfter = apiFetchMock.mock.calls.filter(
      ([path, init]) => String(path).startsWith("/l3/sheets/") && (init as { method?: string } | undefined)?.method === "PATCH",
    );
    expect(patchCallsAfter).toHaveLength(1);
    const [url, init] = patchCallsAfter[0]!;
    expect(url).toBe(`/l3/sheets/${SHEET_ID}`);
    expect(JSON.parse((init as { body: string }).body)).toEqual({ answers: { [Q1]: { choice: "B" } } });
    expect(screen.getByText(/已保存/)).toBeTruthy();
  });

  it("连续两次改动合并进同一次防抖 PATCH", async () => {
    vi.useFakeTimers();
    const apiFetchMock = setupMock();
    await renderPaper();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /乙/ }));
      await Promise.resolve();
      fireEvent.click(screen.getByRole("button", { name: /丙/ }));
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(800);
      for (let i = 0; i < 6; i += 1) await Promise.resolve();
    });
    const patchCalls = apiFetchMock.mock.calls.filter(
      ([path, init]) => String(path).startsWith("/l3/sheets/") && (init as { method?: string } | undefined)?.method === "PATCH",
    );
    expect(patchCalls).toHaveLength(1);
    expect(JSON.parse((patchCalls[0]![1] as { body: string }).body)).toEqual({
      answers: { [Q1]: { choice: "B" }, [Q2]: { choice: "A" } },
    });
  });

  it("定格 modal：summary 档必须填写总结，确认按钮随之启用", async () => {
    await renderPaper();
    await waitFor(() => expect(screen.getByRole("button", { name: "定格题纸" })).toBeTruthy());

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "定格题纸" }));
    });
    expect(screen.getByRole("dialog", { name: "定格题纸" })).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole("radio", { name: /只留总结/ }));
    });
    const confirm = screen.getByRole("button", { name: "确认定格" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);

    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText(/总结/), { target: { value: "本次全对，只留元认知" } });
    });
    expect((screen.getByRole("button", { name: "确认定格" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("未答 409 后进入软确认：提示剩余题数，二次确认才定格", async () => {
    const apiFetchMock = setupMock({ sealSoftConfirmOnce: 2 });
    await renderPaper();
    await waitFor(() => expect(screen.getByRole("button", { name: "定格题纸" })).toBeTruthy());

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "定格题纸" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "确认定格" }));
      for (let i = 0; i < 6; i += 1) await Promise.resolve();
    });

    expect(screen.getByText(/还有 2 题未作答/)).toBeTruthy();
    const firstSeal = apiFetchMock.mock.calls.find(([path]) => String(path).endsWith("/seal"));
    expect(JSON.parse((firstSeal![1] as { body: string }).body)).toEqual({
      mode: "full",
      acknowledgeUnanswered: false,
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "仍要定格" }));
      for (let i = 0; i < 6; i += 1) await Promise.resolve();
    });
    const sealCalls = apiFetchMock.mock.calls.filter(([path]) => String(path).endsWith("/seal"));
    expect(sealCalls).toHaveLength(2);
    expect(JSON.parse((sealCalls[1]![1] as { body: string }).body)).toEqual({
      mode: "full",
      acknowledgeUnanswered: true,
    });
    expect(screen.getByText("已定格")).toBeTruthy();
  });

  it("已定格题纸进入只读：选项禁用、无定格入口", async () => {
    setupMock({ sheet: sheetFixture({ status: "sealed", seal_mode: "full" }) });
    await renderPaper();
    await waitFor(() => expect(screen.getByText("已定格")).toBeTruthy());

    expect(screen.queryByRole("button", { name: "定格题纸" })).toBeNull();
    for (const button of screen.getAllByRole("button", { name: /[甲乙丙丁]/ })) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it("draft 重进恢复服务端已保存的作答（answers → 本地选中态）", async () => {
    setupMock({ sheet: sheetFixture({ answers: { [Q1]: { choice: "B" } } }) });
    await renderPaper();
    await waitFor(() => expect(screen.getByText("题纸")).toBeTruthy());

    // Q1 的 B 项被恢复为已选（草稿选中态：不揭示、不判对错，不出现 ✓）
    await waitFor(() => expect(document.querySelector('[data-option-key="B"][data-selected="true"]')).toBeTruthy());
    expect(screen.queryByText("✓")).toBeNull();
  });

  it("草稿作答不即判不锁死：可改选，判定与解析仅在显式揭示后出现", async () => {
    await renderPaper();
    await waitFor(() => expect(screen.getByRole("button", { name: "定格题纸" })).toBeTruthy());

    // 先选 A（错误项）：仅示已选草稿态——无 ✓/✕、无解析
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /甲/ }));
      await Promise.resolve();
    });
    expect(document.querySelector('[data-option-key="A"][data-selected="true"]')).toBeTruthy();
    expect(screen.queryByText("✓")).toBeNull();
    expect(screen.queryByText("✕")).toBeNull();
    expect(screen.queryByText("解析")).toBeNull();

    // 可改选：点 B 后选中态迁移（若被锁定则点不动）
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /乙/ }));
      await Promise.resolve();
    });
    expect(document.querySelector('[data-option-key="B"][data-selected="true"]')).toBeTruthy();
    expect(document.querySelector('[data-option-key="A"][data-selected="true"]')).toBeNull();

    // 再改选回 A（最终作答 = 错误项，用于验证揭示后的 ✕）
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /甲/ }));
      await Promise.resolve();
    });
    expect(document.querySelector('[data-option-key="A"][data-selected="true"]')).toBeTruthy();
    expect(document.querySelector('[data-option-key="B"][data-selected="true"]')).toBeNull();

    // 显式揭示后才判才析：B 为正确答案（✓）、A 为最终错选（✕）；解析出现；选项锁定
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "显示全部答案与解析" }));
      await Promise.resolve();
    });
    expect(screen.getAllByText("✓").length).toBeGreaterThan(0);
    expect(screen.getByText("✕")).toBeTruthy();
    expect(screen.getByText("解析")).toBeTruthy();
    expect((screen.getByRole("button", { name: /甲/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("翻译参考译文默认隐藏，显式揭示后可见（草稿作答模型一致）", async () => {
    const translationPaper: ExamPaper = {
      id: PAPER_ID,
      title: "2025 英语一 · 翻译",
      direction: "考研",
      metadata: {},
      sections: [{
        key: "s-tr", title: "Part C 翻译", questionType: "sentence_translation",
        sourceId: null, fileKey: "tr-file-1", questionIds: [Q1], missing: false,
        source_title: null, source_content: null,
        questions: [{
          id: Q1, ordinal: 0, stem: "46. 翻译题干：The quick brown fox.",
          options: [], answer: { text: "敏捷的棕色狐狸。" }, explanation: null, evidence: [],
        }],
      }],
    };
    await renderPaper(translationPaper);
    await waitFor(() => expect(screen.getByText("题纸")).toBeTruthy());
    // 未揭示：参考译文不渲染（含内容）
    expect(screen.queryByText(/参考译文/)).toBeNull();
    expect(screen.queryByText("敏捷的棕色狐狸。")).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "显示全部答案与解析" }));
      await Promise.resolve();
    });
    expect(screen.getByText(/参考译文/)).toBeTruthy();
    expect(screen.getByText("敏捷的棕色狐狸。")).toBeTruthy();
  });

  it("定格成功后从 attempts 派生渲染：恢复选中 + 清理占位 + 统计口径", async () => {
    const apiFetchMock = setupMock({
      derivedAttempts: [
        {
          id: "a1", user_id: "00000000-0000-4000-8000-000000000001", question_id: Q1,
          sheet_id: SHEET_ID, venue: "paper", answer: { choice: "B" }, self_assessment: null,
          status: "active", deleted_at: null, created_at: "2026-09-17T01:00:00Z",
        },
        {
          id: "a2", user_id: "00000000-0000-4000-8000-000000000001", question_id: Q2,
          sheet_id: SHEET_ID, venue: "paper", answer: null, self_assessment: null,
          status: "deleted", deleted_at: "2026-09-17T02:00:00Z", created_at: "2026-09-17T01:30:00Z",
        },
      ],
    });
    await renderPaper();
    await waitFor(() => expect(screen.getByRole("button", { name: "定格题纸" })).toBeTruthy());

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "定格题纸" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "确认定格" }));
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    });

    await waitFor(() => expect(screen.getByText("已定格")).toBeTruthy());
    expect(screen.getByText(/已录 2 条作答（含 1 条已清理）/)).toBeTruthy();
    // 派生恢复同样为草稿选中态（未揭示不判对错；✓ 待显式揭示后出现）
    expect(document.querySelector('[data-option-key="B"][data-selected="true"]')).toBeTruthy();
    expect(screen.queryByText("✓")).toBeNull();
    expect(screen.getByText("作答记录已清理")).toBeTruthy();
    const detailCall = apiFetchMock.mock.calls.find(([path, init]) =>
      String(path) === `/l3/sheets/${SHEET_ID}` && !(init as { method?: string } | undefined)?.method);
    expect(detailCall).toBeTruthy();
  });
});
