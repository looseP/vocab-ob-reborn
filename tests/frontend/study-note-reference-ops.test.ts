/**
 * Task 09A · 引用正文操作域工具测试（先红后绿）。
 *
 * 纪律：marker 必须独占顶层段落；插入/删除/转换后 marker 集合与引用集合
 * 仍可由 `assertReferenceSet` 校验；工具纯文本、不读 React/DOM。
 */
import { describe, expect, it } from "vitest";
import { assertReferenceSet, parseReferenceIds, ReferenceContractError } from "@/domain/l3-study-notes";
import type { ReferencePreview } from "@/domain/l3-study-notes";
import {
  excerptLinesFromSnapshot,
  exportSchemaVersionForReferences,
  insertReferenceMarker,
  ReferenceMarkerPositionError,
  removeReferenceMarker,
  replaceMarkerWithExcerpt,
} from "@/frontend/utils/studyNoteReferenceOps";

const REF_A = "00000000-0000-4000-8000-000000000a01";
const REF_B = "00000000-0000-4000-8000-000000000b01";

describe("studyNoteReferenceOps · 插入", () => {
  it("空正文：插入裸标记（无多余空行）", () => {
    expect(insertReferenceMarker("", REF_A, null)).toBe(`[[ref:${REF_A}]]`);
    expect(insertReferenceMarker("", REF_A, 0)).toBe(`[[ref:${REF_A}]]`);
  });

  it("文末（光标在末尾，无尾随换行）：补空行边界", () => {
    expect(insertReferenceMarker("第一段正文", REF_A, 5)).toBe(
      `第一段正文\n\n[[ref:${REF_A}]]`,
    );
  });

  it("光标在段落中间：拆出独立段落（前后各补空行）", () => {
    expect(insertReferenceMarker("前文后文", REF_A, 2)).toBe(
      `前文\n\n[[ref:${REF_A}]]\n\n后文`,
    );
  });

  it("光标恰在既有空行边界：不重复补空行", () => {
    expect(insertReferenceMarker("前文\n\n后文", REF_A, 4)).toBe(
      `前文\n\n[[ref:${REF_A}]]\n\n后文`,
    );
  });

  it("插入后经 assertReferenceSet 校验（marker 与 capture write 一致）", () => {
    const body = insertReferenceMarker("正文", REF_A, 2);
    expect(() =>
      assertReferenceSet(body, [
        {
          id: REF_A,
          action: "capture",
          target: { kind: "source", sourceId: "00000000-0000-4000-8000-000000000001" },
        },
      ]),
    ).not.toThrow();
  });
});

describe("studyNoteReferenceOps · 删除", () => {
  it("删除独占段落的标记行（含其相邻空行，保持段落整齐）", () => {
    const body = `前文\n\n[[ref:${REF_A}]]\n\n后文`;
    expect(removeReferenceMarker(body, REF_A)).toBe("前文\n\n后文");
  });

  it("删除文首标记（其后空行一并清理）", () => {
    const body = `[[ref:${REF_A}]]\n\n后文`;
    expect(removeReferenceMarker(body, REF_A)).toBe("后文");
  });

  it("删除文末标记（其前空行一并清理）", () => {
    const body = `前文\n\n[[ref:${REF_A}]]`;
    expect(removeReferenceMarker(body, REF_A)).toBe("前文");
  });

  it("大小写归一：大写形态的 marker 同样可删", () => {
    const body = `前文\n\n[[ref:${REF_A.toUpperCase()}]]\n\n后文`;
    expect(removeReferenceMarker(body, REF_A)).toBe("前文\n\n后文");
  });

  it("仅删除目标标记：其他引用不受影响", () => {
    const body = `前\n\n[[ref:${REF_A}]]\n\n中\n\n[[ref:${REF_B}]]\n\n后`;
    expect(removeReferenceMarker(body, REF_A)).toBe(`前\n\n中\n\n[[ref:${REF_B}]]\n\n后`);
  });

  it("marker 不存在：显式报错（不静默成功）", () => {
    expect(() => removeReferenceMarker("无标记正文", REF_A)).toThrow(ReferenceContractError);
  });
});

