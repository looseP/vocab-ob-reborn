/// <reference lib="dom" />
// @vitest-environment jsdom

/**
 * T3 提示分级 Hint Ladder（2026-09-25）组件测试：
 * - 正面提示面板逐级推进（H1 揭示词形 → H2 原型 → H3 助记锚）；
 * - isSpoiler 剧透跳级（原型文本含释义 ≥2 字中文串 → 无 H2 步）；
 * - 成本化评分上限：0 级→easy / 1 级→good / ≥2 级→hard / H4 翻卡→again；
 * - 作答回调携带 {hintLevel, viaH4} 埋点。
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
vi.mock("@/frontend/components/ui/Markdown", () => ({
  Markdown: (props: { content: string }) => createElement("div", null, props.content),
}));

import { apiFetch } from "@/frontend/api/client";
import { ReviewCardView } from "@/frontend/components/review/ReviewCardView";
import type { ReviewCard } from "@/frontend/hooks/useReview";

const apiFetchMock = vi.mocked(apiFetch);

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

const mountedRoots: Array<{ root: Root; container: HTMLDivElement }> = [];

afterEach(() => {
  act(() => {
    for (const mounted of mountedRoots.splice(0)) {
      mounted.root.unmount();
    }
  });
  document.body.innerHTML = "";
});

function makeCard(overrides: Partial<ReviewCard> = {}): ReviewCard {
  // word 走内部合并：overrides.word 只需携带要覆盖的字段（顶层展开会覆盖整词）
  const { word: wordOverride, ...rest } = overrides;
  return {
    progressId: "p1",
    word: {
      id: "word-1",
      slug: "alleviate",
      title: "alleviate",
      lemma: "alleviate",
      short_definition: "减轻",
      ipa: null,
      pos: "v.",
      cefr: "C1",
      examples: [{ text: "Music can alleviate stress." }],
      prototype_text: "alleviate = 一只手把重物缓缓放下的画面",
      mnemonic_text: "al+lev（举）+iate → 把负担举走",
      mnemonic_type: "etymology",
      semantic_chain: "lev轻->relieve缓解->alleviate减轻",
      ...wordOverride,
    },
    state: "review",
    dueAt: null,
    lastRating: "good",
    reviewCount: 3,
    note_entries: [],
    ...rest,
  } as ReviewCard;
}

async function renderCard(props: Partial<Parameters<typeof ReviewCardView>[0]> = {}): Promise<HTMLDivElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push({ root, container });
  await act(async () => {
    root.render(
      createElement(
        MemoryRouter,
        null,
        createElement(ReviewCardView, {
          card: makeCard(),
          loading: false,
          error: null,
          onAnswer: vi.fn(),
          onSkip: vi.fn(),
          ...props,
        }) as ReactElement,
      ),
    );
    await Promise.resolve();
    await Promise.resolve();
  });
  return container;
}

/** recap 文案被 JSX 表达式拆成多节点 → 用聚合文本断言。 */
function bodyText(container: HTMLElement): string {
  return (container.querySelector("body") ?? container).textContent ?? "";
}

function ratingButton(label: string): HTMLButtonElement {
  // 评分按钮 accessible name 以评级文案开头（后跟快捷键数字），锚定开头避免
  // 与 H4 按钮「H4 · 翻卡（上限：重来）」或上限文案误匹配。
  const candidates = screen.getAllByRole("button").filter(
    (btn) => (btn.textContent ?? "").startsWith(label),
  );
  expect(candidates.length).toBe(1);
  return candidates[0] as HTMLButtonElement;
}

async function consumeHint(): Promise<void> {
  const hintBtn = await screen.findByRole("button", { name: /提示 \d/ });
  await act(async () => {
    fireEvent.click(hintBtn);
  });
}

beforeEach(() => {
  apiFetchMock.mockReset();
  apiFetchMock.mockRejectedValue(new Error("offline"));
  addToastMock.mockReset();
});

