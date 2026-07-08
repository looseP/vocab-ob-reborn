export type L3ShellSection = "home" | "import" | "proposals" | "recommendations" | "graph" | "context" | "word" | "source";

export const L3_SHELL_SECTIONS: Array<{ id: L3ShellSection; label: string }> = [
  { id: "home", label: "L3 Home" },
  { id: "import", label: "Import" },
  { id: "proposals", label: "Proposals" },
  { id: "recommendations", label: "Recommendations" },
  { id: "graph", label: "Graph" },
  { id: "context", label: "Context" },
  { id: "word", label: "Word Space" },
  { id: "source", label: "Source Space" },
];
