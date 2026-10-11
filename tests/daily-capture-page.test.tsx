/// <reference lib="dom" />
// @vitest-environment jsdom

/**
 * DailyCapturePage（M2 子空间）组件测试 —— 锁交互口径，不锁像素：
 *  - 装载即拉日期流/类型注册表/当日数据，日期流 30 天窗口含空日占位；
 *  - 回顾✓/置要/归档 → PATCH 合同 + 本地重算（日期流徽标与页脚联动）；
 *  - 筛选与今晚回顾（横幅 + 聚焦未回顾）；
 *  - 复制当日文件 → text/markdown + 剪贴板；
 *  - 类型管理弹层：新建自定义类型 / 隐藏切换。
 */
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { fireEvent, waitFor } from "@testing-library/dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DailyCapturePage } from "@/frontend/pages/DailyCapturePage";

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

const addToast = vi.fn();
vi.mock("@/frontend/components/ui/Toast", () => ({
  useToast: () => ({ addToast }),
}));

const listDays = vi.fn();
const getDay = vi.fn();
const listTypes = vi.fn();
const patchEntry = vi.fn();
const createType = vi.fn();
const patchType = vi.fn();
const copyFileText = vi.fn();
const getEvidencePack = vi.fn();
const absorbEntry = vi.fn();
vi.mock("@/frontend/api/dailyCaptureClient", () => ({
  listDays: (...args: unknown[]) => listDays(...args),
  getDay: (...args: unknown[]) => getDay(...args),
  listTypes: (...args: unknown[]) => listTypes(...args),
  patchEntry: (...args: unknown[]) => patchEntry(...args),
  createType: (...args: unknown[]) => createType(...args),
  patchType: (...args: unknown[]) => patchType(...args),
  copyFileText: (...args: unknown[]) => copyFileText(...args),
  getEvidencePack: (...args: unknown[]) => getEvidencePack(...args),
  absorbEntry: (...args: unknown[]) => absorbEntry(...args),
}));

function displayToday(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const pick = (t: string) => parts.find((p) => p.type === t)?.value ?? "01";
  return `${pick("year")}-${pick("month")}-${pick("day")}`;
}

const TODAY = displayToday();

const TYPES = [
  { user_id: "u1", type_key: "phrase", label: "词组", absorption_hint: null, sort: 0, hidden: false, created_at: "2026-10-10T00:00:00Z" },
  { user_id: "u1", type_key: "sentence", label: "例句", absorption_hint: null, sort: 1, hidden: false, created_at: "2026-10-10T00:00:00Z" },
  { user_id: "u1", type_key: "method", label: "学习方法", absorption_hint: null, sort: 2, hidden: false, created_at: "2026-10-10T00:00:00Z" },
];

const ENTRIES = [
  { id: "e1", user_id: "u1", entry_date: TODAY, seq: 1, entry_type: "phrase", content: "harness the power of…",
    meta: { meaning: "利用…的力量", wordSlugs: ["harness"] }, status: "raw", created_at: "2026-10-10T01:02:00Z", hidden_at: null },
  { id: "e2", user_id: "u1", entry_date: TODAY, seq: 2, entry_type: "sentence", content: "She harnessed her frustration.",
    meta: { translation: "她把挫败感转化为产出。", important: true }, status: "reviewed", created_at: "2026-10-10T06:30:00Z", hidden_at: null },
];

function baseMock(): void {
  listDays.mockResolvedValue([{ date: TODAY, total: 2, raw: 1, reviewed: 1, absorbed: 0 }]);
  listTypes.mockResolvedValue(TYPES);
  getDay.mockImplementation(async (date: string) =>
    date === TODAY ? { date, types: TYPES, entries: ENTRIES } : { date, types: TYPES, entries: [] },
  );
  copyFileText.mockResolvedValue("# 每日捕获 · " + TODAY + "\n");
}

const mountedRoots: Array<{ container: HTMLDivElement; root: Root }> = [];

afterEach(() => {
  act(() => {
    for (const mounted of mountedRoots.splice(0)) {
      mounted.root.unmount();
    }
  });
  document.body.innerHTML = "";
});

beforeEach(() => {
  [listDays, getDay, listTypes, patchEntry, createType, patchType, copyFileText, getEvidencePack, absorbEntry, addToast].forEach((fn) => fn.mockReset());
  baseMock();
});