describe("ReviewCardView Hint Ladder", () => {
  it("starts at cap easy with the panel visible on the front", async () => {
    await renderCard();
    expect(screen.getByText(/提示阶梯/)).toBeTruthy();
    expect(ratingButton("轻松").disabled).toBe(false);
    expect(ratingButton("良好").disabled).toBe(false);
    expect(ratingButton("困难").disabled).toBe(false);
    expect(ratingButton("重来").disabled).toBe(false);
  });

  it("ladders hint steps: example → prototype → mnemonic, then H4 flip", async () => {
    const container = await renderCard();

    await consumeHint(); // H1 揭示词形
    // H1 语义变更（2026-09-29，移植 wordcard-mock）：例句已由正面「例句线索区」呈现且
    // 目标词遮盖，H1 面板**不再重复整句**，只确认词形已解锁并指回语境。
    expect(screen.getByTestId("h1-reveal")).toBeTruthy();
    expect(bodyText(container)).toContain("词形已揭示");
    expect(bodyText(container)).not.toContain("提示 1 · H1 例句");
    await consumeHint(); // H2 原型
    expect(screen.getByText(/一只手把重物缓缓放下的画面/)).toBeTruthy();
    await consumeHint(); // H3 助记锚
    expect(screen.getByText(/把负担举走/)).toBeTruthy();

    // 提示穷尽 → H4 翻卡按钮出现
    const h4 = await screen.findByRole("button", { name: /H4 · 翻卡/ });
    await act(async () => {
      fireEvent.click(h4);
    });
    // 背面 recap（等 AnimatePresence exit 动画在 jsdom 播完）；评分仅「重来」可用
    await waitFor(() => expect(bodyText(container)).toContain("H4 翻卡"));
    await waitFor(() => expect(bodyText(container)).toContain("评分上限「重来」"));
    expect(ratingButton("重来").disabled).toBe(false);
    expect(ratingButton("轻松").disabled).toBe(true);
    expect(ratingButton("良好").disabled).toBe(true);
    expect(ratingButton("困难").disabled).toBe(true);
  });

  it("lowers the rating cap per consumed level and reports hint telemetry", async () => {
    const onAnswer = vi.fn();
    await renderCard({ onAnswer });

    await consumeHint(); // 1 级 → 上限 good
    expect(ratingButton("轻松").disabled).toBe(true);
    expect(ratingButton("良好").disabled).toBe(false);

    await act(async () => {
      fireEvent.click(ratingButton("良好"));
    });
    expect(onAnswer).toHaveBeenCalledWith("good", { hintLevel: 1, viaH4: false });
  });

  it("keeps cap easy for a direct flip without hints (verify semantics)", async () => {
    const onAnswer = vi.fn();
    await renderCard({ onAnswer });

    // 直接翻卡（不用提示）：点击正面词形 h2（冒泡至翻面容器）→ cap 保持 easy
    const lemmaHeading = screen.getByRole("heading", { name: "alleviate" });
    await act(async () => {
      fireEvent.click(lemmaHeading);
    });
    expect(ratingButton("轻松").disabled).toBe(false);

    await act(async () => {
      fireEvent.click(ratingButton("轻松"));
    });
    expect(onAnswer).toHaveBeenCalledWith("easy", { hintLevel: 0, viaH4: false });
  });

  it("skips the prototype step when it spoils the short definition", async () => {
    const card = makeCard({
      word: {
        prototype_text: "alleviate = 把痛苦减轻的画面（剧透释义）",
      },
    });
    await renderCard({ card });

    await consumeHint(); // H1 揭示词形
    // 下一按钮直接是 H3（H2 被跳过）
    expect(screen.getByRole("button", { name: /提示 2 · H3 助记锚/ })).toBeTruthy();
  });

  // ── H1′ 真题语境（FR-12 接线1，2026-10-04）──────────────────────────────
  it("把 L3 语境接成 H1′ 一级：遮盖目标词、不给中文释义、空号不泄漏", async () => {
    const card = makeCard({
      l3_contexts: [{
        context_id: "c1",
        source_id: "s1",
        text: "〖45〗 When pitching a new idea, use the language of abundance instead of deficit.",
        source_title: "2025 英语二 · Part B 职场提建议五步法",
        bound_sense: "丰富的；充裕的；大量的",
        surface: "abundance",
      }],
    });
    const container = await renderCard({ card });

    await consumeHint(); // H1 揭示词形
    // 顺序：H1 之后是 H1′（真题语境），不是 H2 原型
    const next = screen.getByRole("button", { name: /提示 2 · H1.+真题语境/ });
    await act(async () => {
      fireEvent.click(next);
    });

    const block = screen.getByTestId("l3-hint-context");
    expect(block.textContent).toContain("When pitching a new idea");
    expect(block.textContent).toContain("2025 英语二 · Part B 职场提建议五步法");
    // 空号不泄漏（共享解析把 `〖45〗` 变成角标）
    expect(block.textContent).not.toContain("〖");
    expect(screen.getByTestId("passage-blank-badge").textContent).toBe("45");
    // 中文释义不进提示：这是"换个语境再认一次"，不是给答案（卡背折叠才有）
    expect(block.textContent).not.toContain("丰富的");
    // 目标词被遮盖（可点揭示）
    expect(block.querySelectorAll('[data-testid="clue-mask"]')).toHaveLength(1);
    // 阶梯长度 4（example → H1′ → H2 → H3）：新增一级不改 H4 之后的既有口径
    expect(bodyText(container)).toContain("2/4 级");
    // 消费到第 2 级 ⇒ 上限降到 hard，与既有经济学（0→easy / 1→good / ≥2→hard）一致
    expect(bodyText(container)).toContain("评分上限「困难」");
    expect(ratingButton("困难").disabled).toBe(false);
    expect(ratingButton("良好").disabled).toBe(true);
    expect(ratingButton("轻松").disabled).toBe(true);
  });

  it("语境定位不到遮盖锚 → 不生成该级（下一级仍是 H2 原型）", async () => {
    const card = makeCard({
      l3_contexts: [{
        context_id: "c2",
        source_id: "s2",
        // 句子与目标词无关，且 surface 缺失 ⇒ 无法遮盖 ⇒ 整级不生成
        text: "〖45〗 Nothing about that word here.",
        source_title: "2025 英语二 · Text 1",
        bound_sense: null,
        surface: null,
      }],
    });
    await renderCard({ card });

    await consumeHint(); // H1 揭示词形
    expect(screen.getByRole("button", { name: /提示 2 · H2 原型/ })).toBeTruthy();
    expect(screen.queryByTestId("l3-hint-context")).toBeNull();
  });

  it("falls back to the semantic chain when no example is available", async () => {
    const card = makeCard({
      word: {
        examples: [],
        prototype_text: null,
        mnemonic_text: null,
      },
    });
    await renderCard({ card });

    await consumeHint(); // H1′ 语义链
    expect(screen.getByText(/relieve缓解/)).toBeTruthy();
    // 无记忆锚 → 穷尽，直接出现 H4
    expect(await screen.findByRole("button", { name: /H4 · 翻卡/ })).toBeTruthy();
  });
});
