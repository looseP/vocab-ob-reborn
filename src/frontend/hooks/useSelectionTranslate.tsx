/**
 * 全局划词即译（2026-09-29）。
 *
 * ## 为什么是「全局」而不是挂在某个页面里
 *
 * 2026-09-29 的实测反馈是：把翻译入口挂在「圈记 → 句尾小标号 → 相关词汇面板」
 * 之后，等于要求用户先做一件他不做的事（他的 `l3_contexts` 当时只有 1 行圈记）。
 * 阅读发生在很多页面上 —— 试卷台卷面、阅读视图、词条详情、辨析 —— 挂在任何
 * 单页都会在另外几页「划了没反应」。所以监听器挂在 `App` 根，一次覆盖全部。
 *
 * ## 为什么自动翻译而不是等按钮
 *
 * 用户要的是「一扫一读」。等他再点一次按钮，这条路径就断了。
 * 自动翻译的成本由两道闸压住：浏览器缓存（重复文本不打网络）+ 去抖 + 同文本
 * 去重。真正的新句子才会打一次免费端点。
 *
 * ## 为什么不做浏览器插件
 *
 * 站内阅读已经覆盖了主场景；插件要另做 token 注入与跨域，是独立一块工作量。
 * 真需要站外（微信 / PDF / Obsidian）时再单独做，别把它混进来拖慢当下可用性。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { extractProseSelection } from "@/frontend/utils/selectionProse";
import {
  SelectionTranslatePopover,
  type SelectionTranslateState,
} from "@/frontend/components/translate/SelectionTranslatePopover";

/**
 * 划词后多久开始翻。
 *
 * 350ms 是「人已经划完、还没等不及」的典型间隔。太短会把拖选过程中的中间状态
 * 也送去翻译（拖过三个词就请求一次），太长则显得迟钝。
 */
const SETTLE_MS = 350;

/** 目标语言。当前 UI 不提供选择器（2026-09-29），改这里即可换默认语言。 */
const TARGET_LANG = "zh-CN";

/** 自身浮层 / 交互控件不触发（点按钮产生的「选区」是残留选区，不是阅读意图）。 */
const NO_TRANSLATE = "[data-selection-translate], [data-no-translate], button, a, input, textarea, select, [role='button']";

export function useSelectionTranslate() {
  const [state, setState] = useState<SelectionTranslateState | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const close = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    setState(null);
  }, []);

  useEffect(() => {
    const onMouseUp = (event: MouseEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest(NO_TRANSLATE)) {
        close();
        return;
      }

      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        const found = extractProseSelection();
        if (!found) {
          setState(null);
          return;
        }
        setState({
          text: found.text,
          selectedText: found.selectedText,
          expanded: found.expanded,
          rect: found.rect,
        });
      }, SETTLE_MS);
    };

    // 键盘划选（Shift+方向键）不会触发 mouseup
    const onKeyUp = () => {
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) onMouseUp(new MouseEvent("mouseup"));
    };

    document.addEventListener("mouseup", onMouseUp);
    document.addEventListener("keyup", onKeyUp);
    return () => {
      document.removeEventListener("mouseup", onMouseUp);
      document.removeEventListener("keyup", onKeyUp);
      if (timer.current) clearTimeout(timer.current);
    };
  }, [close]);

  if (!state) return null;
  // key 让**每次新选区都重挂浮层**：否则「翻整句」选过的 scope 会残留到下一次
  // 划词上，用户没主动切却拿到了整句译文。与 ReviewCardView 用 key 隔离跨卡
  // 本地状态同一手法。
  return (
    <SelectionTranslatePopover
      key={`${state.selectedText}@${state.rect.top}`}
      state={state}
      targetLang={TARGET_LANG}
      onClose={close}
    />
  );
}
