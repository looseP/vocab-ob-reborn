/// <reference lib="dom" />
// @vitest-environment jsdom

import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { fireEvent, waitFor } from "@testing-library/dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CapturePage } from "@/frontend/pages/CapturePage";
import { BrowserApiError } from "@/frontend/api/browserRequest";

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

const apiFetchMock = vi.fn();
vi.mock("@/frontend/api/client", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

const addToast = vi.fn();
vi.mock("@/frontend/components/ui/Toast", () => ({
  useToast: () => ({ addToast }),
}));

const WORD_DETAIL = {
  id: "w-1",
  slug: "ephemeral",
  title: "ephemeral",
  lemma: "ephemeral",
  pos: "adjective",
  cefr: "C1",
  ipa: "/ɪˈfem.ər.əl/",
  short_definition: "lasting for a very short time",
  definition_md: "lasting for a very short time; transitory",
};

const CAPTURE_RESPONSE = {
  ok: true as const,
  existed: false,
  word: { id: "w-new", slug: "ephemeral", title: "ephemeral", lemma: "ephemeral", shortDefinition: null },
  noteContentMd: null,
  l3Status: "deferred" as const,
  sourceId: null,
  contextId: null,
  occurrenceId: null,
};

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
  apiFetchMock.mockReset();
  addToast.mockClear();
});

function renderPage(): HTMLDivElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(createElement(CapturePage));
  });
  mountedRoots.push({ container, root });
  return container;
}

function typeAndQuery(headword: string): void {
  const input = document.body.querySelector('input[aria-label="要捕获的单词"]')!;
  act(() => {
    fireEvent.change(input, { target: { value: headword } });
    fireEvent.keyDown(input, { key: "Enter" });
  });
}

function findButtonByText(container: HTMLElement, text: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll("button")).find((button) =>
    button.textContent?.includes(text),
  );
}

interface RouteOptions {
  found?: boolean;
  l3Status?: "captured" | "deferred";
}

function routeApi(options: RouteOptions = {}): void {
  apiFetchMock.mockImplementation(async (path: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? "GET";
    if (method === "GET" && path === "/words/ephemeral") {
      if (options.found === false) {
        throw new BrowserApiError(404, { error: "Word not found" });
      }
      return WORD_DETAIL;
    }
    if (method === "GET" && path === "/words/ephemeral/notes") {
      return { content_md: "# my note" };
    }
    if (method === "POST" && path === "/capture") {
      return { ...CAPTURE_RESPONSE, l3Status: options.l3Status ?? "deferred" };
    }
    if (method === "POST" && path === "/review/cards") {
      return { ok: true, progressId: "p-1" };
    }
    throw new Error(`unexpected api call ${method} ${path}`);
  });
}

