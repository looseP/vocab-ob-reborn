/// <reference lib="dom" />
// @vitest-environment jsdom

/**
 * 新词首学卡（`EncodeCardView`）的「记笔记」入口（2026-10-12 新增）。
 *
 * 背景：初识是第一次认真看这个词的时刻，但首学卡面此前没有任何记录入口 —— 想写点
 * 什么只能等复习卡背、或事后去词详情页补，最容易记的那一刻反而是缺口。
 *
 * 本文件锁两条约束：
 * 1) **同源**：与复习卡背共用 `NoteEntriesFold` 与同一 `note_entries` 数据源
 *    （后端零改动）；条目随队列下发，展开即见，不做额外 GET。
 * 2) **顺序**：打了草稿直接点评分时，必须先落盘笔记再上报评分（内容不丢）；
 *    而无草稿时必须**同步**上报 —— 首评本身不发网络请求（唯一一次调度提交在
 *    会话产出轮末），不该为了一个空草稿把切卡拖到一次网络往返之后。
 */

import { act } from "react";
import { createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { fireEvent, screen, waitFor } from "@testing-library/dom";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/frontend/api/client", () => ({ apiFetch: vi.fn() }));
const { addToastMock } = vi.hoisted(() => ({ addToastMock: vi.fn() }));
vi.mock("@/frontend/components/ui/Toast", () => ({
  useToast: () => ({ addToast: addToastMock }),
}));
vi.mock("@/frontend/hooks/useWordDetail", () => ({
  useWordDetail: () => ({ word: null, loading: false, error: null }),
}));

import { apiFetch } from "@/frontend/api/client";
import { EncodeCardView } from "@/frontend/components/review/EncodeCardView";
import type { ReviewCard, ReviewNoteEntry } from "@/frontend/hooks/useReview";

const apiFetchMock = vi.mocked(apiFetch);

// ── fake Web Speech（同 ladder-encode-card）：首学卡挂载即自动发音 ──────────
// 真实 `speech.ts` 不 mock —— jsdom 没有 speechSynthesis，不打桩会直接抛。
class FakeUtterance {
  lang = "";
  rate = 1;
  voice: unknown = null;
  constructor(public text: string) {}
}

let synth: {
  speak: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  getVoices: ReturnType<typeof vi.fn>;
};

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

const ENTRY: ReviewNoteEntry = {
  id: "n1",
  content_md: "abound in —— 只接地点",
  kind: "general",
  created_at: "2026-10-12T00:00:00.000Z",
};

const mountedRoots: Array<{ root: Root; container: HTMLDivElement }> = [];

beforeEach(() => {
  // 口音偏好持久化在 localStorage（自动伴读接线），不隔离会串味到下一个用例
  localStorage.clear();
  apiFetchMock.mockReset();
  synth = { speak: vi.fn(), cancel: vi.fn(), getVoices: vi.fn(() => []) };
  Reflect.set(window, "speechSynthesis", synth);
  Reflect.set(window, "SpeechSynthesisUtterance", FakeUtterance);
});

afterEach(() => {
  act(() => {
    for (const mounted of mountedRoots.splice(0)) mounted.root.unmount();
  });
  document.body.innerHTML = "";
  vi.clearAllMocks();
  Reflect.deleteProperty(window, "speechSynthesis");
  Reflect.deleteProperty(window, "SpeechSynthesisUtterance");
});

function makeCard(
  word: Partial<ReviewCard["word"]> = {},
  card: Partial<ReviewCard> = {},
): ReviewCard {
  return {
    progressId: "p1",
    word: {
      id: "w1",
      slug: "slug",
      title: "Abound",
      lemma: "abound",
      short_definition: "大量存在",
      ipa: null,
      pos: null,
      cefr: null,
      ...word,
    },
    state: "new",
    dueAt: null,
    lastRating: null,
    reviewCount: 0,
    note_entries: [],
    ...card,
  };
}

function mount(ui: ReactElement): void {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(createElement(MemoryRouter, null, ui));
  });
  mountedRoots.push({ root, container });
}

/** 展开折叠 → 打开输入区（两步都是显式点击，与卡背一致）。 */
function openComposer(): void {
  act(() => {
    fireEvent.click(screen.getByText("记一条笔记"));
  });
  act(() => {
    fireEvent.click(screen.getByText("记一条笔记…"));
  });
}