describe("studyNoteReferenceOps · 转换普通摘录", () => {
  it("marker 行替换为摘录行；与移除不同——文本保留", () => {
    const body = `前文\n\n[[ref:${REF_A}]]\n\n后文`;
    const excerpt = ["> 「原文摘录」", "> —— 来源标题"];
    expect(replaceMarkerWithExcerpt(body, REF_A, excerpt)).toBe(
      `前文\n\n> 「原文摘录」\n> —— 来源标题\n\n后文`,
    );
  });

  it("转换后 marker 消失、断言可检查（供调用方同步移除 write）", () => {
    const body = `[[ref:${REF_A}]]`;
    const next = replaceMarkerWithExcerpt(body, REF_A, ["> 摘录"]);
    expect(next).toBe("> 摘录");
    expect(next).not.toContain("[[ref:");
  });

  it("marker 不存在：显式报错", () => {
    expect(() => replaceMarkerWithExcerpt("无标记", REF_A, ["> x"])).toThrow(ReferenceContractError);
  });
});

describe("studyNoteReferenceOps · 摘录行生成", () => {
  const base: Omit<ReferencePreview, "displaySnapshot"> = {
    id: REF_A,
    target: { kind: "source", sourceId: "00000000-0000-4000-8000-000000000001" },
    status: "current",
    capturedAt: "2026-09-20T00:00:00.000Z",
    liveTitle: "来源标题",
  };

  it("source：标题 + 来源行", () => {
    const meta: ReferencePreview = {
      ...base,
      displaySnapshot: { kind: "source", title: "来源标题", excerpt: "摘要" },
    };
    expect(excerptLinesFromSnapshot(meta)).toEqual(["> 「来源标题」", "> —— 来源"]);
  });

  it("source_quote：引文 + 来源标题", () => {
    const meta: ReferencePreview = {
      ...base,
      displaySnapshot: { kind: "source_quote", title: "来源标题", quote: "原文片段" },
    };
    expect(excerptLinesFromSnapshot(meta)).toEqual(["> 「原文片段」", "> —— 来源标题"]);
  });

  it("question：题干 + 题型/来源描述", () => {
    const meta: ReferencePreview = {
      ...base,
      displaySnapshot: {
        kind: "question",
        stem: "题干内容",
        options: [],
        questionType: "cloze",
        sourceTitle: "来源A",
      },
    };
    expect(excerptLinesFromSnapshot(meta)).toEqual(["> 题干内容", "> —— 题目（cloze）· 来源A"]);
  });

  it("option_quote：选项引文 + 选项号", () => {
    const meta: ReferencePreview = {
      ...base,
      displaySnapshot: {
        kind: "option_quote",
        optionKey: "B",
        quote: "选项文本",
        questionType: "reading_choice",
        sourceTitle: null,
      },
    };
    expect(excerptLinesFromSnapshot(meta)).toEqual(["> 「选项文本」", "> —— 选项 B（reading_choice）"]);
  });

  it("多行 quote：逐行转换为引用块行（不破坏 Markdown 引用语义）", () => {
    const meta: ReferencePreview = {
      ...base,
      displaySnapshot: { kind: "source_quote", title: "T", quote: "第一行\n第二行" },
    };
    expect(excerptLinesFromSnapshot(meta)).toEqual(["> 「第一行", "> 第二行」", "> —— T"]);
  });
});

