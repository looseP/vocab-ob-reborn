/// <reference lib="dom" />
// @vitest-environment jsdom

/**
 * 题纸保存生命周期正式回归（F1/F2/F3，2026-09-19 独立验收补修批次）。
 *
 * 来源：独立审查探针（build-analysis/status-2026-09-19/review-probes）三个失败场景转正，
 * 保留普通挂载对照，并扩展定格/导出编辑窗口锁与失败解锁覆盖：
 *  - F1：StrictMode 双挂载下控制器实例/订阅/版本装配绑定同一代题纸身份；
 *  - F2：定格/导出编辑窗口锁——在途拒绝编辑、弹层取消禁用、失败释放、竞争入口一致语义；
 *  - F3：冲突恢复按服务端状态装配（draft=answers+版本；sealed=attempts 派生+评卷）。
 * 本文件使用真实组件 + mock HTTP（非真实浏览器/PG；后者见 e2e 与 integration 套件）。
 */
import { StrictMode, act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { fireEvent, screen, within } from "@testing-library/dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { L3ExamPaper, type ExamPaper } from "@/frontend/components/l3/L3ExamPaper";
import { BrowserApiError } from "@/frontend/api/browserRequest";

vi.mock("@/frontend/api/client", () => ({ apiFetch: vi.fn() }));
const { addToastMock } = vi.hoisted(() => ({ addToastMock: vi.fn() }));
vi.mock("@/frontend/components/ui/Toast", () => ({ useToast: () => ({ addToast: addToastMock }) }));
import { apiFetch } from "@/frontend/api/client";

const PAPER_ID = "00000000-0000-4000-8000-000000000009";
const PAPER_B_ID = "00000000-0000-4000-8000-00000000000a";
const SHEET_ID = "00000000-0000-4000-8000-000000000401";
const SHEET_B_ID = "00000000-0000-4000-8000-000000000402";
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
    draft_version: 0,
    answers: {},
    seal_mode: null,
    summary: null,
    sealed_at: null,
    created_at: "2026-09-17T00:00:00Z",
    updated_at: "2026-09-17T00:00:00Z",
    ...overrides,
  };
}

function attemptFixture(questionId: string, choice: string): Record<string, unknown> {
  return {
    id: `attempt-${questionId.slice(-3)}`,
    user_id: "00000000-0000-4000-8000-000000000001",
    question_id: questionId,
    sheet_id: SHEET_ID,
    venue: "paper",
    answer: { choice },
    self_assessment: null,
    status: "active",
    deleted_at: null,
    created_at: "2026-09-17T01:00:00Z",
  };
}

type MockOptions = {
  sheet?: Record<string, unknown>;
  /** 第一次 seal 抛 409（未答软确认），第二次成功。 */
  sealSoftConfirmOnce?: number;
  /** GET /l3/sheets/:id 的派生 attempts（sealed 结果页）。 */
  derivedAttempts?: unknown[];
  /** 注入 PATCH 行为：hold=挂起到 gate 释放；error=直接抛错；conflictOnce=第一次 409 版本冲突。 */
  patchBehavior?: { hold?: Promise<void>; error?: { status: number; code?: string } };
  patchConflictOnce?: boolean;
  /** PATCH 成功时逐次递增 draft_version（默认恒定 0）。 */
  patchVersionStep?: boolean;
  /** GET /l3/sheets/:id 的详情行覆盖（冲突恢复动作读服务器版本用）。 */
  detailSheet?: Record<string, unknown>;
  /** seal 行为：hold=挂起；error.status 有值→BrowserApiError，无值→网络错误。 */
  sealBehavior?: {
    hold?: Promise<void>;
    error?: { status?: number; code?: string; details?: Record<string, unknown>; message?: string };
  };
  /** 导出请求挂起（导出屏障测试）。 */
  exportHold?: Promise<void>;
  /** 导出请求失败。 */
  exportError?: { status: number };
};

