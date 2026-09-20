/**
 * 预览分块纯函数测试（R4）——与 domain 的引用标记识别同一语义的逐项矩阵。
 *
 * 覆盖：缩进代码 / 三·四反引号 / 波浪围栏 / 围栏内含另一种围栏 / 列表 / 引用块 /
 * 连续段落内同形文本（均不变引用卡）；合法独立顶层 marker（含大写 UUID 归一）变卡；
 * 无效 marker 不误报（域合同为抛错，作对照）；链接定义跨块上下文保持。
 */
import { describe, expect, it } from "vitest";
import { matchReferenceMarkerText, parseReferenceIds } from "@/domain/l3-study-notes";
import { splitStudyNotePreviewBlocks } from "@/frontend/utils/studyNotePreviewBlocks";

const REF = "00000000-0000-4000-8000-000000000801";
const REF2 = "00000000-0000-4000-8000-000000000802";
const M = `[[ref:${REF}]]`;

function refIds(bodyMd: string): string[] {
  return splitStudyNotePreviewBlocks(bodyMd)
    .filter((block): block is { kind: "reference"; refId: string } => block.kind === "reference")
    .map((block) => block.refId);
}

function markdownText(bodyMd: string): string {
  return splitStudyNotePreviewBlocks(bodyMd)
    .filter((block): block is { kind: "markdown"; text: string } => block.kind === "markdown")
    .map((block) => block.text)
    .join("");
}

describe("splitStudyNotePreviewBlocks · 与域合同一致", () => {
  it("缩进代码（4 空格）不是 marker（域合同 [] ↔ 预览无引用卡；原文保留）", () => {
    const bodyMd = `正文\n\n    ${M}\n\n结尾`;
    expect(parseReferenceIds(bodyMd)).toEqual([]);
    expect(refIds(bodyMd)).toEqual([]);
    expect(markdownText(bodyMd)).toContain(M);
  });

  it("三反引号围栏内 marker 不识别", () => {
    const bodyMd = `\`\`\`\n${M}\n\`\`\``;
    expect(parseReferenceIds(bodyMd)).toEqual([]);
    expect(refIds(bodyMd)).toEqual([]);
  });

  it("四反引号围栏（内含另一种围栏）不误判", () => {
    const bodyMd = `\`\`\`\`\n\`\`\`\n${M}\n\`\`\`\n\`\`\`\``;
    expect(parseReferenceIds(bodyMd)).toEqual([]);
    expect(refIds(bodyMd)).toEqual([]);
  });

  it("波浪围栏不识别", () => {
    const bodyMd = `~~~\ntext\n${M}\n~~~`;
    expect(parseReferenceIds(bodyMd)).toEqual([]);
    expect(refIds(bodyMd)).toEqual([]);
  });

  it("列表 / 引用块内 marker 不识别（与域合同一致）", () => {
    expect(refIds(`- ${M}`)).toEqual([]);
    expect(refIds(`1. ${M}`)).toEqual([]);
    expect(refIds(`> ${M}`)).toEqual([]);
    expect(parseReferenceIds(`- ${M}`)).toEqual([]);
    expect(parseReferenceIds(`> ${M}`)).toEqual([]);
  });

  it("普通连续段落内同形文本不识别；软换行混排不识别", () => {
    const inline = `前缀 ${M} 后缀`;
    expect(parseReferenceIds(inline)).toEqual([]);
    expect(refIds(inline)).toEqual([]);
    expect(markdownText(inline)).toContain(inline);

    const softBreak = `${M}\n紧接着的行`;
    expect(parseReferenceIds(softBreak)).toEqual([]);
    expect(refIds(softBreak)).toEqual([]);
  });

  it("合法独立顶层 marker → 引用卡（按顺序；大写 UUID 归一小写；原文移出 markdown）", () => {
    const upper = REF.toUpperCase();
    const bodyMd = `第一段\n\n[[ref:${upper}]]\n\n第二段\n\n[[ref:${REF2}]]`;
    expect(parseReferenceIds(bodyMd)).toEqual([REF, REF2]);
    expect(refIds(bodyMd)).toEqual([REF, REF2]);
    const md = markdownText(bodyMd);
    expect(md).toContain("第一段");
    expect(md).toContain("第二段");
    expect(md).not.toContain(`[[ref:${upper}]]`);
    expect(md).not.toContain(`[[ref:${REF2}]]`);
  });

  it("无效 marker（非 UUID）不误报为引用卡；域合同为抛错（对照）", () => {
    const bodyMd = "[[ref:not-a-uuid]]";
    expect(() => parseReferenceIds(bodyMd)).toThrow();
    expect(refIds(bodyMd)).toEqual([]);
    expect(markdownText(bodyMd)).toContain("[[ref:not-a-uuid]]");
  });

  it("链接定义上下文保持：def 前置复制到每个渲染块（跨块引用可解析）", () => {
    const bodyMd = `[foo]: /url\n\n[foo] 使用\n\n${M}\n\n[foo] 再用`;
    const blocks = splitStudyNotePreviewBlocks(bodyMd);
    expect(refIds(bodyMd)).toEqual([REF]);
    const markdowns = blocks.filter(
      (block): block is { kind: "markdown"; text: string } => block.kind === "markdown",
    );
    expect(markdowns.length).toBe(2);
    for (const block of markdowns) {
      expect(block.text).toContain("[foo]: /url"); // 定义随块携带
      expect(block.text).toContain("[foo]");
    }
  });

  it("空输入与 matchReferenceMarkerText 三分支（单真源；前缀 ref 小写、UUID 大小写不敏感）", () => {
    expect(splitStudyNotePreviewBlocks("")).toEqual([]);
    expect(matchReferenceMarkerText(M)).toEqual({ kind: "marker", refId: REF });
    expect(matchReferenceMarkerText(`[[ref:${REF.toUpperCase()}]]`)).toEqual({
      kind: "marker",
      refId: REF,
    });
    expect(matchReferenceMarkerText("普通文本")).toEqual({ kind: "none" });
    expect(matchReferenceMarkerText("[[ref:not-a-uuid]]")).toEqual({ kind: "invalid" });
  });
});