function renderPage(): HTMLDivElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(createElement(DailyCapturePage));
  });
  mountedRoots.push({ container, root });
  return container;
}

function findButtonByText(container: HTMLElement, text: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes(text));
}

describe("DailyCapturePage（M2 子空间）", () => {
  it("装载即渲染日期流（含空日占位）与当日文件视图（注册表序分节）", async () => {
    const container = renderPage();
    await waitFor(() => {
      expect(container.textContent).toContain("harness the power of…");
    });
    expect(container.textContent).toContain(`每日捕获 · ${TODAY}`);
    // 分节顺序 = 注册表 sort：词组在例句前
    expect(container.textContent?.indexOf("词组 (1)")).toBeLessThan(container.textContent!.indexOf("例句 (1)"));
    // 日期流 30 天：今天有徽标，昨天（无数据）显示 —
    expect(container.textContent).toContain("2 条");
    expect(container.textContent).toContain("1 未回顾");
    // 页脚统计
    expect(container.textContent).toContain("已回顾");
    expect(listDays).toHaveBeenCalledWith(30);
  });

  it("回顾✓ → PATCH {status:'reviewed'}，行状态与页脚联动", async () => {
    patchEntry.mockResolvedValue({ ...ENTRIES[0], status: "reviewed" });
    const container = renderPage();
    await waitFor(() => {
      expect(container.textContent).toContain("harness the power of…");
    });

    const reviewButton = findButtonByText(container, "回顾✓")!;
    await act(async () => {
      fireEvent.click(reviewButton);
    });

    await waitFor(() => {
      expect(patchEntry).toHaveBeenCalledWith("e1", { status: "reviewed" });
      expect(container.textContent).toContain("已回顾");
    });
    expect(addToast).toHaveBeenCalledWith("success", expect.stringContaining("已回顾"));
  });

  it("置要 → PATCH {important:true}", async () => {
    patchEntry.mockResolvedValue({ ...ENTRIES[0], meta: { ...ENTRIES[0].meta, important: true } });
    const container = renderPage();
    await waitFor(() => {
      expect(container.textContent).toContain("harness the power of…");
    });

    // 「置要」在筛选 chip 里也有同名按钮 —— 限定第一条条目行内的动作按钮。
    const entryRow = container.querySelector("div.group")!;
    const starButton = Array.from(entryRow.querySelectorAll("button")).find((b) => b.textContent?.includes("置要"))!;
    await act(async () => {
      fireEvent.click(starButton);
    });

    await waitFor(() => {
      expect(patchEntry).toHaveBeenCalledWith("e1", { important: true });
    });
    expect(addToast).toHaveBeenCalledWith("success", expect.stringContaining("已置要"));
  });

  it("筛选「未回顾」只显示 raw 条目；今晚回顾开启横幅并聚焦", async () => {
    const container = renderPage();
    await waitFor(() => {
      expect(container.textContent).toContain("She harnessed her frustration.");
    });

    // 筛选 chip 与日期流徽标都含「未回顾」——用精确匹配锁定筛选按钮。
    const rawFilterChip = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "未回顾",
    )!;
    await act(async () => {
      fireEvent.click(rawFilterChip);
    });
    expect(container.textContent).toContain("harness the power of…");
    expect(container.textContent).not.toContain("She harnessed her frustration.");

    await act(async () => {
      fireEvent.click(findButtonByText(container, "今晚回顾")!);
    });
    expect(container.textContent).toContain("回顾模式");
    expect(getDay).toHaveBeenLastCalledWith(TODAY);
  });

  it("复制当日文件 → 取 markdown 原文写剪贴板", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const container = renderPage();
    await waitFor(() => {
      expect(container.textContent).toContain("复制当日文件");
    });

    await act(async () => {
      fireEvent.click(findButtonByText(container, "复制当日文件")!);
    });

    await waitFor(() => {
      expect(copyFileText).toHaveBeenCalledWith(TODAY);
      expect(writeText).toHaveBeenCalledWith(expect.stringContaining("# 每日捕获"));
    });
  });

  it("类型管理：新建自定义类型走 POST，隐藏切换走 PATCH", async () => {
    createType.mockResolvedValue(TYPES[0]);
    patchType.mockResolvedValue(TYPES[0]);
    const container = renderPage();
    await waitFor(() => {
      expect(container.textContent).toContain("类型管理");
    });

    await act(async () => {
      fireEvent.click(findButtonByText(container, "类型管理")!);
    });
    await waitFor(() => {
      expect(container.textContent).toContain("内置");
    });

    // 新建
    const keyInput = document.body.querySelector('input[placeholder^="key（"]')! as HTMLInputElement;
    const labelInput = document.body.querySelector('input[placeholder^="名称（"]')! as HTMLInputElement;
    await act(async () => {
      fireEvent.change(keyInput, { target: { value: "collocation" } });
      fireEvent.change(labelInput, { target: { value: "搭配" } });
    });
    await act(async () => {
      fireEvent.click(findButtonByText(container, "新建类型")!);
    });
    await waitFor(() => {
      expect(createType).toHaveBeenCalledWith({ typeKey: "collocation", label: "搭配" });
      expect(addToast).toHaveBeenCalledWith("success", expect.stringContaining("已创建"));
    });

    // 隐藏第一个类型
    const hideButton = Array.from(document.body.querySelectorAll("button")).find((b) => b.textContent === "隐藏")!;
    await act(async () => {
      fireEvent.click(hideButton);
    });
    await waitFor(() => {
      expect(patchType).toHaveBeenCalledWith("phrase", { hidden: true });
    });
  });
});