describe("studyNoteReferenceOps · R3/R4 完整 Markdown 顶层语义", () => {
  const REF_C = "00000000-0000-4000-8000-000000000c01";

  it("R3：删除只动真实顶层段落，围栏代码中的同形示例逐字保留", () => {
    const marker = `[[ref:${REF_C}]]`;
    const code = ["```md", marker, "```"].join("\n");
    const body = `${code}\n\n${marker}`;
    // 域合同视角：代码块内的同形文本不是 marker，顶层那条才是
    assertReferenceSet(body, [{ id: REF_C, action: "keep" }]);

    const next = removeReferenceMarker(body, REF_C);
    expect(next).toContain(code); // 代码示例原样
    expect(next).not.toContain(`\n\n${marker}`); // 顶层标记已移除
    expect(() => assertReferenceSet(next, [])).not.toThrow();
  });

  it("R3：转换只替换真实顶层段落，围栏代码中的同形示例逐字保留", () => {
    const marker = `[[ref:${REF_C}]]`;
    const code = ["```md", marker, "```"].join("\n");
    const body = `${code}\n\n${marker}`;
    assertReferenceSet(body, [{ id: REF_C, action: "keep" }]);

    const next = replaceMarkerWithExcerpt(body, REF_C, ["> confirmed excerpt"]);
    expect(next).toContain(code);
    expect(next).toContain("> confirmed excerpt");
    expect(() => assertReferenceSet(next, [])).not.toThrow();
  });

  it.each([
    ["缩进代码", ["    " + `[[ref:${REF_C}]]`].join("\n")],
    ["列表项", ["- item", "  " + `[[ref:${REF_C}]]`].join("\n")],
    ["引用块", ["> quoted " + `[[ref:${REF_C}]]`].join("\n")],
  ])("R3：%s 中的同形文本不是 marker，删除不波及容器内容", (_label, container) => {
    const marker = `[[ref:${REF_C}]]`;
    const body = `${container}\n\n${marker}`;
    assertReferenceSet(body, [{ id: REF_C, action: "keep" }]);

    const next = removeReferenceMarker(body, REF_C);
    expect(next).toContain(container); // 容器内容逐字保留
    expect(() => assertReferenceSet(next, [])).not.toThrow();
  });

  it("R3：仅移除目标引用，相邻引用的顶层段落与正文保持原样", () => {
    const markerA = `[[ref:${REF_A}]]`;
    const markerB = `[[ref:${REF_B}]]`;
    const body = `前\n\n${markerA}\n\n中\n\n${markerB}\n\n后`;
    const next = removeReferenceMarker(body, REF_A);
    expect(next).toBe(`前\n\n中\n\n${markerB}\n\n后`);
  });

  it("R4：光标在围栏代码内插入被明确拒绝（抛错，调用方保持正文不变）", () => {
    const body = ["```md", "example", "```"].join("\n");
    expect(() => insertReferenceMarker(body, REF_A, body.indexOf("example") + 3)).toThrow(
      ReferenceMarkerPositionError,
    );
  });

  it.each([
    ["列表项", ["- item", "  text"].join("\n")],
    ["引用块", ["> quoted", "> more"].join("\n")],
    ["缩进代码", ["    code line"].join("\n")],
  ])("R4：光标在%s内部插入被明确拒绝", (_label, container) => {
    expect(() => insertReferenceMarker(container, REF_A, 3)).toThrow(ReferenceMarkerPositionError);
  });

  it("R4：光标在既有 marker 段落内部插入被拒绝（标记必须独占段落）", () => {
    const marker = `[[ref:${REF_A}]]`;
    const body = `前文\n\n${marker}\n\n后文`;
    expect(() => insertReferenceMarker(body, REF_B, body.indexOf(marker) + 3)).toThrow(
      ReferenceMarkerPositionError,
    );
  });

  it("R4：顶层段落内插入成功且结果通过真实语义预检（marker 集合 == references）", () => {
    const body = "前文后文";
    const next = insertReferenceMarker(body, REF_A, 2);
    expect(() =>
      assertReferenceSet(next, [
        {
          id: REF_A,
          action: "capture",
          target: { kind: "source", sourceId: "00000000-0000-4000-8000-000000000001" },
        },
      ]),
    ).not.toThrow();
  });

  it("R4：在既有标记段落之间的空行处插入 → 两枚标记仍是各自独立段落（结果合法）", () => {
    const markerA = `[[ref:${REF_A}]]`;
    const body = `${markerA}

后文`;
    // 光标落在标记段落后的空行上：插入结果与既有标记之间仍保留空行 → 各自独立顶层段落
    const next = insertReferenceMarker(body, REF_B, markerA.length + 1);
    expect(next).toBe(`${markerA}

[[ref:${REF_B}]]

后文`);
    expect(parseReferenceIds(next)).toEqual([REF_A, REF_B]);
    expect(() =>
      assertReferenceSet(next, [
        { id: REF_A, action: "keep" },
        { id: REF_B, action: "capture", target: { kind: "source", sourceId: "00000000-0000-4000-8000-000000000001" } },
      ]),
    ).not.toThrow();
  });

  it("R4：插入结果若无法构成独立顶层段落，则拒绝（不产出不可保存正文）", () => {
    const markerA = `[[ref:${REF_A}]]`;
    // 正文以标记段落开头且光标在段落**内部** → 标记内部不可插入
    const body = `${markerA}

后文`;
    expect(() => insertReferenceMarker(body, REF_B, 3)).toThrow(ReferenceMarkerPositionError);
  });
});

