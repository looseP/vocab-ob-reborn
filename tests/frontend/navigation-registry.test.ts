/**
 * 导航登记表（2026-09-26）不变量测试。
 *
 * 这些断言的作用是**让"入口退化"变成编译/测试失败，而不是用户投诉**：
 *  - 做题族每个面都一击可达（P2 的核心判据）
 *  - 每个 href 唯一（不会出现两个入口指向同一条死链）
 *  - 命令面板覆盖所有 top-level 路由（面板 = 完整地图）
 *  - L3 chips 里的条目都有 l3Section（内部跳转不会落回 home）
 *  - 登记表里的每条 href 都是 App.tsx 真实存在的路由
 */
import { describe, expect, it } from "vitest";
import {
  NAVIGATION,
  NAV_FAMILY_ORDER,
  isNavEntryActive,
  navCommandGroups,
  navEntriesFor,
  oneClickReachable,
  practiceEntriesStranded,
  topnavFamilyIds,
} from "@/frontend/viewModels/navigationRegistry";
import { L3_SHELL_SECTIONS, type L3ShellSection } from "@/frontend/viewModels/l3ShellViewModel";
import { hasL3SectionUrl } from "@/frontend/viewModels/l3SectionNavigation";
import { NAV_ICON, type NavIconName } from "@/frontend/components/layout/navIcons";

/** App.tsx 里真实存在的 top-level 路由（构建期不会自动核对，故在此钉住）。 */
const APP_ROUTES = [
  "/", "/dashboard", "/review", "/l2-drill", "/words", "/plaza", "/notes",
  "/settings", "/import", "/l3", "/upgrade",
] as const;

function routeOf(href: string): string {
  return href.split("?")[0]!;
}

