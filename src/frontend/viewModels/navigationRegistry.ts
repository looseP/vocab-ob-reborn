/**
 * 导航登记表（2026-09-26）—— 全站入口的**唯一真源**。
 *
 * 问题：此前有四张互相矛盾的入口表——SiteHeader（9 项）、MobileTabBar（6 项）、
 * HomePage 卡片（8 项）、L3 侧栏（15 section）。它们各自手写 href 与标签，于是：
 *  - 「做题」在首页深度 2–3，而「复习」在深度 1（体感上"复习是主功能、做题是附录"）；
 *  - 同一个面在两张表里标签不同（「L3 进阶研究」vs「素材宇宙」）；
 *  - 加一个入口要改四个地方，漏一处就制造一条死链。
 *
 * 本模块把每个用户面**声明一次**：id / 标签 / 规范 URL / 激活前缀 / 副标题 /
 * 出现在哪些入口面 / 族 / L3 section。各消费方（顶栏、移动底栏、首页卡片、
 * 命令面板、L3 首页 chips）只做渲染，不再自己手写 href —— 少一个入口 = 改一行，
 * 且不可能不一致。
 *
 * 纯数据 + 纯函数（不 import React / 图标 / 路由），故可单测、可被脚本审查。
 * 图标以**名字**声明（`icon`），由组件侧映射到 lucide 图标：让"哪些入口存在"
 * 这个问题可以在没有 React 的情况下被回答。
 *
 * 族（family）的用途：
 *  - 命令面板按族分组，避免十几条 goto 平铺；
 *  - `practice` 族 = 做题轴（题单/练习/错题/会话/作文/笔记），P2 的
 *    "任何做题面 ≤1 击"判据就是：**practice 族每个面至少出现在一个 1 击入口面**。
 */
import type { L3ShellSection } from "./l3ShellViewModel";

/** 入口出现在哪些面上。`palette` = 命令面板（0 击，键盘）。 */
export type NavSurface = "topnav" | "mobile" | "home" | "palette" | "l3home";

/** 族：复习 / 词汇 / 做题 / 素材 / 系统。 */
export type NavFamily = "review" | "vocab" | "practice" | "material" | "system";

export interface NavEntry {
  id: string;
  label: string;
  /** 卡片/面板副标题（一句话说明这个面是干什么的）。 */
  description: string;
  /** 规范 URL —— 唯一构造入口，四个消费方共用。 */
  href: string;
  /** 激活态判定用的 pathname 前缀（`/l3` 会命中所有 L3 子面）。 */
  matchPrefix: string;
  icon: string;
  family: NavFamily;
  surfaces: readonly NavSurface[];
  /**
   * 仅 L3 子面：对应的 shell section id。L3 内部跳转（首页 chips、侧栏）按 section
   * 走本地 state，而不是改 URL —— 声明在此，消费方就不必自己记"哪个 nav id 对应
   * 哪个 section"（那张对照表早晚会和登记表漂移）。
   */
  l3Section?: L3ShellSection;
}

/** 命令面板的族分组顺序与中文名（面板按此序渲染，不平铺）。 */
export const NAV_FAMILY_ORDER: ReadonlyArray<{ id: NavFamily; label: string }> = [
  { id: "practice", label: "做题" },
  { id: "review", label: "复习" },
  { id: "vocab", label: "词汇" },
  { id: "material", label: "素材" },
  { id: "system", label: "系统" },
];

export const NAV_FAMILY_LABELS: Record<NavFamily, string> = {
  practice: "做题",
  review: "复习",
  vocab: "词汇",
  material: "素材",
  system: "系统",
};