describe("DailyCapturePage 吸收侧（M3）", () => {
  it("导出证据包：取整包 JSON 写剪贴板", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    getEvidencePack.mockResolvedValue({
      version: 1, date: TODAY, markdown: "# 每日捕获",
      entries: [{ seq: 1, id: "e1", entry_type: "phrase", label: "词组", absorption_hint: null, content: "x", status: "raw", meta: null, created_at: "2026-10-10T01:02:00Z", words: [] }],
    });
    const container = renderPage();
    await waitFor(() => {
      expect(container.textContent).toContain("导出证据包");
    });

    await act(async () => {
      fireEvent.click(findButtonByText(container, "导出证据包")!);
    });

    await waitFor(() => {
      expect(getEvidencePack).toHaveBeenCalledWith(TODAY);
      expect(writeText).toHaveBeenCalledWith(expect.stringContaining('"version": 1'));
    });
    expect(addToast).toHaveBeenCalledWith("success", expect.stringContaining("证据包已复制"));
  });

  it("吸收队列：粘贴提案 → 解析 → 采纳执行 + 条目置已吸收", async () => {
    absorbEntry.mockResolvedValue({
      entry: { ...ENTRIES[0], status: "absorbed", absorption: [
        { action: "bind_l3", target: "l3_context", id: "ctx-1", at: "2026-10-10T09:00:00Z", word_slug: "harness" },
      ] },
      receipt: { action: "bind_l3", target: "l3_context", id: "ctx-1", at: "2026-10-10T09:00:00Z", word_slug: "harness" },
    });
    const container = renderPage();
    await waitFor(() => {
      expect(container.textContent).toContain("吸收队列");
    });

    await act(async () => {
      fireEvent.click(findButtonByText(container, "吸收队列")!);
    });
    const textarea = document.body.querySelector("textarea")! as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.change(textarea, {
        target: {
          value: JSON.stringify([
            { entry: 1, action: "bind_l3", wordSlug: "harness", payload: { contextText: "She harnessed…" }, reason: "词汇义" },
          ]),
        },
      });
    });
    await act(async () => {
      fireEvent.click(findButtonByText(container, "解析提案")!);
    });
    await waitFor(() => {
      expect(container.textContent).toContain("绑 L3");
    });

    await act(async () => {
      fireEvent.click(findButtonByText(container, "采纳")!);
    });
    await waitFor(() => {
      expect(absorbEntry).toHaveBeenCalledWith("e1", {
        action: "bind_l3", wordSlug: "harness",
        payload: { contextText: "She harnessed…" }, reason: "词汇义",
      });
      expect(container.textContent).toContain("已吸收");
    });
    expect(addToast).toHaveBeenCalledWith("success", expect.stringContaining("绑 L3"));
  });
});
