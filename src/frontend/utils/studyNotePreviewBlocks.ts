/**
 * 学习笔记预览分块（R4）——与 domain 的引用标记识别**同一语义**（单真源复用）。
 *
 * 规则：仅当完整 Markdown 的**顶层 paragraph token** 的 text 完全等于
 * `[[ref:<uuid>]]`（UUID 合法、大小写归一）时，替换为引用占位块；
 * 其余内容（缩进代码 / 围栏代码 / 列表 / 引用块 / 连续段落 / 链接定义 /
 * 内联同形文本）一律保持原文，交由现有净化链（Markdown 组件）渲染，不退化。
 *
 * - 非法标记（形状匹配但 UUID 非法）按普通 Markdown 保留（不误报引用卡；
 *   该正文会被保存预检/服务端拒绝，预览不承担纠错提示）；
 * - 纯函数、零 IO；不依赖 React；遵守 domain 依赖方向（只读 domain 纯函数）。
 */
import { lexer } from "marked";
import { matchReferenceMarkerText } from "@/domain/l3-study-notes";

export type StudyNotePreviewBlock =
  | { kind: "markdown"; text: string }
  | { kind: "reference"; refId: string };

/**
 * 将正文拆为「Markdown 原文块」与「引用占位块」（按顶层 token 顺序）。
 *
 * - Markdown 块保留 token.raw 原文（不重新序列化、不拆散 token）；
 * - 链接定义（def token）在 CommonMark 中为「文档级有效」：引用卡把文档切成多个
 *   渲染单元后，定义与使用可能分离 → 将全部 def 原文**前置复制**到每个 markdown
 *   块（def 渲染为空输出、同内容重复定义以第一个生效，无可见副作用），
 *   保持「链接定义上下文」不退化。
 */
export function splitStudyNotePreviewBlocks(bodyMd: string): StudyNotePreviewBlock[] {
  if (typeof bodyMd !== "string" || bodyMd.length === 0) return [];
  const tokens = lexer(bodyMd);
  const defsPrefix = tokens
    .filter((token) => token.type === "def")
    .map((token) => (typeof token.raw === "string" ? token.raw : ""))
    .join("");
  const blocks: StudyNotePreviewBlock[] = [];
  let markdown = "";
  const pushMarkdown = (): void => {
    if (!markdown) return;
    blocks.push({ kind: "markdown", text: defsPrefix ? `${defsPrefix}\n${markdown}` : markdown });
    markdown = "";
  };
  for (const token of tokens) {
    const raw = typeof token.raw === "string" ? token.raw : "";
    if (token.type === "paragraph") {
      const text = (token as { text?: unknown }).text;
      if (typeof text === "string") {
        const match = matchReferenceMarkerText(text);
        if (match.kind === "marker") {
          pushMarkdown();
          blocks.push({ kind: "reference", refId: match.refId });
          continue;
        }
      }
    }
    markdown += raw;
  }
  pushMarkdown();
  return blocks;
}
