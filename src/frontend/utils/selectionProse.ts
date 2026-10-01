/**
 * 划词取文：把浏览器选区变成「一段值得翻译的正文」（2026-09-29）。
 *
 * 划词即译的成败几乎全在这一个函数上。用户要的是「扫一眼就懂」，所以：
 *
 * 1. **不做噪声过滤的过度设计** —— 只挡真正不能翻的东西（输入框、自己的浮层、
 *    纯符号/空白）。挡多了会出现「这里划了却没反应」，比翻译错更让人火大。
 * 2. **尽量扩到整句** —— 单独一个词丢给翻译端点，多半译不出人话（`abandon`
 *    到底是「放弃」还是「遗弃」取决于句子）。所以选区会先尝试扩到所在句子。
 *    扩到句子后仍超长就只取首句，宁可短也不截半句。
 * 3. **偏移算法复用 L3ReadingView 的 TreeWalker 累计法**，不重新发明 —— 同一个
 *    仓库里已经有踩过的坑（注入文本节点会污染计数，见 `isInjectedText`）。
 *
 * ## 为什么不直接用 `Selection.toString()`
 *
 * 因为要的是**扩展后**的文本，而 `toString()` 只给选中的部分。扩展必须知道选区
 * 在所在段落文本中的位置，那要靠 TreeWalker 累计偏移。
 */
import { findSentenceRange } from "@/services/l3-segmentation";

/** 服务端 `l3TextTranslateSchema` 的上限；超出会被 400 拒掉，所以前端先收口。 */
export const MAX_TRANSLATE_CHARS = 2000;

/**
 * 扩句后「比原选区多出这么多字」才算真的扩了 —— 用来区分「扩到整句」与
 * 「选区本来就是完整句（findSentenceRange 原样返回）」。
 *
 * 取 1 而不是 0：两端空白/换行差异会让「其实没扩」看起来扩了一点。
 */
const MIN_EXPANSION_GAIN = 1;

/** 句子容器的标签。命中任一即以它为「所在段落」，在其文本内做句子扩展。 */
const BLOCK_TAGS = new Set([
  "P", "LI", "BLOCKQUOTE", "TD", "TH", "DD", "DT", "FIGCAPTION", "PRE", "H1", "H2", "H3", "H4", "H5", "H6",
]);

/** 选区所在的可翻译正文；`rect` 用于把浮层贴到选区旁边。 */
export interface ProseSelection {
  /** 送去翻译的文本（已扩展 / 已收口到首句）。 */
  text: string;
  /** 用户实际选中的原文 —— 浮层要显示它，否则「我明明选的是这个词」会很困惑。 */
  selectedText: string;
  /** 文本是否被扩到整句（浮层据此标注，避免误导）。 */
  expanded: boolean;
  /** 选区包围盒，取视口坐标。 */
  rect: { top: number; bottom: number; left: number; right: number };
}

/**
 * 是否为「注入文本节点」—— 由前端组件（而非源文）插入的节点。
 *
 * 与 `L3ReadingView` 的同名判定保持一致：这类节点（如圈记高亮里塞的原文副本）
 * 重复计入会让偏移全错。识别方式同样是不落在源文容器内的 data 标记。
 */
function isInjectedText(node: Node, container: Element): boolean {
  const parent = node.parentElement;
  if (!parent) return false;
  const injected = parent.closest("[data-original-text]");
  return injected != null && !container.contains(injected);
}

/**
 * 选区起点所在的可翻译元素，或 null（不该翻）。
 *
 * 排除项：
 * - `input` / `textarea` / `select` / `contenteditable` —— 选中文本通常是复制，不是阅读
 * - `[data-no-translate]` / `[data-original-text]` / `[data-selection-translate]` —— 组件自留的标记
 *   （最后一个是**译文浮层自身**：它一弹出就会夺走选区，不排掉会自己触发自己）
 * - `svg` / `math` 内部 —— 没有可读文本
 */
function resolveProseRoot(node: Node | null): HTMLElement | null {
  let el: HTMLElement | null = null;
  if (node instanceof HTMLElement) el = node;
  else if (node?.parentElement) el = node.parentElement;
  if (!el) return null;

  if (el.closest("input, textarea, select, [contenteditable], [data-no-translate], [data-original-text], [data-selection-translate]")) return null;
  if (el.closest("svg, math")) return null;

  // 向上找到句子容器（段落/列表项/标题/引用/单元格）
  let block: HTMLElement | null = el;
  while (block && !BLOCK_TAGS.has(block.tagName)) {
    block = block.parentElement;
  }
  return block ?? (el.closest("div, section, article") as HTMLElement | null) ?? el;
}