/**
 * DEFECT 2（P2）· CRLF 正文中的引用标记无法删除/转换。
 *
 * 持久化正文不保证 LF-only（保存 schema 为 `z.string().max`，服务端直接落库 bodyMd），
 * 而 marked 会把 CRLF/CR 归一为 LF 进入 `token.raw`——因此 token.raw 的**长度**
 * 不能当作原文坐标推进量。定位必须走「解析坐标 → 原文坐标」的映射（此处：按行内容
 * 逐行对齐，行分隔符不同不算不匹配），删除/转换/插入共用同一套容器位置规则。
 */
describe("studyNoteReferenceOps · DEFECT2 CRLF 原文坐标", () => {
  const id = "00000000-0000-4000-8000-000000000801";
  const prefix = "intro\r\n\r\n";
  const body = prefix + `[[ref:${id}]]`;

  it("DEFECT2：CRLF 正文中 remove/replace 必须命中真实顶层 marker", () => {
    assertReferenceSet(body, [{ id, action: "keep" }]);

    const removed = removeReferenceMarker(body, id);
    assertReferenceSet(removed, []);
    expect(removed).toBe("intro");

    expect(replaceMarkerWithExcerpt(body, id, ["> saved excerpt"])).toBe(prefix + "> saved excerpt");
  });

  it("DEFECT2：CRLF 非目标正文逐字保留（marker 前后的 CRLF 字节不得被改写）", () => {
    const next = replaceMarkerWithExcerpt(body, id, ["> saved excerpt"]);
    expect(next.startsWith("intro\r\n\r\n")).toBe(true);
    expect(next).not.toContain("\r\r");
    expect(next.includes("\n\n") && !next.includes("\r\n\r\n")).toBe(false);
  });

  it.each([
    ["LF", "intro\n\n"],
    ["CRLF", "intro\r\n\r\n"],
    ["CR-only", "intro\r\r"],
  ])("DEFECT2：%s 换行的前置正文：删除与转换都命中，且前置正文逐字保留", (_label, pre) => {
    const source = pre + `[[ref:${id}]]`;
    assertReferenceSet(source, [{ id, action: "keep" }]);

    const removed = removeReferenceMarker(source, id);
    assertReferenceSet(removed, []);
    expect(removed).toBe("intro");

    const converted = replaceMarkerWithExcerpt(source, id, ["> excerpt"]);
    expect(converted).toBe(pre + "> excerpt");
    assertReferenceSet(converted, []);
  });

  it("DEFECT2：混合换行（CRLF 前文 + LF 边界）同样命中，前置正文逐字保留", () => {
    const pre = "前文\r\n\r\n";
    const source = pre + `[[ref:${id}]]` + "\n\n后文";
    assertReferenceSet(source, [{ id, action: "keep" }]);

    const removed = removeReferenceMarker(source, id);
    expect(removed).toBe("前文\r\n\r\n后文");
    assertReferenceSet(removed, []);
  });

  it("DEFECT2：CRLF 正文中「前有链接定义」不影响定位（定义行逐字保留）", () => {
    const def = "[a]: /url\r\n";
    const source = def + prefix + `[[ref:${id}]]`;
    assertReferenceSet(source, [{ id, action: "keep" }]);

    const removed = removeReferenceMarker(source, id);
    expect(removed).toBe(def + "intro");
    assertReferenceSet(removed, []);

    expect(replaceMarkerWithExcerpt(source, id, ["> excerpt"])).toBe(def + prefix + "> excerpt");
  });

  it("DEFECT2：围栏代码内的同名标记 + CRLF 顶层真标记：只动真标记，代码逐字保留", () => {
    const marker = `[[ref:${id}]]`;
    const code = ["```md", marker, "```"].join("\r\n");
    const source = code + "\r\n\r\n" + marker;
    assertReferenceSet(source, [{ id, action: "keep" }]);

    const removed = removeReferenceMarker(source, id);
    expect(removed).toContain(code); // 代码示例逐字保留（含 CRLF）
    assertReferenceSet(removed, []);

    const converted = replaceMarkerWithExcerpt(source, id, ["> excerpt"]);
    expect(converted).toContain(code);
    expect(converted).toContain("> excerpt");
    assertReferenceSet(converted, []);
  });

  it("DEFECT2：CRLF 正文中光标落在围栏代码内 → 拒绝插入且正文不变", () => {
    const codeBody = ["```md", "example", "```"].join("\r\n");
    const snapshot = codeBody;
    expect(() => insertReferenceMarker(codeBody, REF_A, codeBody.indexOf("example") + 3)).toThrow(
      ReferenceMarkerPositionError,
    );
    expect(codeBody).toBe(snapshot); // 拒绝时不产生任何正文变更
  });

  it("DEFECT2：CRLF 正文中光标落在容器外 → 合法插入（沿用 CRLF 风格）", () => {
    const source = "前文\r\n\r\n后文";
    const next = insertReferenceMarker(source, REF_A, 2);
    expect(next).toBe(`前文\r\n\r\n[[ref:${REF_A}]]\r\n\r\n后文`);
    expect(() =>
      assertReferenceSet(next, [
        {
          id: REF_A,
          action: "capture",
          target: { kind: "source", sourceId: "00000000-0000-4000-8000-000000000001" },
        },
      ]),
    ).not.toThrow();
  });
});