describe("EncodeCardView 记笔记入口（初识即记）", () => {
  it("折叠态只占一枚入口胶囊；展开 → 写下 → 落盘到该词的 notes/entries", async () => {
    apiFetchMock.mockResolvedValueOnce({ entry: ENTRY });
    mount(createElement(EncodeCardView, { card: makeCard(), onRate: vi.fn() }));

    // 折叠态：输入区不存在，不占卡面（F2 设计）
    expect(screen.queryByPlaceholderText("一条笔记记一个点…")).toBeNull();

    openComposer();
    expect(screen.getByText("还没有笔记。点下面记一条，一条只记一个点。")).toBeTruthy();

    const textarea = screen.getByPlaceholderText("一条笔记记一个点…");
    act(() => {
      fireEvent.change(textarea, { target: { value: "abound in —— 只接地点" } });
    });

    await act(async () => {
      fireEvent.click(screen.getByText("添加条目"));
    });

    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    const [path, init] = apiFetchMock.mock.calls[0] as [string, { method?: string; body?: string }];
    expect(path).toBe("/words/slug/notes/entries");
    expect(init.method).toBe("POST");
    // kind 默认 general（零噪音，不显示 chip）
    expect(JSON.parse(String(init.body))).toEqual({
      content_md: "abound in —— 只接地点",
      kind: "general",
    });

    // 回填：条目就地出现在折叠里（本地插入，不重拉队列）
    await waitFor(() => expect(screen.getByText("abound in —— 只接地点")).toBeTruthy());
    expect(addToastMock).toHaveBeenCalledWith("success", "已添加一条笔记");
  });

  it("打了草稿直接首评：先落盘笔记、再上报评分（内容不丢）", async () => {
    const order: string[] = [];
    apiFetchMock.mockImplementation(async () => {
      order.push("note");
      return { entry: ENTRY };
    });
    const onRate = vi.fn(() => {
      order.push("rate");
    });
    mount(createElement(EncodeCardView, { card: makeCard(), onRate }));

    openComposer();
    act(() => {
      fireEvent.change(screen.getByPlaceholderText("一条笔记记一个点…"), {
        target: { value: "差点把 in 漏了" },
      });
    });

    // 没点「添加条目」就直接首评
    await act(async () => {
      fireEvent.click(screen.getByText("我认识"));
    });

    expect(onRate).toHaveBeenCalledWith("easy");
    expect(order).toEqual(["note", "rate"]);
    const [, init] = apiFetchMock.mock.calls[0] as [string, { body?: string }];
    expect(JSON.parse(String(init.body)).content_md).toBe("差点把 in 漏了");
  });

  it("无草稿时首评同步上报，不被空草稿拖到网络往返之后", () => {
    const onRate = vi.fn();
    mount(createElement(EncodeCardView, { card: makeCard(), onRate }));

    act(() => {
      fireEvent.click(screen.getByText("我认识"));
    });

    // 同一个 act 内已回调：若评分被无条件串在笔记提交之后，这里必然落空
    expect(onRate).toHaveBeenCalledWith("easy");
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it("队列下发的既有条目展开即见（首屏不额外 GET）", () => {
    mount(
      createElement(EncodeCardView, {
        card: makeCard({}, { note_entries: [ENTRY] }),
        onRate: vi.fn(),
      }),
    );

    act(() => {
      fireEvent.click(screen.getByText(/1 条笔记/));
    });

    expect(screen.getByText("abound in —— 只接地点")).toBeTruthy();
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it("在笔记输入区里打字：空格不翻卡、1/2/3 不评分", () => {
    const onRate = vi.fn();
    mount(
      createElement(EncodeCardView, {
        card: makeCard({ short_definition: "大量存在" }),
        onRate,
      }),
    );

    openComposer();
    const textarea = screen.getByPlaceholderText("一条笔记记一个点…");

    act(() => {
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true }));
    });

    expect(onRate).not.toHaveBeenCalled();
    // 空格没有把释义翻出来（输入控件聚焦时快捷键豁免）
    expect(screen.queryByText("大量存在")).toBeNull();
  });
});