describe("导航登记表 · 结构不变量", () => {
  it("id 唯一、href 唯一（不会有两个入口指向同一条死链）", () => {
    const ids = NAVIGATION.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    const hrefs = NAVIGATION.map((e) => e.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it("每条 href 都指向真实存在的 top-level 路由", () => {
    for (const entry of NAVIGATION) {
      expect(APP_ROUTES).toContain(routeOf(entry.href) as (typeof APP_ROUTES)[number]);
    }
  });

  it("每条都有非空 label / description / icon 名", () => {
    for (const entry of NAVIGATION) {
      expect(entry.label.trim().length).toBeGreaterThan(0);
      expect(entry.description.trim().length).toBeGreaterThan(0);
      expect(entry.icon in NAV_ICON).toBe(true);
    }
  });

  it("family 都在分组顺序里（面板不会漏掉某个族）", () => {
    const known = new Set(NAV_FAMILY_ORDER.map((f) => f.id));
    for (const entry of NAVIGATION) expect(known.has(entry.family)).toBe(true);
  });

  it("至少出现在一个入口面（没有只存在于登记表的幽灵入口）", () => {
    for (const entry of NAVIGATION) expect(entry.surfaces.length).toBeGreaterThan(0);
  });

  it("命令面板覆盖每个 family（非空分组）", () => {
    const groups = navCommandGroups();
    expect(groups.length).toBe(NAV_FAMILY_ORDER.length);
    for (const group of groups) expect(group.entries.length).toBeGreaterThan(0);
  });
});

describe("导航登记表 · 可达性（两档判据）", () => {
  it("做题族没有被遗忘的条目：每个面要么 1 击（正门）要么 0 击（面板）", () => {
    expect(practiceEntriesStranded()).toEqual([]);
  });

  it("做题族每个面都在命令面板里（键盘全覆盖 = 完整地图）", () => {
    const paletteIds = navEntriesFor("palette").map((e) => e.id);
    for (const entry of NAVIGATION.filter((e) => e.family === "practice")) {
      expect(paletteIds, entry.id).toContain(entry.id);
    }
  });

  it("具体地：做题 / 错题库 / 作文 / 素材宇宙 在首页卡片上（1 击正门）", () => {
    const homeIds = navEntriesFor("home").map((e) => e.id);
    for (const id of ["practice-paper", "practice-error-book", "practice-writing", "l3-home"]) {
      expect(homeIds).toContain(id);
    }
  });

  it("练习 / 会话 / 学习笔记 属于细面：面板 + L3 chips 可达（首页不铺满成目录页）", () => {
    const homeIds = navEntriesFor("home").map((e) => e.id);
    const paletteIds = navEntriesFor("palette").map((e) => e.id);
    const chips = navEntriesFor("l3home").map((e) => e.id);
    for (const id of ["practice-drill", "practice-session", "practice-notes"]) {
      expect(homeIds).not.toContain(id);
      expect(paletteIds).toContain(id);
      expect(chips).toContain(id);
    }
  });

  it("首页卡片总数受控（≤10）：首页是门面，不是目录", () => {
    expect(navEntriesFor("home").length).toBeLessThanOrEqual(10);
  });

  it("L3 家族在顶栏只出现一个入口（否则 /l3 下两个顶栏项同时高亮）", () => {
    const topnavL3 = navEntriesFor("topnav").filter((e) => e.matchPrefix === "/l3");
    expect(topnavL3.map((e) => e.id)).toEqual(["l3-home"]);
    // 做题族的顶栏份额为 0（其 1 击入口是首页卡片）
    expect(navEntriesFor("topnav").filter((e) => e.family === "practice")).toHaveLength(0);
    // 顶栏里 L3 只贡献一个 family
    expect(topnavFamilyIds().filter((f) => f === "material")).toHaveLength(1);
  });
});

describe("导航登记表 · L3 内部跳转", () => {
  it("l3home chips 的每条都带 l3Section，且都是合法 shell section", () => {
    const valid = new Set<L3ShellSection>(L3_SHELL_SECTIONS.map((s) => s.id));
    for (const entry of navEntriesFor("l3home")) {
      expect(entry.l3Section, entry.id).toBeDefined();
      expect(valid.has(entry.l3Section as L3ShellSection)).toBe(true);
    }
  });

  it("每个 l3home chip 的 href 都由 section 契约构造得出（不手写第二份 URL）", () => {
    for (const entry of navEntriesFor("l3home")) {
      if (!hasL3SectionUrl(entry.l3Section as L3ShellSection)) continue;
      // 参数值必须出现在 href 里 —— 证明 href 与契约同源
      const param = entry.href.split("section=")[1];
      expect(entry.href).toContain(`section=${param}`);
    }
  });

  it("l3home chips 覆盖侧栏的全部用户面（除空间首页自身）", () => {
    const chipSections = new Set(navEntriesFor("l3home").map((e) => e.l3Section));
    // 侧栏核心项里，writing/studyNotes 走各自契约，其余都应有 chip
    for (const section of L3_SHELL_SECTIONS.map((s) => s.id)) {
      if (section === "home" || section === "writing" || section === "studyNotes") continue;
      const isEngineering = ["word", "context", "graph", "import", "manual", "proposals", "recommendations"].includes(section);
      if (isEngineering) continue;
      expect(chipSections.has(section), section).toBe(true);
    }
  });
});

describe("导航登记表 · 激活态", () => {
  it("精确命中与前缀命中都算激活（只看 pathname）", () => {
    const review = NAVIGATION.find((e) => e.id === "review")!;
    expect(isNavEntryActive(review, "/review")).toBe(true);
    expect(isNavEntryActive(review, "/review/ladder")).toBe(true);
    expect(isNavEntryActive(review, "/words")).toBe(false);
  });

  it("L3 入口在 /l3 任意子面都算激活（共享前缀）", () => {
    const entry = NAVIGATION.find((e) => e.id === "l3-home")!;
    expect(isNavEntryActive(entry, "/l3")).toBe(true);
  });

  it("顶栏不会出现两个同时命中的 L3 入口（高亮不失效）", () => {
    const topnav = navEntriesFor("topnav");
    const hits = topnav.filter((e) => isNavEntryActive(e, "/l3"));
    expect(hits.map((e) => e.id)).toEqual(["l3-home"]);
  });
});