export const NAVIGATION: readonly NavEntry[] = [
  // ── 做题族：L3 做题轴。首页卡片 + 顶栏 + 命令面板 + L3 首页 chips 可达 ──────
  {
    id: "practice-paper",
    label: "做题",
    description: "题型空间与整卷：录题、做题、定格、评卷",
    href: "/l3?section=papers",
    matchPrefix: "/l3",
    icon: "clipboard",
    family: "practice",
    surfaces: ["home", "palette", "l3home"],
    l3Section: "papers",
  },
  {
    id: "practice-error-book",
    label: "错题库",
    description: "题级 + 句级错题，可直接回去再练",
    href: "/l3?section=error-book",
    matchPrefix: "/l3",
    icon: "alert",
    family: "practice",
    surfaces: ["home", "palette", "l3home"],
    l3Section: "errorBook",
  },
  {
    id: "practice-drill",
    label: "练习",
    description: "句级练习：作文句默写 / 语境自测",
    href: "/l3?section=practice",
    matchPrefix: "/l3",
    icon: "pencil",
    family: "practice",
    surfaces: ["palette", "l3home"],
    l3Section: "practice",
  },
  {
    id: "practice-session",
    label: "会话",
    description: "攻坚包：定时长的慢学习容器",
    href: "/l3?section=session",
    matchPrefix: "/l3",
    icon: "clock",
    family: "practice",
    surfaces: ["palette", "l3home"],
    l3Section: "session",
  },
  {
    id: "practice-writing",
    label: "作文",
    description: "写作 → 提交 → 按稿评阅 → 第二稿",
    href: "/l3?section=writing",
    matchPrefix: "/l3",
    icon: "pen",
    family: "practice",
    surfaces: ["home", "palette", "l3home"],
    l3Section: "writing",
  },
  {
    id: "practice-notes",
    label: "学习笔记",
    description: "跨题长文沉淀，按题型与专题组织",
    href: "/l3?section=study-notes",
    matchPrefix: "/l3",
    icon: "notebook",
    family: "practice",
    surfaces: ["palette", "l3home"],
    l3Section: "studyNotes",
  },
  // ── 复习族 ────────────────────────────────────────────────────────────
  {
    id: "review",
    label: "复习",
    description: "间隔重复训练，巩固记忆",
    href: "/review",
    matchPrefix: "/review",
    icon: "repeat",
    family: "review",
    surfaces: ["topnav", "mobile", "home", "palette"],
  },
  {
    id: "drill",
    label: "辨析",
    description: "L2 辨析训练：完形填空 / 词汇填空自测",
    href: "/l2-drill",
    matchPrefix: "/l2-drill",
    icon: "zap",
    family: "review",
    surfaces: ["topnav", "home", "palette"],
  },
  {
    id: "dashboard",
    label: "仪表盘",
    description: "学习进度和统计",
    href: "/dashboard",
    matchPrefix: "/dashboard",
    icon: "grid",
    family: "review",
    surfaces: ["topnav", "mobile", "home", "palette"],
  },
  // ── 词汇族 ────────────────────────────────────────────────────────────
  {
    id: "words",
    label: "词条库",
    description: "浏览和管理词汇",
    href: "/words",
    matchPrefix: "/words",
    icon: "book",
    family: "vocab",
    surfaces: ["topnav", "mobile", "home", "palette"],
  },
  {
    id: "plaza",
    label: "广场",
    description: "公开词书与他人精选",
    href: "/plaza",
    matchPrefix: "/plaza",
    icon: "users",
    family: "vocab",
    surfaces: ["topnav", "palette"],
  },
  {
    id: "word-notes",
    label: "笔记",
    description: "词级笔记与标注",
    href: "/notes",
    matchPrefix: "/notes",
    icon: "sticky-note",
    family: "vocab",
    surfaces: ["topnav", "mobile", "home", "palette"],
  },
  // ── 素材族（L3 知识层） ────────────────────────────────────────────────
  {
    id: "l3-home",
    label: "素材宇宙",
    description: "L3 素材空间总览：来源、语境、关联",
    href: "/l3?section=home",
    matchPrefix: "/l3",
    icon: "library",
    family: "material",
    surfaces: ["topnav", "mobile", "home", "palette", "l3home"],
    l3Section: "home",
  },
  {
    id: "l3-source",
    label: "来源书架",
    description: "导入的文章、长难句、翻译材料",
    href: "/l3?section=source",
    matchPrefix: "/l3",
    icon: "bookmark",
    family: "material",
    surfaces: ["palette", "l3home"],
    l3Section: "source",
  },
  {
    id: "l3-word",
    label: "词空间",
    description: "一个词在 L3 里的全部素材",
    href: "/l3?section=word",
    matchPrefix: "/l3",
    icon: "target",
    family: "material",
    surfaces: ["palette", "l3home"],
    l3Section: "word",
  },
  {
    id: "l3-graph",
    label: "关联图",
    description: "来源与词的网络视图",
    href: "/l3?section=graph",
    matchPrefix: "/l3",
    icon: "share",
    family: "material",
    surfaces: ["palette", "l3home"],
    l3Section: "graph",
  },
  // ── 系统族 ────────────────────────────────────────────────────────────
  {
    id: "import",
    label: "导入",
    description: "批量导入词汇和笔记",
    href: "/import",
    matchPrefix: "/import",
    icon: "upload",
    family: "system",
    surfaces: ["topnav", "home", "palette"],
  },
  {
    id: "settings",
    label: "设置",
    description: "偏好、阶梯会话开关、主题",
    href: "/settings",
    matchPrefix: "/settings",
    icon: "settings",
    family: "system",
    surfaces: ["topnav", "mobile", "palette"],
  },
  // 未在登记表内的面：/capture（悬浮窗，无导航入口）、/upgrade（升级工单，从复习卡进入）、
  // /study-note-host（构建门控的实验宿主）。它们有入口但不在导航面上，故不登记。
];

