import { describe, expect, it } from "vitest";
import { resolveSelectionPanelPosition } from "@/frontend/viewModels/selectionPanelPosition";

/**
 * 选区浮层定位。
 *
 * 核心回归钉在第二条：**靠近顶部的选区不得把浮层推出视口**。旧实现是
 * `top = max(y-8, 72)` 之后再 `translateY(-100%)`，夹取发生在位移之前 ⇒ 夹取失效，
 * 浮层落在负坐标处、只把底边压在吸顶章节导航上（用户实测截图的现象）。
 */
const VIEWPORT = { viewportWidth: 1024, viewportHeight: 768 };
const PANEL = { panelWidth: 288, panelHeight: 200 };

describe("resolveSelectionPanelPosition", () => {
  it("中部选区：优先落在选区上方", () => {
    const p = resolveSelectionPanelPosition({
      ...VIEWPORT, ...PANEL,
      anchor: { top: 400, bottom: 420, left: 300, right: 400 },
    });
    expect(p.placement).toBe("above");
    expect(p.top).toBe(400 - 8 - 200);
  });

  it("顶部选区（正文第一段）：翻到下方，且绝不越出视口顶部", () => {
    const p = resolveSelectionPanelPosition({
      ...VIEWPORT, ...PANEL,
      anchor: { top: 100, bottom: 118, left: 300, right: 400 },
      topSafeInset: 72,
    });
    expect(p.placement).toBe("below");
    expect(p.top).toBe(118 + 8);
    expect(p.top).toBeGreaterThanOrEqual(72);
  });

  it("上方放不下（会侵入吸顶安全区）→ 翻到下方，绝不贴进安全区", () => {
    // anchor.top=200：aboveTop = 200-8-200 = -8 < safeTop(72) → 必须转下方
    const p = resolveSelectionPanelPosition({
      ...VIEWPORT, ...PANEL,
      anchor: { top: 200, bottom: 218, left: 300, right: 400 },
      topSafeInset: 72,
    });
    expect(p.placement).toBe("below");
    expect(p.top).toBe(226);
    expect(p.top).toBeGreaterThanOrEqual(72);
  });

  it("浮层比视口还高：夹到安全区顶部，maxHeight 不让面板塌成 0", () => {
    const p = resolveSelectionPanelPosition({
      ...VIEWPORT,
      panelWidth: 288,
      panelHeight: 900,
      anchor: { top: 400, bottom: 420, left: 300, right: 400 },
      topSafeInset: 72,
    });
    expect(p.top).toBe(72);
    expect(p.maxHeight).toBeGreaterThanOrEqual(120);
  });

  it("底部选区：不越出视口底部", () => {
    const p = resolveSelectionPanelPosition({
      ...VIEWPORT, ...PANEL,
      anchor: { top: 740, bottom: 760, left: 300, right: 400 },
    });
    expect(p.top + PANEL.panelHeight).toBeLessThanOrEqual(768 - 12);
  });

  it("水平方向以选区中点对齐，并在左右边缘夹进视口", () => {
    const center = resolveSelectionPanelPosition({
      ...VIEWPORT, ...PANEL,
      anchor: { top: 400, bottom: 420, left: 400, right: 500 },
    });
    expect(center.left).toBe(450 - 288 / 2);

    const leftEdge = resolveSelectionPanelPosition({
      ...VIEWPORT, ...PANEL,
      anchor: { top: 400, bottom: 420, left: 0, right: 20 },
    });
    expect(leftEdge.left).toBe(12);

    const rightEdge = resolveSelectionPanelPosition({
      ...VIEWPORT, ...PANEL,
      anchor: { top: 400, bottom: 420, left: 1000, right: 1024 },
    });
    expect(rightEdge.left).toBe(1024 - 288 - 12);
  });

  it("极矮视口：top 不为负、left 不为负（不变量兜底）", () => {
    const p = resolveSelectionPanelPosition({
      panelWidth: 288,
      panelHeight: 320,
      viewportWidth: 320,
      viewportHeight: 240,
      anchor: { top: 30, bottom: 44, left: 10, right: 40 },
      topSafeInset: 72,
    });
    expect(p.top).toBeGreaterThanOrEqual(0);
    expect(p.left).toBeGreaterThanOrEqual(0);
  });
});