describe("studyNoteReferenceOps · 导出 schema 版本选择（N2/P4）", () => {
  const previewWith = (displaySnapshot: ReferencePreview["displaySnapshot"]): ReferencePreview => ({
    id: REF_A,
    target: { kind: "source", sourceId: "00000000-0000-4000-8000-000000000001" },
    status: "current",
    capturedAt: "2026-09-20T00:00:00.000Z",
    liveTitle: null,
    displaySnapshot,
  });

  it("纯 N1 引用型 → 1（v1 冻结面，旧客户端兼容）", () => {
    expect(
      exportSchemaVersionForReferences([
        previewWith({ kind: "source", title: "T", excerpt: "x" }),
        previewWith({ kind: "question", stem: "S", options: [], questionType: "cloze", sourceTitle: null }),
      ]),
    ).toBe(1);
  });

  it("含评析（N2）引用 → 2（v1 冻结面不接受，不静默降级）", () => {
    expect(
      exportSchemaVersionForReferences([
        previewWith({ kind: "source", title: "T", excerpt: "x" }),
        previewWith({ kind: "assessment", excerpt: "评析", questionType: "cloze", sourceTitle: null }),
      ]),
    ).toBe(2);
  });

  it("无引用 → 1（不因空集合选 v2）", () => {
    expect(exportSchemaVersionForReferences([])).toBe(1);
  });
});

/**
 * N2 第四条链（ADR-0039 决策 5/8）：评卷摘录行的前端口径。
 *
 * 承重点在**空分析**分支：agent 常常只给判定不给分析，那一行卡片不能塌成
 * 「undefined」或只剩一个空引用块 —— 摘要必须仍能说明「钉的是一条 wrong」。
 */
describe("studyNoteReferenceOps · 评卷摘录行（ADR-0039）", () => {
  const base: Omit<ReferencePreview, "displaySnapshot"> = {
    id: REF_A,
    target: { kind: "grading", sheetId: "00000000-0000-4000-8000-000000000301", questionId: "00000000-0000-4000-8000-000000000211" },
    status: "current",
    capturedAt: "2026-09-20T00:00:00.000Z",
    liveTitle: "第 2 题",
  };

  it("有分析：判定 + 分析摘录 + 归属行", () => {
    const meta: ReferencePreview = {
      ...base,
      displaySnapshot: {
        kind: "grading",
        verdict: "wrong",
        analysisExcerpt: "限定词 which 读成了 what。",
        gradedBy: "agent-1",
        gradedAt: "2026-09-26T00:00:00.000Z",
        questionOrdinal: 2,
        questionType: "reading_choice",
        sourceTitle: "2023 Text2",
      },
    };
    const lines = excerptLinesFromSnapshot(meta);
    expect(lines[0]).toContain("限定词 which 读成了 what。");
    expect(lines.join("\n")).toContain("agent-1");
  });

  it("无分析：仍出一行判定，不塌成空摘要", () => {
    const meta: ReferencePreview = {
      ...base,
      displaySnapshot: {
        kind: "grading",
        verdict: "correct",
        analysisExcerpt: "",
        gradedBy: "agent-2",
        gradedAt: "2026-09-26T00:00:00.000Z",
        questionOrdinal: 2,
        questionType: "reading_choice",
        sourceTitle: "2023 Text2",
      },
    };
    const lines = excerptLinesFromSnapshot(meta);
    expect(lines.length).toBeGreaterThan(0);
    // 判定走单一真源的**中文标签**（GRADING_VERDICT_LABELS），不是裸枚举值。
    expect(lines.join("\n")).toContain("判定：对");
    expect(lines.join("\n")).not.toContain("correct");
    expect(lines.join("\n")).not.toContain("undefined");
  });
});