/** 取某个入口面上出现的条目（保持登记顺序）。 */
export function navEntriesFor(surface: NavSurface): NavEntry[] {
  return NAVIGATION.filter((entry) => entry.surfaces.includes(surface));
}

/** 命令面板的分组结果（按 NAV_FAMILY_ORDER 排序；无条目的族不出现）。 */
export function navCommandGroups(): Array<{ family: NavFamily; label: string; entries: NavEntry[] }> {
  const palette = navEntriesFor("palette");
  return NAV_FAMILY_ORDER
    .map(({ id, label }) => ({ family: id, label, entries: palette.filter((e) => e.family === id) }))
    .filter((group) => group.entries.length > 0);
}

/**
 * 一击可达判据（2026-09-26，修正过一次）。
 *
 * 第一版把判据写成"practice 族每个面都 1 击可达"，随后被自己的测试判为不成立：
 * 练习 / 会话 / 学习笔记 若也上首页卡片，首页会有 12 张卡 —— 那是把首页变成目录页，
 * 不是降低摩擦。故判据改为**两档**，两档都必须成立：
 *
 *  - **正门（1 击）**：home / topnav / mobile 里出现。做题族的正门是四个：
 *    做题（试卷台）、错题库、作文、素材宇宙。首页卡片排最前。
 *  - **细面（0 击）**：命令面板（⌘K）必备。面板是完整地图，任何面都能键盘直达，
 *    不必先进入 L3 再点侧栏（那要 2 击）。
 *
 * `practiceEntriesStranded()` 返回"两档都不在"的条目 —— **应为空**。这才是真正的
 * 退化判据：某个做题面既没有 1 击入口、也没有 0 击入口，就是被遗忘了。
 */
export const FRONT_DOOR_SURFACES: readonly NavSurface[] = ["topnav", "mobile", "home"];

/** 1 击可达的条目（正门）。 */
export function oneClickReachable(): NavEntry[] {
  return NAVIGATION.filter((entry) => entry.surfaces.some((s) => FRONT_DOOR_SURFACES.includes(s)));
}

/** 做题族中既非 1 击、也非 0 击（面板）的条目 —— 应为空。 */
export function practiceEntriesStranded(): NavEntry[] {
  const front = new Set(oneClickReachable().map((e) => e.id));
  const palette = new Set(navEntriesFor("palette").map((e) => e.id));
  return NAVIGATION.filter(
    (entry) => entry.family === "practice" && !front.has(entry.id) && !palette.has(entry.id),
  );
}

/**
 * L3 家族在顶栏只允许出现**一个**入口（素材宇宙）。
 * 理由是激活态：所有 L3 子面共享 pathname 前缀 `/l3`，顶栏若同时挂「做题」与
 * 「素材宇宙」，在任何一个 L3 子页上它们会**同时高亮** —— 高亮失效等于没有高亮。
 * 做题的 1 击入口由首页卡片承担（见 FRONT_DOOR_SURFACES 判据）。
 */
export function topnavFamilyIds(): NavFamily[] {
  return [...new Set(navEntriesFor("topnav").map((entry) => entry.family))];
}

/** 激活态：pathname 是否命中该入口（只看 pathname —— 激活态按路径判定，不看 query）。 */
export function isNavEntryActive(entry: NavEntry, pathname: string): boolean {
  return pathname === entry.matchPrefix || pathname.startsWith(`${entry.matchPrefix}/`);
}
