/**
 * 划词即译的挂载点（2026-09-29）。
 *
 * 单独一层而不是直接把 hook 塞进 `App`：这个能力将来要能整体关掉
 * （设置项 / 环境变量 / 端点失效时的紧急止血），有独立的组件边界才好摘。
 * 现在它无条件启用 —— 常驻是这个功能的前提，藏在一个开关后面等于没做。
 */
import { useSelectionTranslate } from "@/frontend/hooks/useSelectionTranslate";

export function SelectionTranslateLayer() {
  return useSelectionTranslate();
}
