export type L3ShellSection =
  | "home"
  | "manual"
  | "import"
  | "proposals"
  | "recommendations"
  | "graph"
  | "context"
  | "word"
  | "source"
  | "papers"
  | "writing"
  // 学习笔记子空间（Task 08）：/l3?section=study-notes（列表/专题/深链/离页屏障）。
  | "studyNotes"
  | "practice"
  | "errorBook"
  | "session";

export const L3_SHELL_SECTIONS: Array<{ id: L3ShellSection; label: string }> = [
  { id: "home", label: "空间首页" },
  { id: "source", label: "来源书架" },
  { id: "papers", label: "试卷台" },
  // 作文子空间 v1（W7）：一级入口「作文」（/l3?section=writing）。
  { id: "writing", label: "作文" },
  // 学习笔记子空间（Task 08）：一级入口「学习笔记」（/l3?section=study-notes）。
  { id: "studyNotes", label: "学习笔记" },
  { id: "word", label: "词空间" },
  { id: "context", label: "语境条目" },
  { id: "graph", label: "关联图" },
  { id: "practice", label: "练习" },
  { id: "errorBook", label: "错题库" },
  { id: "session", label: "会话" },
  { id: "import", label: "批量导入" },
  { id: "manual", label: "手动编辑" },
  { id: "proposals", label: "提议审查" },
  { id: "recommendations", label: "推荐" },
];

/**
 * 用户主流程入口（侧栏一级项）；其余 section 归入侧栏底部「工程工具」折叠组。
 * T11（ADR-0019）：练习 / 错题库 / 会话是输出闭环的用户表面，随读取面一并入主流程。
 * B1（体验层）：「空间首页」= 素材宇宙，是 /l3 的默认落地与"开门第一眼"，
 * 因此从工具组提为一级并置于首位（设计基线 §2 IA-1 / IA-2）。
 */
export const L3_SHELL_CORE_SECTIONS: L3ShellSection[] = ["home", "source", "papers", "writing", "studyNotes", "graph", "practice", "errorBook", "session"];
