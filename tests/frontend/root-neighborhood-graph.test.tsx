/// <reference lib="dom" />
// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RootNeighborhoodGraph } from "@/frontend/components/plaza/RootNeighborhoodGraph";

const { apiFetchMock, navigateMock } = vi.hoisted(() => ({
  apiFetchMock: vi.fn(),
  navigateMock: vi.fn(),
}));

vi.mock("@/frontend/api/client", () => ({
  apiFetch: apiFetchMock,
}));

vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router-dom")>();
  return { ...actual, useNavigate: () => navigateMock };
});

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

function renderGraph(props: {
  currentToken: string;
  variants: string[];
  wordRoots: Array<string | null>;
}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  act(() => {
    root.render(
      createElement(
        MemoryRouter,
        null,
        createElement(RootNeighborhoodGraph, props),
      ),
    );
  });
  return container;
}

const PROPS = {
  currentToken: "port",
  variants: ["porti"],
  wordRoots: ["air + port", "port (portare 搬运)", "pass + port"],
};

describe("RootNeighborhoodGraph（P2-3 词族邻域图谱）", () => {
  it("以变体 + 共享复合 token 为邻居请求着色数据并渲染 SVG", async () => {
    apiFetchMock.mockResolvedValue({
      families: [
        { token: "port", slug: "root-port", total: 12, mastered: 1, learning: 0, meaning: "携带；搬运" },
        { token: "porti", slug: "root-porti", total: 3, mastered: 0, learning: 0, meaning: null },
        { token: "air", slug: "root-air", total: 9, mastered: 0, learning: 1, meaning: null },
        { token: "pass", slug: "root-pass", total: 4, mastered: 0, learning: 0, meaning: null },
      ],
    });

    const container = renderGraph(PROPS);
    await act(async () => { /* flush */ });

    // 请求带齐 中心 + 变体 + 共享 token（air/pass 来自 wordRoots，排除自身 port）
    const requestUrl = apiFetchMock.mock.calls[0][0] as string;
    expect(requestUrl).toContain("/api/plaza/roots/mastery-matrix?");
    expect(requestUrl).toContain("port");
    expect(requestUrl).toContain("porti");
    expect(requestUrl).toContain("air");
    expect(requestUrl).toContain("pass");

    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute("aria-label")).toContain("port");

    // 中心与邻居节点文本
    const text = container.textContent ?? "";
    expect(text).toContain("-port-");
    expect(text).toContain("已掌握 1/12");
    expect(text).toContain("porti");
    expect(text).toContain("air");
    expect(text).toContain("pass");

    // 变体边为虚线、共享边为实线
    const dashed = container.querySelectorAll("line[stroke-dasharray]");
    const solid = Array.from(container.querySelectorAll("line")).filter(
      (line) => !line.hasAttribute("stroke-dasharray"),
    );
    expect(dashed.length).toBe(1); // porti
    expect(solid.length).toBe(2); // air / pass

    // 点击邻居节点跳转对应家族
    const airNode = Array.from(container.querySelectorAll('g[role="link"]')).find((g) =>
      g.textContent?.includes("air"),
    );
    await act(async () => {
      airNode?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(navigateMock).toHaveBeenCalledWith("/plaza/root-air");
  });

  it("邻居为空时不发请求，仅渲染中心节点", async () => {
    const container = renderGraph({ currentToken: "zz", variants: [], wordRoots: [null] });
    await act(async () => { /* flush */ });

    expect(apiFetchMock).not.toHaveBeenCalled();
    expect(container.querySelectorAll("line").length).toBe(0);
    expect(container.textContent).toContain("-zz-");
  });

  it("请求失败时渲染错误提示", async () => {
    apiFetchMock.mockRejectedValue(new Error("图谱加载失败"));

    const container = renderGraph(PROPS);
    await act(async () => { /* flush */ });

    expect(container.textContent).toContain("图谱加载失败");
  });
});
