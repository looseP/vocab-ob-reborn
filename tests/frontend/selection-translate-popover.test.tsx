// @vitest-environment jsdom

/**
 * 译文浮层定位（2026-09-29）。
 *
 * 这里的每条不变量都对应一次**真机踩到或理论可达**的失败，不是凑覆盖率：
 *
 * 1. **浮层必须落在视口内** —— 真机反例：视口 651px、选区在 y=1736（页面下方），
 *    「优先下方 / 否则翻上方」算出的两个位置**都在屏幕外**：浮层渲染了但用户
 *    看不见，等于没有。这条是本文件存在的主要理由。
 * 2. **贴不下就翻面** —— 选区靠近视口底部且译文较长时，浮层必须翻到上方。
 * 3. **横向不越界** —— 选区在右边缘时不能被切。
 * 4. **译文过长时自身可滚** —— 给 maxHeight 而不是让它溢出视口。
 *
 * 组件会在挂载时发翻译请求，所以这里 stub `apiFetch`；本文件只验定位。
 */

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { screen } from "@testing-library/dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSelectionTranslate } from "@/frontend/hooks/useSelectionTranslate";
import { SelectionTranslatePopover, type SelectionTranslateState } from "@/frontend/components/translate/SelectionTranslatePopover";
import { apiFetch } from "@/frontend/api/client";

vi.mock("@/frontend/api/client", () => ({ apiFetch: vi.fn() }));

const mocked = vi.mocked(apiFetch);

const VIEWPORT_W = 800;
// React 19 的 act 需要显式声明测试环境（同仓库其余 jsdom 测试约定），
// 否则本文件里经 hook 挂载的浮层每个用例都会打 act(...) 噪音。
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const VIEWPORT_H = 651;
const PANEL_WIDTH = 340;
const MARGIN = 12;

function setViewport(h = VIEWPORT_H, w = VIEWPORT_W): void {
  Object.defineProperty(window, "innerHeight", { value: h, configurable: true, writable: true });
  Object.defineProperty(window, "innerWidth", { value: w, configurable: true, writable: true });
}

function stateAt(top: number, left = 260): SelectionTranslateState {
  return {
    text: "The court ruled that the defendant had violated the terms.",
    selectedText: "abandon",
    expanded: true,
    rect: { top, bottom: top + 16, left, right: left + 40 },
  };
}

/**
 * 最后一次请求**真正送去翻译的文本**。
 *
 * `mocked` 是 `apiFetch`（不是 `translateText`），所以断言要落到请求体的
 * `text` 字段上 —— 直接断言 `(text, lang)` 会拿到 `("/l3/translate-text", init)`。
 */
function requestedText(): string {
  const calls = mocked.mock.calls;
  const init = calls.at(-1)?.[1] as { body?: string } | undefined;
  if (!init?.body) return "";
  try {
    const parsed = JSON.parse(init.body) as { text?: unknown };
    return typeof parsed.text === "string" ? parsed.text : "";
  } catch {
    return "";
  }
}

let container: HTMLDivElement;
let root: Root;
/** 模拟真实浏览器给出的浮层高度（jsdom 的 getBoundingClientRect 恒返回 0）。 */
const PANEL_HEIGHT = 160;

function mount(node: ReactElement): void {
  act(() => {
    root.render(node);
  });
}

function panelBox() {
  const el = screen.getByTestId("selection-translate-popover");
  // jsdom 没有布局引擎，getBoundingClientRect 恒 0；因此直接读 inline style，
  // 那才是 computePosition 真正写入定位决策的地方。
  return {
    top: Number.parseFloat(el.style.top),
    left: Number.parseFloat(el.style.left),
    maxHeight: Number.parseFloat(el.style.maxHeight),
  };
}

beforeEach(() => {
  setViewport();
  // 划词译文走 localStorage 缓存；不隔离的话前一条用例写入的译文会让后一条
  // 直接命中缓存（显示「缓存」徽标、用旧译文），测的就不是 mock 的那条路径了。
  window.localStorage.clear();
  mocked.mockResolvedValue({ text: "t", translation: "法院裁定被告违反了协议条款。", provider: "google-web", cached: false });
  // 组件的 useLayoutEffect 会用实测高度重算定位。jsdom 量不出高度（恒 0），
  // 若不 stub，重算会把浮层当成 0 高而「下方永远放得下」，测的就不是生产路径了。
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const isPanel = this.getAttribute?.("data-selection-translate") != null;
    return {
      x: 0, y: 0, left: 0, right: PANEL_WIDTH, top: 0, bottom: PANEL_HEIGHT,
      width: PANEL_WIDTH, height: isPanel ? PANEL_HEIGHT : 0,
      toJSON: () => ({}),
    } as DOMRect;
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  mocked.mockReset();
  vi.restoreAllMocks();
});