/**
 * N2 第五条链（ADR-0040 决策 4）：写作摘录行的前端口径。
 *
 * 承重点在**空维度摘录**分支：评阅可能只有 summary（维度全不适用），那一行
 * 卡片不能塌成空块 —— 摘要必须仍能说明「钉的是一条评阅」；且任何分支都不得
 * 出现分数（schema 显式无 score）。
 */
describe("studyNoteReferenceOps · 写作摘录行（ADR-0040）", () => {
  const taskBase: Omit<ReferencePreview, "displaySnapshot"> = {
    id: REF_A,
    target: { kind: "writing_task", taskId: "00000000-0000-4000-8000-000000000401" },
    status: "current",
    capturedAt: "2026-09-20T00:00:00.000Z",
    liveTitle: "考研英语一 2023 作文",
  };

  const feedbackBase: Omit<ReferencePreview, "displaySnapshot"> = {
    id: REF_A,
    target: { kind: "writing_feedback", sheetId: "00000000-0000-4000-8000-000000000301" },
    status: "current",
    capturedAt: "2026-09-20T00:00:00.000Z",
    liveTitle: null,
  };

  it("任务：标题 + 类型/方向出处行", () => {
    const meta: ReferencePreview = {
      ...taskBase,
      displaySnapshot: { kind: "writing_task", title: "考研英语一 2023 作文", taskKind: "whole", direction: "考研" },
    };
    const lines = excerptLinesFromSnapshot(meta);
    expect(lines.join("\n")).toContain("考研英语一 2023 作文");
    expect(lines.join("\n")).toContain("whole");
    expect(lines.join("\n")).toContain("考研");
  });

  it("评阅：summary 全文 + 维度摘录 + 出处行，无分数", () => {
    const meta: ReferencePreview = {
      ...feedbackBase,
      displaySnapshot: {
        kind: "writing_feedback",
        summary: "论点清晰，但第二段论证跳步。",
        excerpt: "紧扣题意，没有跑题。",
      },
    };
    const lines = excerptLinesFromSnapshot(meta);
    expect(lines.join("\n")).toContain("论点清晰");
    expect(lines.join("\n")).toContain("紧扣题意");
    expect(lines.join("\n")).toContain("评阅");
    expect(lines.join("\n")).not.toMatch(/得分|评分|分\b/);
    expect(lines.join("\n")).not.toContain("undefined");
  });

  it("评阅无维度摘录：仍出 summary 行，不塌成空摘要", () => {
    const meta: ReferencePreview = {
      ...feedbackBase,
      displaySnapshot: { kind: "writing_feedback", summary: "写得不错。", excerpt: "" },
    };
    const lines = excerptLinesFromSnapshot(meta);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).toContain("写得不错。");
    expect(lines.join("\n")).not.toContain("undefined");
  });

  it("含写作引用 → 导出选 v2（非白名单即 v2，后续 kind 无需再改）", () => {
    expect(
      exportSchemaVersionForReferences([
        {
          id: REF_A,
          target: { kind: "writing_task", taskId: "00000000-0000-4000-8000-000000000401" },
          status: "current",
          capturedAt: "2026-09-20T00:00:00.000Z",
          liveTitle: null,
          displaySnapshot: { kind: "writing_task", title: "T", taskKind: "whole", direction: "考研" },
        },
      ]),
    ).toBe(2);
  });
});