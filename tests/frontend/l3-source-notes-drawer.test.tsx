/// <reference lib="dom" />
// @vitest-environment jsdom

import { act } from "react";
import { createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { fireEvent, screen, within } from "@testing-library/dom";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/frontend/api/client", () => ({ apiFetch: vi.fn() }));
const { addToastMock } = vi.hoisted(() => ({ addToastMock: vi.fn() }));
vi.mock("@/frontend/components/ui/Toast", () => ({ useToast: () => ({ addToast: addToastMock }) }));
import { apiFetch } from "@/frontend/api/client";
import { L3SourceNotesDrawer } from "@/frontend/components/l3/L3SourceNotesDrawer";

const SOURCE_ID = "00000000-0000-4000-8000-000000000002";
const CONTEXT_1 = "00000000-0000-4000-8000-000000000301";
const CONTEXT_2 = "00000000-0000-4000-8000-000000000302";

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
async function renderDrawer(bufferedIds?: ReadonlySet<string>): Promise<void> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      createElement(MemoryRouter, null,
        createElement(L3SourceNotesDrawer, { sourceId: SOURCE_ID, bufferedIds }) as ReactElement,
      ) as ReactElement,
    );
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function userEvent(emitter: () => void): Promise<void> {
  await act(async () => {
    emitter();
    await Promise.resolve();
    await Promise.resolve();
  });
}

afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.innerHTML = "";
  (apiFetch as ReturnType<typeof vi.fn>).mockReset();
});

describe("L3SourceNotesDrawer", () => {
  it("stays collapsed and fetches nothing until opened", async () => {
    await renderDrawer();
    expect(apiFetch).not.toHaveBeenCalled();
    expect(screen.queryByText("暂无圈记，在原文划词即可快速圈入。")).toBeNull();
  });

  it("loads the source space on first expand and renders rows with counts and deep links", async () => {
    (apiFetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      contexts: [
        { id: CONTEXT_1, text: "  第一句含  考点。 " },
        { id: CONTEXT_2, text: "Another sentence here." },
      ],
      occurrences: [
        { context_id: CONTEXT_1 }, { context_id: CONTEXT_1 }, { context_id: CONTEXT_2 },
      ],
    });
    await renderDrawer();
    await userEvent(() => fireEvent.click(screen.getByRole("button", { name: /素材笔记/ })));

    expect(apiFetch).toHaveBeenCalledWith(
      `/l3/sources/${SOURCE_ID}/space`,
      expect.objectContaining({ timeoutMs: 20_000 }),
    );
    const list = screen.getByRole("list");
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(within(items[0]!).getByText("第一句含 考点。")).toBeTruthy();
    expect(within(items[0]!).getByText("2 词")).toBeTruthy();
    const link = within(items[0]!).getByRole("link");
    expect(link.getAttribute("href")).toBe(`/l3?contextId=${CONTEXT_1}`);
  });

  it("marks session-buffered contexts with the 缓冲 badge", async () => {
    (apiFetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      contexts: [{ id: CONTEXT_1, text: "新圈记句" }],
      occurrences: [{ context_id: CONTEXT_1 }],
    });
    await renderDrawer(new Set([CONTEXT_1]));
    await userEvent(() => fireEvent.click(screen.getByRole("button", { name: /素材笔记/ })));
    expect(screen.getByText("缓冲")).toBeTruthy();
  });
});