function setupMock(options: MockOptions = {}) {
  const apiFetchMock = apiFetch as ReturnType<typeof vi.fn>;
  let sealCalls = 0;
  let patchCount = 0;
  let patchConflictConsumed = false;
  apiFetchMock.mockImplementation(async (path: string, init?: { method?: string; body?: string }) => {
    if (path === "/l3/sheets" && (!init || init.method === "POST")) {
      return { sheet: options.sheet ?? sheetFixture() };
    }
    if (path.startsWith("/l3/sheets/") && path.endsWith("/seal")) {
      if (options.sealBehavior?.hold) await options.sealBehavior.hold;
      if (options.sealBehavior?.error) {
        const { status, code, details, message } = options.sealBehavior.error;
        if (status != null) {
          throw new BrowserApiError(status, { error: message ?? "seal failed", code: code ?? "CONFLICT", details: details ?? null });
        }
        throw new Error(message ?? "seal network failure");
      }
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
    if (path.startsWith("/l3/sheets/") && path.split("?")[0]!.endsWith("/export")) {
      if (options.exportHold) await options.exportHold;
      if (options.exportError) {
        throw new BrowserApiError(options.exportError.status, { error: "export failed", code: "CONFLICT" });
      }
      return `# L3 题纸档案（v2）\n\n导出路径 ${path}`;
    }
    if (path.startsWith("/l3/sheets/") && !init?.method) {
      return {
        sheet: options.detailSheet ?? sheetFixture({ status: "sealed", seal_mode: "full" }),
        attempts: options.derivedAttempts ?? [],
      };
    }
    if (path.startsWith("/l3/sheets/") && init?.method === "PATCH") {
      if (options.patchConflictOnce && !patchConflictConsumed) {
        patchConflictConsumed = true;
        throw new BrowserApiError(409, {
          error: "version conflict",
          code: "CONFLICT",
          details: { code: "DRAFT_VERSION_CONFLICT" },
        });
      }
      if (options.patchBehavior?.error) {
        throw new BrowserApiError(options.patchBehavior.error.status, {
          error: "patch failed",
          code: options.patchBehavior.error.code ?? "VALIDATION_ERROR",
        });
      }
      if (options.patchBehavior?.hold) {
        await options.patchBehavior.hold;
      }
      if (options.patchVersionStep) patchCount += 1;
      return {
        sheet: sheetFixture({
          answers: init.body ? (JSON.parse(init.body) as { answers: unknown }).answers : {},
          draft_version: options.patchVersionStep ? patchCount : 0,
        }),
      };
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
async function renderPaper(target: ExamPaper = paper, flushes = 3, strict = false): Promise<{ root: Root }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    const el = createElement(L3ExamPaper, { paper: target, onBack: vi.fn() });
    root.render(strict ? createElement(StrictMode, null, el) : el);
    for (let i = 0; i < flushes; i += 1) await Promise.resolve();
  });
  return { root };
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
  delete (navigator as { clipboard?: unknown }).clipboard;
});

async function ticks(): Promise<void> {
  for (let i = 0; i < 15; i += 1) await Promise.resolve();
}
async function click(name: string | RegExp): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
    await ticks();
  });
}
async function clickWithin(dialogName: string, name: string | RegExp): Promise<void> {
  await act(async () => {
    const dialog = screen.getByRole("dialog", { name: dialogName });
    fireEvent.click(within(dialog).getByRole("button", { name }));
    await ticks();
  });
}
function patches(mock: ReturnType<typeof vi.fn>): unknown[][] {
  return mock.mock.calls.filter(([, init]) => (init as { method?: string } | undefined)?.method === "PATCH");
}
const dispatchBeforeUnload = (): Event => {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event;
};

