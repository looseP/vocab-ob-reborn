/**
 * 选区浮层定位（纯函数，2026-10-02）。
 *
 * ## 它修的是什么
 *
 * 旧实现在三个卷面浮条（正文 / 题干 / 选项）里各写了一遍：
 *
 * ```
 * top: Math.max(capture.y - 8, 72),
 * transform: "translateX(-50%) translateY(-100%)",
 * ```
 *
 * `translateY(-100%)` 让「top」其实是浮层的**底边**。于是在正文第一段划词时
 * （选区 `y ≈ 100`），算出的 top 被夹到 72，再整体上移一个浮层高度（≈200）→
 * 浮层落在 `y ≈ -128`，**整块飞出视口顶部**，只把底部一条压在吸顶的章节导航上。
 * 现象就是「浮条倒挂、遮住章节 Tab」。
 *
 * 根因不是偏移量算错，而是**先夹取、后位移**的顺序错了：位移发生在夹取之后，
 * 夹取等于没做。这里把「翻面」和「夹取」合成一次自洽计算，顺序不可再被打乱。
 *
 * ## 不变量
 *
 * 1. 返回的 `top` 满足 `topSafeInset <= top <= viewportHeight - panelHeight - margin`
 *    （当区间非空时）。这是「浮层必须可见」的执行点 —— 和
 *    `SelectionTranslatePopover.computePosition` 同一条不变量，但多一个
 *    `topSafeInset`：卷面有吸顶章节导航（`sticky top-0 z-20`），浮层不许钻到它下面。
 * 2. 优先落在选区**上方**（离选区最近、且不推开下面的正文）；上方空间不足才翻到下方。
 *
 * 纯函数：不读 window，视口尺寸由调用方注入 —— 这样边界（视口 320×240 之类的
 * 极端尺寸）能被单测直接钉住，不需要真浏览器。
 */

export interface ViewportRect {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface PanelPlacement {
  top: number;
  left: number;
  /**
   * 期望的落位方向（`above` / `below`）。**注意**：这是夹取**之前**的意图，浮层比
   * 视口还高时实际渲染位置会贴在安全区顶部，此时 `placement` 不再描述视觉位置，
   * 只用于箭头/圆角的朝向。要判断真实几何请只看 `top` 与 `maxHeight`。
   */
  placement: "above" | "below";
  /** 剩余可用的最大高度（长译文/长候选列表用它滚动，而不是溢出视口）。 */
  maxHeight: number;
}

export interface ResolveSelectionPanelInput {
  anchor: ViewportRect;
  panelWidth: number;
  panelHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  /** 与选区的间距。 */
  gap?: number;
  /** 视口边缘留白。 */
  margin?: number;
  /**
   * 顶部安全区：浮层不得进入该高度以内（吸顶导航 / 顶栏遮挡）。默认 0。
   */
  topSafeInset?: number;
  /** 高度下限：视口极矮时 `maxHeight` 不塌成 0（否则面板直接不可用）。 */
  minPanelHeight?: number;
}

/** 浮层定位。所有夹取与翻面都在这里一次算完，调用方不得再叠加 transform 位移。 */
export function resolveSelectionPanelPosition(input: ResolveSelectionPanelInput): PanelPlacement {
  const gap = input.gap ?? 8;
  const margin = input.margin ?? 12;
  const minPanelHeight = input.minPanelHeight ?? 120;
  const safeTop = Math.max(margin, input.topSafeInset ?? 0);
  const { anchor, panelWidth, panelHeight, viewportWidth, viewportHeight } = input;

  const belowTop = anchor.bottom + gap;
  const aboveTop = anchor.top - gap - panelHeight;
  const roomAbove = aboveTop - safeTop;

  // 上方优先（离选区最近，且不把下方正文推开）——这也是旧实现在能工作时的观感，
  // 保留它是为了不引入无谓的行为变更。上方放不下就一律转下方：**这才是本模块存在的
  // 理由**，旧实现没有这一步，于是顶部选区只会被推出视口。两边都不够时由下面的夹取
  // 兜住（此时顶部对齐，先露出摘要与首选动作）。
  const placement: PanelPlacement["placement"] = roomAbove >= 0 ? "above" : "below";
  const preferredTop = placement === "above" ? aboveTop : belowTop;

  const maxTop = Math.max(safeTop, viewportHeight - panelHeight - margin);
  const top = Math.min(Math.max(preferredTop, safeTop), maxTop);

  const centerX = (anchor.left + anchor.right) / 2;
  const maxLeft = Math.max(margin, viewportWidth - panelWidth - margin);
  const left = Math.min(Math.max(margin, centerX - panelWidth / 2), maxLeft);

  return {
    top,
    left,
    placement,
    maxHeight: Math.max(minPanelHeight, viewportHeight - top - margin),
  };
}
