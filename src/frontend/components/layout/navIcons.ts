/**
 * 导航图标映射（2026-09-26）—— 把导航登记表里的 `icon` **名字**映射到 lucide 组件。
 *
 * 为什么登记表存名字而不是组件：让"全站有哪些入口、各自指向哪"这个问题可以在
 * 没有 React 的环境里被回答（单测、脚本审查）。组件侧只做一次名字→组件的翻译。
 *
 * 未知名字回落为 `Repeat`（调用点另有 `?? NAV_ICON.repeat` 兜底）—— 图标缺失
 * 不该让导航条整个崩掉。
 */
import {
  AlertTriangle,
  BookOpen,
  Bookmark,
  BookMarked,
  ClipboardList,
  Clock,
  Grid3x3,
  Library,
  NotebookPen,
  PenLine,
  Pencil,
  Repeat,
  Settings,
  Share2,
  StickyNote,
  Target,
  Upload,
  Users,
  Zap,
} from "lucide-react";

export const NAV_ICON = {
  alert: AlertTriangle,
  book: BookOpen,
  "book-marked": BookMarked,
  bookmark: Bookmark,
  clipboard: ClipboardList,
  clock: Clock,
  grid: Grid3x3,
  library: Library,
  notebook: NotebookPen,
  pen: PenLine,
  pencil: Pencil,
  repeat: Repeat,
  settings: Settings,
  share: Share2,
  "sticky-note": StickyNote,
  target: Target,
  upload: Upload,
  users: Users,
  zap: Zap,
} as const;

export type NavIconName = keyof typeof NAV_ICON;