describe("必须落在视口内", () => {
  it("选区在页面下方（视口外）→ 浮层被夹进视口，不留在屏幕外", () => {
    // 真机反例：innerHeight 651，选区 top 1736
    mount(createElement(SelectionTranslatePopover, { state: stateAt(1736), targetLang: "zh-CN", onClose: () => {} }));
    const box = panelBox();
    expect(box.top).toBeGreaterThanOrEqual(MARGIN);
    expect(box.top).toBeLessThanOrEqual(VIEWPORT_H - MARGIN);
  });

  it("选区在视口顶部之上（负坐标）→ 浮层被夹住", () => {
    mount(createElement(SelectionTranslatePopover, { state: stateAt(-500), targetLang: "zh-CN", onClose: () => {} }));
    expect(panelBox().top).toBeGreaterThanOrEqual(MARGIN);
  });

  it("选区在视口正下方紧贴下沿 → 不会掉到屏幕外", () => {
    mount(createElement(SelectionTranslatePopover, { state: stateAt(VIEWPORT_H - 10), targetLang: "zh-CN", onClose: () => {} }));
    const box = panelBox();
    expect(box.top).toBeLessThanOrEqual(VIEWPORT_H - MARGIN);
    expect(box.top).toBeGreaterThanOrEqual(MARGIN);
  });
});

describe("贴选区：下方优先，空间不够翻上方", () => {
  it("选区在视口上部 → 落在选区下方", () => {
    mount(createElement(SelectionTranslatePopover, { state: stateAt(100), targetLang: "zh-CN", onClose: () => {} }));
    expect(panelBox().top).toBeGreaterThan(100);
  });

  it("选区靠近底部且浮层放不下 → 翻到选区上方", () => {
    mount(createElement(SelectionTranslatePopover, { state: stateAt(VIEWPORT_H - 40), targetLang: "zh-CN", onClose: () => {} }));
    expect(panelBox().top).toBeLessThan(VIEWPORT_H - 40);
  });
});

describe("横向不越界", () => {
  it("选区在右边缘 → 左边界被夹住，浮层完整可见", () => {
    mount(createElement(SelectionTranslatePopover, { state: stateAt(200, VIEWPORT_W - 10), targetLang: "zh-CN", onClose: () => {} }));
    expect(panelBox().left + PANEL_WIDTH).toBeLessThanOrEqual(VIEWPORT_W - MARGIN);
  });

  it("选区在左边缘 → 左边界被夹住", () => {
    mount(createElement(SelectionTranslatePopover, { state: stateAt(200, 0), targetLang: "zh-CN", onClose: () => {} }));
    expect(panelBox().left).toBeGreaterThanOrEqual(MARGIN);
  });

  it("视口比浮层还窄 → 仍从左边界起（宁可溢出右边也不为负）", () => {
    setViewport(400, 300);
    mount(createElement(SelectionTranslatePopover, { state: stateAt(100, 10), targetLang: "zh-CN", onClose: () => {} }));
    expect(panelBox().left).toBeGreaterThanOrEqual(MARGIN);
  });
});

describe("自身可滚", () => {
  it("maxHeight 受视口约束（长译文不会溢出屏幕）", () => {
    mount(createElement(SelectionTranslatePopover, { state: stateAt(200), targetLang: "zh-CN", onClose: () => {} }));
    const box = panelBox();
    expect(box.maxHeight).toBeGreaterThan(0);
    expect(box.top + box.maxHeight).toBeLessThanOrEqual(VIEWPORT_H);
  });
});