describe("F1 · StrictMode 保存生命周期", () => {
  it("普通挂载对照：编辑防抖后发出一次 PATCH，确认后显示已保存", async () => {
    vi.useFakeTimers();
    const mock = setupMock();
    await renderPaper(paper, 6, false);
    await click(/乙/);
    await act(async () => { vi.advanceTimersByTime(800); await ticks(); });
    expect(patches(mock)).toHaveLength(1);
    expect(screen.getByText(/已保存/)).toBeTruthy();
  });

  it("StrictMode 双挂载：订阅与版本基线绑定当代实例，编辑照常保存", async () => {
    vi.useFakeTimers();
    const mock = setupMock();
    await renderPaper(paper, 6, true);
    await click(/乙/);
    await act(async () => { vi.advanceTimersByTime(800); await ticks(); });
    expect(patches(mock)).toHaveLength(1);
    // 载荷与版本正确：Q1 选中 B，版本为开纸装配的 0。
    const body = JSON.parse((patches(mock)[0]![1] as { body: string }).body) as {
      answers: Record<string, unknown>;
      expectedVersion: number;
    };
    expect(body.expectedVersion).toBe(0);
    expect(body.answers[Q1]).toMatchObject({ choice: "B" });
    expect(screen.getByText(/已保存/)).toBeTruthy();
  });

  it("StrictMode 下离页守卫随保存确认切换", async () => {
    vi.useFakeTimers();
    setupMock();
    await renderPaper(paper, 6, true);
    await click(/乙/);
    // 防抖未推进：未确认 → 离页提示。
    expect(dispatchBeforeUnload().defaultPrevented).toBe(true);
    await act(async () => { vi.advanceTimersByTime(800); await ticks(); });
    // 已确认：无未确认写入 → 放行。
    expect(dispatchBeforeUnload().defaultPrevented).toBe(false);
  });

  it("切纸：新纸重建写实例与订阅，编辑只发往新纸", async () => {
    vi.useFakeTimers();
    let openCount = 0;
    const mock = setupMock();
    const base = mock.getMockImplementation()!;
    mock.mockImplementation(async (path: string, init?: { method?: string; body?: string }) => {
      if (path === "/l3/sheets" && (!init || init.method === "POST")) {
        openCount += 1;
        return { sheet: sheetFixture({ id: openCount === 1 ? SHEET_ID : SHEET_B_ID }) };
      }
      return base(path, init);
    });
    const { root } = await renderPaper(paper);
    const paperB: ExamPaper = { ...paper, id: PAPER_B_ID, title: "2025 英语二" };
    await act(async () => {
      root.render(createElement(L3ExamPaper, { paper: paperB, onBack: vi.fn() }));
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });
    await click(/乙/);
    await act(async () => { vi.advanceTimersByTime(800); await ticks(); });
    const sent = patches(mock);
    expect(sent).toHaveLength(1);
    expect(String(sent[0]![0])).toContain(SHEET_B_ID);
  });
});

