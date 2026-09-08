export type L3ShellSection = "home" | "manual" | "import" | "proposals" | "recommendations" | "graph" | "context" | "word" | "source";

export const L3_SHELL_SECTIONS: Array<{ id: L3ShellSection; label: string }> = [
  { id: "home", label: "空间首页" },
  { id: "source", label: "来源书架" },
  { id: "word", label: "词空间" },
  { id: "context", label: "语境条目" },
  { id: "graph", label: "关联图" },
  { id: "import", label: "批量导入" },
  { id: "manual", label: "手动编辑" },
  { id: "proposals", label: "提议审查" },
  { id: "recommendations", label: "推荐" },
];