/** 选区在 `container` 文本流中的 UTF-16 偏移。取不到返回 null。 */
function offsetsWithin(
  container: Element,
  startNode: Node,
  startOffset: number,
  endNode: Node,
  endOffset: number,
): { start: number; end: number } | null {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let total = 0;
  let start: number | null = null;
  let end: number | null = null;
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const len = isInjectedText(node, container) ? 0 : (node.textContent?.length ?? 0);
    if (node === startNode) start = total + startOffset;
    if (node === endNode) {
      end = total + endOffset;
      break;
    }
    total += len;
  }
  if (start == null || end == null || end <= start) return null;
  return { start, end };
}

/** 只有字母/数字/中日韩字符的占比够高才算「值得翻的正文」，否则是符号或图标。 */
function looksLikeProse(text: string): boolean {
  if (!text) return false;
  const meaningful = text.replace(/[\s\p{P}\p{S}]/gu, "").length;
  return meaningful > 0;
}

/**
 * 从当前选区提取待译文本。
 *
 * @param view 目标窗口（PiP / popup 场景下与主窗口不同）
 * @returns 提取不到（无选区 / 在输入框里 / 纯符号）时返回 null
 */
export function extractProseSelection(view: Window = window): ProseSelection | null {
  const doc = view.document;
  const sel = doc.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;

  const range = sel.getRangeAt(0);

  // 选区两端必须在同一个可翻译块里；跨块（拖过整段）就按原样翻，不做扩展。
  const startRoot = resolveProseRoot(range.startContainer);
  const endRoot = resolveProseRoot(range.endContainer);
  if (!startRoot || !endRoot) return null;

  const selectedText = sel.toString().trim();
  if (!looksLikeProse(selectedText)) return null;

  // 长度上限收口：超了就退回首句。整段硬翻必然被 400 拒，体验上等于没反应。
  let text = selectedText;
  if (text.length > MAX_TRANSLATE_CHARS) {
    const seg = findSentenceRange(text, 0, MAX_TRANSLATE_CHARS);
    text = seg.text.slice(0, MAX_TRANSLATE_CHARS).trim();
  }

  /**
   * 扩到整句 —— **只要没对齐句子边界就扩，与选区长度无关**。
   *
   * 2026-09-29 真机反例：用户选 `but abnormal levels are a concern.`（34 字），
   * 它是 `Some fat is normal in the liver, but ...` 的后半截。早期版本按
   * 「选区 < 12 字才扩」处理，34 ≥ 12 于是不扩，译文成了 `但异常水平是一个问题`
   * —— **「但」是悬空的**，因为前半句没翻。
   *
   * 正确判据不是长度而是**边界对齐**：句子边界由 `findSentenceRange` 给出，
   * 它对「已选完整句」和「跨多句」都会原样/首尾返回，所以「扩完是否真的变长」
   * 天然就是「选区是否切进了句子中间」的判据。长度阈值在这里是多余的，且有害。
   */
  let expanded = false;
  if (startRoot === endRoot) {
    const offsets = offsetsWithin(
      startRoot,
      range.startContainer,
      range.startOffset,
      range.endContainer,
      range.endOffset,
    );
    if (offsets) {
      const blockText = startRoot.textContent ?? "";
      const seg = findSentenceRange(blockText, offsets.start, offsets.end);
      const sentence = seg.text.trim();
      const grew = sentence.length - selectedText.length >= MIN_EXPANSION_GAIN;
      if (grew && sentence.length <= MAX_TRANSLATE_CHARS) {
        text = sentence;
        expanded = true;
      }
    }
  }

  // 选区矩形。`Range.getBoundingClientRect` 在真实浏览器里是普遍支持的，
  // 但 jsdom 等非浏览器环境没有这个方法 —— 这里做**降级而不是抛错**：
  // 一次取不到矩形不该让整条划词翻译链路崩掉，退化成左上角定位即可
  // （译文仍然会显示，只是位置不对；这远好过整条功能失灵）。
  const domRect = typeof range.getBoundingClientRect === "function"
    ? range.getBoundingClientRect()
    : { top: 0, bottom: 0, left: 0, right: 0 };

  return {
    text,
    selectedText,
    expanded,
    rect: {
      top: domRect.top,
      bottom: domRect.bottom,
      left: domRect.left,
      right: domRect.right,
    },
  };
}