describe("内容与失败态", () => {
  it("默认只译选区 —— 即便选区被扩过句，标题也是「选区译文」", () => {
    // 2026-10-04 修正：此前翻的是扩句后的整句，而引用区显示选区原文，
    // 「我选这个词组、给我整句译文」的不一致体感由此而来。现在默认引什么翻什么。
    mount(createElement(SelectionTranslatePopover, { state: stateAt(200), targetLang: "zh-CN", onClose: () => {} }));
    expect(screen.getByTestId("selection-translate-popover").textContent).toContain("选区译文");
  });

  it("**送去翻译的文本就是选区原文**（不是扩出来的整句）", async () => {
    await act(async () => {
      root.render(createElement(SelectionTranslatePopover, { state: stateAt(200), targetLang: "zh-CN", onClose: () => {} }));
    });
    expect(requestedText()).toBe("abandon");
    expect(requestedText()).not.toBe(stateAt(200).text);
  });

  it("点「翻整句」才切到整句口径，标题同步为「整句译文」", async () => {
    await act(async () => {
      root.render(createElement(SelectionTranslatePopover, { state: stateAt(200), targetLang: "zh-CN", onClose: () => {} }));
    });
    const toggle = screen.getByTestId("selection-scope-toggle");
    expect(toggle.textContent).toBe("翻整句");

    await act(async () => { toggle.dispatchEvent(new MouseEvent("click", { bubbles: true })); });

    const el = screen.getByTestId("selection-translate-popover");
    expect(el.textContent).toContain("整句译文");
    expect(requestedText()).toBe(stateAt(200).text);
    // 切回去
    expect(screen.getByTestId("selection-scope-toggle").textContent).toBe("只译选区");
  });

  it("选区本来就是完整句（未扩句）→ 不给「翻整句」按钮（无意义的控件）", async () => {
    const plain = { ...stateAt(200), expanded: false };
    await act(async () => {
      root.render(createElement(SelectionTranslatePopover, { state: plain, targetLang: "zh-CN", onClose: () => {} }));
    });
    expect(screen.queryByTestId("selection-scope-toggle")).toBeNull();
    expect(screen.getByTestId("selection-translate-popover").textContent).toContain("选区译文");
  });

  it("空白选区（selectedText 只有空格）→ 退回整句口径，不翻空白", async () => {
    const blank: SelectionTranslateState = { ...stateAt(200), selectedText: "   " };
    await act(async () => {
      root.render(createElement(SelectionTranslatePopover, { state: blank, targetLang: "zh-CN", onClose: () => {} }));
    });
    expect(requestedText()).toBe(stateAt(200).text);
  });

  it("provider 全挂 → 显示「暂不可用」而不是空白或报错", async () => {
    mocked.mockResolvedValue({ text: "t", translation: "", provider: "none", cached: false, warning: "google-web: 429" });
    // 翻译是 effect 里的异步调用，必须 await 让 promise 链 flush 完
    await act(async () => {
      root.render(createElement(SelectionTranslatePopover, { state: stateAt(200), targetLang: "zh-CN", onClose: () => {} }));
    });
    const el = screen.getByTestId("selection-translate-popover");
    expect(el.textContent).toContain("暂不可用");
    expect(el.textContent).toContain("429");
  });

  it("始终显示用户实际选中的片段（不是扩出来的整句）", () => {
    mount(createElement(SelectionTranslatePopover, { state: stateAt(200), targetLang: "zh-CN", onClose: () => {} }));
    expect(screen.getByTestId("selection-translate-popover").textContent).toContain("abandon");
  });
});

/**
 * 浮层内部按钮不得收起浮层（2026-10-04 真机实测抓到）。
 *
 * `useSelectionTranslate` 的 mouseup 守卫用 `closest(NO_TRANSLATE)` 排除干扰，
 * 而 `NO_TRANSLATE` 含 `button` —— `closest()` 返回**最近**的匹配祖先，
 * 浮层页脚的「重新翻译 / 翻整句」按钮**自己**就命中 `button`，
 * 于是「点重新翻译」被误判成外部点击 → 浮层当场收起，按钮形同虚设。
 *
 * 单测此前没抓到，是因为它们直接调 onClick、不派发真实的 document mouseup。
 * 这里补上真实事件路径。
 */
describe("浮层内部交互不得收起浮层", () => {
  function mountHook() {
    const Probe = () => {
      const layer = useSelectionTranslate();
      return createElement("div", null, layer);
    };
    const c = document.createElement("div");
    document.body.appendChild(c);
    const r = createRoot(c);
    act(() => { r.render(createElement(Probe)); });
    return { container: c, root: r };
  }

  /** 在正文里划一段，触发浮层。 */
  function selectProse(host: HTMLElement, phrase: string): void {
    const node = document.createTextNode(phrase);
    host.appendChild(node);
    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, phrase.length);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    act(() => {
      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });
  }

  it("点「重新翻译」后浮层仍在（且重新请求了一次）", async () => {
    const host = document.createElement("p");
    document.body.appendChild(host);
    const probe = mountHook();
    // 假定时器：划词后有 350ms 去抖
    vi.useFakeTimers();
    selectProse(host, "abandon the plan");
    await act(async () => { vi.advanceTimersByTime(400); });
    vi.useRealTimers();
    await act(async () => {});

    const panel = () => screen.queryByTestId("selection-translate-popover");
    expect(panel(), "浮层应已出现").not.toBeNull();
    const before = mocked.mock.calls.length;

    await act(async () => {
      screen.getByText("重新翻译").dispatchEvent(new MouseEvent("click", { bubbles: true }));
      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });

    expect(panel(), "点重新翻译后浮层被收起了").not.toBeNull();
    expect(mocked.mock.calls.length, "应重新发起了一次翻译请求").toBeGreaterThan(before);

    act(() => probe.root.unmount());
    probe.container.remove();
    host.remove();
  });
});