describe("CapturePage", () => {
  it("renders the idle hint before any query", () => {
    const container = renderPage();
    expect(container.textContent).toContain("从任意阅读处捕获");
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it("shows definition, note preview, and the review action for an in-library word", async () => {
    routeApi({ found: true });
    const container = renderPage();

    typeAndQuery("Ephemeral");

    await waitFor(() => {
      expect(container.textContent).toContain("lasting for a very short time");
    });
    expect(container.textContent).toContain("# my note");
    expect(container.textContent).toContain("加入复习");

    const reviewButton = findButtonByText(container, "加入复习")!;
    await act(async () => {
      fireEvent.click(reviewButton);
    });

    await waitFor(() => {
      expect(container.textContent).toContain("已在队列");
    });
    const cardsCall = apiFetchMock.mock.calls.find(
      ([path, init]) => path === "/review/cards" && (init as { method?: string } | undefined)?.method === "POST",
    );
    expect(cardsCall).toBeDefined();
    expect(JSON.parse((cardsCall![1] as { body: string }).body)).toEqual({ wordId: "w-1" });
  });

  it("ignores a stale lookup response when a newer query was issued", async () => {
    const deferred: Array<(value: unknown) => void> = [];
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path === "/words/slow") {
        return new Promise((resolve) => {
          deferred.push(() =>
            resolve({
              ...WORD_DETAIL,
              id: "w-slow",
              slug: "slow",
              title: "slow",
              lemma: "slow",
              short_definition: "old query result",
              definition_md: "old",
            }),
          );
        });
      }
      if (path === "/words/fast") {
        return {
          ...WORD_DETAIL,
          id: "w-fast",
          slug: "fast",
          title: "fast",
          lemma: "fast",
          short_definition: "new query result",
          definition_md: "new",
        };
      }
      if (path.endsWith("/notes")) return { content_md: "" };
      throw new Error(`unexpected ${path}`);
    });
    const container = renderPage();
    const input = document.body.querySelector('input[aria-label="要捕获的单词"]')!;

    act(() => {
      fireEvent.change(input, { target: { value: "slow" } });
      fireEvent.keyDown(input, { key: "Enter" });
    });
    typeAndQuery("fast");

    await waitFor(() => {
      expect(container.textContent).toContain("new query result");
    });

    // The slow response lands AFTER fast already won — it must be discarded.
    await act(async () => {
      for (const resolve of deferred) resolve(undefined);
      await Promise.resolve();
    });
    expect(container.textContent).toContain("new query result");
    expect(container.textContent).not.toContain("old query result");
  });

  it("maps an expired session to a re-login hint", async () => {
    apiFetchMock.mockImplementation(async () => {
      throw new BrowserApiError(401, { error: "Authentication required" });
    });
    const container = renderPage();

    typeAndQuery("ephemeral");

    await waitFor(() => {
      expect(addToast).toHaveBeenCalledWith(
        "warning",
        expect.stringContaining("重新登录"),
      );
    });
  });

  it("routes unknown words into the vocab-book capture flow", async () => {
    routeApi({ found: false });
    const container = renderPage();

    typeAndQuery("ephemeral");

    await waitFor(() => {
      expect(container.textContent).toContain("词库中没有「ephemeral」");
    });

    const captureButton = findButtonByText(container, "加入生词本")!;
    await act(async () => {
      fireEvent.click(captureButton);
    });

    await waitFor(() => {
      expect(container.textContent).toContain("已进入生词本");
    });
    const captureCall = apiFetchMock.mock.calls.find(
      ([path, init]) => path === "/capture" && (init as { method?: string } | undefined)?.method === "POST",
    );
    expect(captureCall).toBeDefined();
    expect(JSON.parse((captureCall![1] as { body: string }).body)).toMatchObject({ headword: "ephemeral" });
  });

  it("keeps source material optional fields out of the request when empty", async () => {
    routeApi({ found: false });
    const container = renderPage();

    typeAndQuery("ephemeral");
    await waitFor(() => {
      expect(container.textContent).toContain("词库中没有「ephemeral」");
    });

    const captureButton = findButtonByText(container, "加入生词本")!;
    await act(async () => {
      fireEvent.click(captureButton);
    });

    await waitFor(() => {
      expect(container.textContent).toContain("已进入生词本");
    });
    const captureCall = apiFetchMock.mock.calls.find(
      ([path, init]) => path === "/capture" && (init as { method?: string } | undefined)?.method === "POST",
    )!;
    const body = JSON.parse((captureCall[1] as { body: string }).body);
    expect(body.sentence).toBeUndefined();
    expect(body.sourceUrl).toBeUndefined();
    expect(body.obsidianRef).toBeUndefined();
  });

  it("toasts L3 context binding when capture responds captured", async () => {
    routeApi({ found: false, l3Status: "captured" });
    const container = renderPage();

    typeAndQuery("ephemeral");
    await waitFor(() => {
      expect(container.textContent).toContain("词库中没有「ephemeral」");
    });

    const captureButton = findButtonByText(container, "加入生词本")!;
    await act(async () => {
      fireEvent.click(captureButton);
    });

    await waitFor(() => {
      expect(addToast).toHaveBeenCalledWith(
        "success",
        expect.stringContaining("已加入生词本，并绑定 L3 语境"),
      );
    });
  });

  it("keeps the plain capture toast when capture responds deferred", async () => {
    routeApi({ found: false, l3Status: "deferred" });
    const container = renderPage();

    typeAndQuery("ephemeral");
    await waitFor(() => {
      expect(container.textContent).toContain("词库中没有「ephemeral」");
    });

    const captureButton = findButtonByText(container, "加入生词本")!;
    await act(async () => {
      fireEvent.click(captureButton);
    });

    await waitFor(() => {
      expect(addToast).toHaveBeenCalledWith(
        "success",
        expect.stringContaining("已加入生词本"),
      );
    });
    const boundToasts = addToast.mock.calls.filter(
      ([, message]) => typeof message === "string" && message.includes("并绑定 L3 语境"),
    );
    expect(boundToasts).toHaveLength(0);
  });
});