describe("F2 · 定格/导出编辑窗口锁", () => {
  it("定格在途：编辑被拒、弹层取消禁用，成功后不丢弃后续输入", async () => {
    vi.useFakeTimers();
    const mock = setupMock({ patchVersionStep: true, derivedAttempts: [attemptFixture(Q1, "B")] });
    const base = mock.getMockImplementation()!;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    mock.mockImplementation(async (path: string, init: unknown) => {
      if (String(path).endsWith("/seal")) await gate;
      return base(path, init as { method?: string; body?: string } | undefined);
    });
    await renderPaper();
    await click(/乙/);
    await act(async () => { vi.advanceTimersByTime(800); await ticks(); });
    await click("定格题纸");
    await click("确认定格");
    expect(mock.mock.calls.some(([p]) => String(p).endsWith("/seal"))).toBe(true);

    // seal 在途：弹层「取消」禁用 → 不可关闭（避免误示已取消）。
    const cancel = within(screen.getByRole("dialog", { name: "定格题纸" })).getByRole("button", { name: "取消" });
    expect((cancel as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { fireEvent.click(cancel); await ticks(); });
    expect(screen.getByRole("dialog", { name: "定格题纸" })).toBeTruthy();

    // 绕过遮挡直接点卷面选项：编辑窗口已锁（渲染禁用 + 事件守卫），输入不得被接受。
    expect((screen.getByRole("button", { name: /丙/ }) as HTMLButtonElement).disabled).toBe(true);
    await click(/丙/);
    expect(screen.getByRole("button", { name: /丙/ }).getAttribute("data-selected")).not.toBe("true");

    // 释放 seal → 定格成功：被拒输入没有产生漏发 PATCH，结果按 attempts 装配。
    await act(async () => { release(); await ticks(); vi.advanceTimersByTime(1000); await ticks(); });
    expect(screen.getByText("已定格")).toBeTruthy();
    expect(patches(mock)).toHaveLength(1);
    expect(screen.getByRole("button", { name: /丙/ }).getAttribute("data-selected")).not.toBe("true");
    expect(screen.getByRole("button", { name: /乙/ }).getAttribute("data-selected")).toBe("true");
  });

  it("定格失败（网络错误）：释放编辑窗口，本地输入可继续保存", async () => {
    vi.useFakeTimers();
    const mock = setupMock({ patchVersionStep: true, sealBehavior: { error: { message: "network down" } } });
    await renderPaper();
    await click(/乙/);
    await act(async () => { vi.advanceTimersByTime(800); await ticks(); });
    await click("定格题纸");
    await click("确认定格");
    expect(addToastMock).toHaveBeenCalledWith("error", "定格失败，请稍后重试");

    // 锁已释放：可关闭弹层并继续编辑、继续保存。
    await clickWithin("定格题纸", "取消");
    expect(screen.queryByRole("dialog", { name: "定格题纸" })).toBeNull();
    await click(/丙/);
    expect(screen.getByRole("button", { name: /丙/ }).getAttribute("data-selected")).toBe("true");
    await act(async () => { vi.advanceTimersByTime(800); await ticks(); });
    expect(patches(mock)).toHaveLength(2);
  });

  it("定格版本冲突（409）：释放编辑窗口并提示重新载入，不自动重试", async () => {
    vi.useFakeTimers();
    const mock = setupMock({
      patchVersionStep: true,
      sealBehavior: { error: { status: 409, details: { code: "DRAFT_VERSION_CONFLICT" } } },
    });
    await renderPaper();
    await click(/乙/);
    await act(async () => { vi.advanceTimersByTime(800); await ticks(); });
    await click("定格题纸");
    await click("确认定格");
    expect(addToastMock).toHaveBeenCalledWith("error", expect.stringContaining("重新载入"));

    // 锁已释放：可关闭弹层并继续编辑（控制器状态由冲突恢复动作接管）。
    await clickWithin("定格题纸", "取消");
    await click(/丙/);
    expect(screen.getByRole("button", { name: /丙/ }).getAttribute("data-selected")).toBe("true");
  });

  it("导出在途：编辑被拒、定格入口同样被拒；完成后恢复", async () => {
    vi.useFakeTimers();
    const mock = setupMock();
    const base = mock.getMockImplementation()!;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    mock.mockImplementation(async (path: string, init: unknown) => {
      if (String(path).split("?")[0]!.endsWith("/export")) await gate;
      return base(path, init as { method?: string; body?: string } | undefined);
    });
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

    await renderPaper();
    await click(/乙/);
    await act(async () => { vi.advanceTimersByTime(800); await ticks(); });
    await click("导出");
    await clickWithin("导出题纸", "复制全文");

    // 导出在途：编辑被拒；定格入口被拒（一致语义）。
    await click(/丙/);
    expect(screen.getByRole("button", { name: /丙/ }).getAttribute("data-selected")).not.toBe("true");
    await click("定格题纸");
    expect(screen.queryByRole("dialog", { name: "定格题纸" })).toBeNull();

    // 释放 → 导出成功写剪贴板；锁恢复后编辑可用。
    await act(async () => { release(); await ticks(); });
    expect(writeText).toHaveBeenCalledTimes(1);
    await click(/丙/);
    expect(screen.getByRole("button", { name: /丙/ }).getAttribute("data-selected")).toBe("true");
    await act(async () => { vi.advanceTimersByTime(800); await ticks(); });
    expect(patches(mock)).toHaveLength(2);
  });

  it("导出屏障：保存未确认（冲突）时不写剪贴板、不下载", async () => {
    vi.useFakeTimers();
    const mock = setupMock({ patchBehavior: { error: { status: 409, code: "DRAFT_VERSION_CONFLICT" } } });
    const writeText = vi.fn(async () => {});
    const createObjectURL = vi.fn(() => "blob:stub");
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    (URL as unknown as { createObjectURL: unknown }).createObjectURL = createObjectURL;
    await renderPaper();
    await click(/乙/);
    await act(async () => { vi.advanceTimersByTime(800); await ticks(); });
    // PATCH 已 409：控制器进入 conflict，flush 必 reject。
    await click("导出");
    await clickWithin("导出题纸", "复制全文");
    expect(addToastMock).toHaveBeenCalledWith("error", "导出失败，请稍后重试");
    expect(writeText).not.toHaveBeenCalled();
    await clickWithin("导出题纸", "下载 .md");
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it("导出等待在途保存：确认前不写剪贴板，确认后完成", async () => {
    vi.useFakeTimers();
    const mock = setupMock();
    const base = mock.getMockImplementation()!;
    let releasePatch!: () => void;
    const patchGate = new Promise<void>((resolve) => { releasePatch = resolve; });
    mock.mockImplementation(async (path: string, init: unknown) => {
      const meta = init as { method?: string; body?: string } | undefined;
      if (meta?.method === "PATCH") await patchGate;
      return base(path, meta);
    });
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

    await renderPaper();
    await click(/乙/);
    await act(async () => { vi.advanceTimersByTime(800); await ticks(); }); // PATCH 在途（挂起）
    await click("导出");
    await clickWithin("导出题纸", "复制全文");
    await act(async () => { vi.advanceTimersByTime(500); await ticks(); });
    expect(writeText).not.toHaveBeenCalled(); // 未确认：不越过屏障
    await act(async () => { releasePatch(); await ticks(); });
    expect(writeText).toHaveBeenCalledTimes(1); // 确认后完成
  });
});

describe("F3 · 冲突恢复装配", () => {
  it("他端已定格：载入服务器版本按 attempts 装配结果视图", async () => {
    vi.useFakeTimers();
    const mock = setupMock({
      patchBehavior: { error: { status: 409, code: "DRAFT_VERSION_CONFLICT" } },
      detailSheet: sheetFixture({ status: "sealed", draft_version: 2, seal_mode: "full", answers: {} }),
      derivedAttempts: [attemptFixture(Q1, "A")],
    });
    await renderPaper();
    await click(/乙/);
    await act(async () => { vi.advanceTimersByTime(800); await ticks(); });
    await click("载入服务器版本");
    expect(screen.getByText("已定格")).toBeTruthy();
    // 服务器答案 A 已按 attempts 装配（sealed 后 answers 恒空）。
    expect(screen.getByRole("button", { name: /甲/ }).getAttribute("data-selected")).toBe("true");
    // 不重新提交旧答案、不重发定格：PATCH 仍只有冲突前的一次，seal 零次。
    expect(patches(mock)).toHaveLength(1);
    expect(mock.mock.calls.some(([p]) => String(p).endsWith("/seal"))).toBe(false);
  });

  it("他端保存（draft）：载入服务器版本放弃本地并可继续编辑", async () => {
    vi.useFakeTimers();
    const mock = setupMock({
      patchConflictOnce: true,
      detailSheet: sheetFixture({ status: "draft", draft_version: 3, answers: { [Q1]: { choice: "A" } } }),
    });
    await renderPaper();
    await click(/乙/);
    await act(async () => { vi.advanceTimersByTime(800); await ticks(); });
    // 第一次 PATCH 409 → 恢复动作。
    await click("载入服务器版本");
    // 服务器答案装配：Q1 甲选中，本地乙被放弃。
    expect(screen.getByRole("button", { name: /甲/ }).getAttribute("data-selected")).toBe("true");
    expect(screen.getByRole("button", { name: /乙/ }).getAttribute("data-selected")).not.toBe("true");
    // 继续编辑可保存，且版本基线为服务器版本 3。
    await click(/丙/);
    await act(async () => { vi.advanceTimersByTime(800); await ticks(); });
    const sent = patches(mock);
    expect(sent).toHaveLength(2);
    const body = JSON.parse((sent[1]![1] as { body: string }).body) as { expectedVersion: number };
    expect(body.expectedVersion).toBe(3);
  });
});
