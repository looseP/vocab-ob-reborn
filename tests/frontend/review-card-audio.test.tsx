/// <reference lib="dom" />
// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReviewCardView } from "@/frontend/components/review/ReviewCardView";
import type { ReviewCard } from "@/frontend/hooks/useReview";

const { speakMock } = vi.hoisted(() => ({ speakMock: vi.fn() }));

vi.mock("@/frontend/reviewFlow/speech", () => ({
  isSpeechSynthesisAvailable: () => true,
  speak: speakMock,
}));

vi.mock("@/frontend/api/client", () => ({
  apiFetch: vi.fn(() => Promise.resolve({ examples: [] })),
}));

vi.mock("@/frontend/components/ui/Toast", () => ({
  useToast: () => ({ addToast: vi.fn() }),
}));

vi.mock("@/frontend/components/ui/Markdown", () => ({
  Markdown: (props: { content: string }) => createElement("div", null, props.content),
}));

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ root: Root; container: HTMLDivElement }> = [];
afterEach(() => {
  act(() => {
    for (const m of mounted.splice(0)) m.root.unmount();
  });
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

function makeCard(): ReviewCard {
  return {
    progressId: "p1",
    word: {
      id: "w1",
      slug: "above",
      title: "above",
      lemma: "above",
      short_definition: "在...之上",
      ipa: "/əˈbʌv/",
      pos: "prep",
      cefr: "A1",
    },
    state: "review",
    dueAt: new Date().toISOString(),
    lastRating: null,
    reviewCount: 1,
    note_entries: [],
  };
}

describe("ReviewCardView Audio & R shortcut", () => {
  it("triggers speak when R key is pressed", () => {
    const card = makeCard();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });

    act(() => {
      root.render(createElement(MemoryRouter, null, createElement(ReviewCardView, { card, onAnswer: vi.fn() })));
    });

    expect(speakMock).not.toHaveBeenCalled();

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "r" }));
    });

    expect(speakMock).toHaveBeenCalledWith("above");
  });

  it("triggers speak when audio button is clicked", () => {
    const card = makeCard();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });

    act(() => {
      root.render(createElement(MemoryRouter, null, createElement(ReviewCardView, { card, onAnswer: vi.fn() })));
    });

    const button = container.querySelector<HTMLButtonElement>('button[aria-label="朗读发音 (R)"]');
    expect(button).not.toBeNull();

    act(() => {
      button?.click();
    });

    expect(speakMock).toHaveBeenCalledWith("above");
  });
});