describe("CapturePage 条目模式（每日捕获 M1）", () => {
  /** 条目模式 API：类型注册表 + 追加 + 当日文件。词语模式端点在条目模式不会被触达。 */
  function routeDailyCaptureApi(): void {
    apiFetchMock.mockImplementation(async (path: string, init?: { method?: string; body?: string }) => {
      const method = init?.method ?? "GET";
      if (method === "GET" && path === "/daily-capture/types") {
        return { types: [{ type_key: "phrase", label: "词组", hidden: false }] };
      }
      if (method === "POST" && path === "/daily-capture/entries") {
        const parsed = JSON.parse(init?.body ?? "{}") as { entryType: string; content: string };
        return { id: "e-1", entry_date: "2026-10-10", seq: 3, entry_type: parsed.entryType, content: parsed.content };
      }
      if (method === "GET" && path.startsWith("/daily-capture/days/") && path.endsWith("/file")) {
        return "# 每日捕获 · 2026-10-10\n";
      }
      throw new Error(`unexpected api call ${method} ${path}`);
    });
  }

  function switchToEntryMode(container: HTMLElement): void {
    const tab = findButtonByText(container, "条目")!;
    act(() => {
      fireEvent.click(tab);
    });
  }

  it("默认词语模式：条目 UI 不出现，也不拉类型注册表", () => {
    routeDailyCaptureApi();
    const container = renderPage();
    expect(container.textContent).toContain("从任意阅读处捕获");
    expect(findButtonByText(container, "记一条")).toBeUndefined();
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it("追加一条：POST /daily-capture/entries + 清空草稿 + 显示今日序号", async () => {
    routeDailyCaptureApi();
    const container = renderPage();
    switchToEntryMode(container);

    const textarea = document.body.querySelector('textarea[aria-label="条目内容"]')! as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.change(textarea, { target: { value: "harness the power of habit" } });
    });
    const saveButton = findButtonByText(container, "记一条")!;
    await act(async () => {
      fireEvent.click(saveButton);
    });

    await waitFor(() => {
      expect(container.textContent).toContain("今日已记 3 条");
    });
    const entryCall = apiFetchMock.mock.calls.find(
      ([path, init]) => path === "/daily-capture/entries" && (init as { method?: string }).method === "POST",
    );
    expect(entryCall).toBeDefined();
    expect(JSON.parse((entryCall![1] as { body: string }).body)).toEqual({
      entryType: "phrase",
      content: "harness the power of habit",
    });
    expect(textarea.value).toBe("");
    expect(addToast).toHaveBeenCalledWith("success", expect.stringContaining("第 3 条"));
  });

  it("Ctrl+Enter 提交；空内容只警告不请求", async () => {
    routeDailyCaptureApi();
    const container = renderPage();
    switchToEntryMode(container);

    const textarea = document.body.querySelector('textarea[aria-label="条目内容"]')! as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true });
    });
    expect(addToast).toHaveBeenCalledWith("warning", "先写点内容再记");
    expect(apiFetchMock.mock.calls.filter(([, init]) => (init as { method?: string } | undefined)?.method === "POST")).toHaveLength(0);

    await act(async () => {
      fireEvent.change(textarea, { target: { value: "词根 -spect- 用看记" } });
      fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true });
    });
    await waitFor(() => {
      expect(container.textContent).toContain("今日已记 3 条");
    });
  });

  it("复制今日文件：取 text/markdown 投影并写入剪贴板", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    routeDailyCaptureApi();
    const container = renderPage();
    switchToEntryMode(container);

    const copyButton = findButtonByText(container, "复制今日文件")!;
    await act(async () => {
      fireEvent.click(copyButton);
    });

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(expect.stringContaining("# 每日捕获"));
    });
    const fileCall = apiFetchMock.mock.calls.find(([path]) => String(path).includes("/daily-capture/days/"));
    expect(String(fileCall?.[0])).toMatch(/\/daily-capture\/days\/\d{4}-\d{2}-\d{2}\/file$/);
    expect(addToast).toHaveBeenCalledWith("success", expect.stringContaining("已复制"));
  });
});
