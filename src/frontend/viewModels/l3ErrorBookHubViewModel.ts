/**
 * 错题库枢纽 · 视图模型（2026-09-26）。
 *
 * 错题库此前是**死胡同**：唯一动作是「查看语境」跳到只读检查器
 * （`再练|重练|再来一次` 全库 0 命中）。收错题的面没有消费错题的出口，
 * 于是「素材 → 练习 → 记录 → 错题 → 再练习」这个环只开了前半段。
 *
 * 本模块是纯函数：把统一投影的条目变成「分区 + 回流出口」，不碰网络与路由。
 * 出口一律**站内生成 URL**（禁止任意 returnUrl / history.back，与
 * writingNavigation 同纪律）：
 *  - 句级 → `/l3?section=practice&context=<id>`：练习页据此只练这一条语境。
 *  - 题级 → 有来源走题型空间深链（`venue`/`file`/`question`/`resumeSheet`），
 *    有题纸走 F-1 回看深链（`?sheet=`），两者都无 → **不给出链接**（如实说清
 *    为什么不可回看，不给死按钮）。
 */
import type { L3UnifiedErrorBookItem } from "@/domain";
import { L3ErrorBookKind } from "@/domain";
import { buildL3SectionUrl } from "./l3SectionNavigation";

/** 两腿的中文标签（分区标题 + 徽标，单一真源）。 */
export const ERROR_BOOK_KIND_LABELS: Record<L3ErrorBookKind, string> = {
  question: "题级",
  sentence: "句级",
};

/**
 * 结果标签：两套词表**不同义**（CONTEXT.md「判定」），刻意不互相映射——
 * 句级 correct/wrong/skip 与题级 correct/partial/wrong 并列展示。
 */
export const ERROR_BOOK_OUTCOME_LABELS: Record<string, string> = {
  wrong: "错",
  partial: "部分对",
  correct: "对",
  skip: "跳过",
};

/** 一条错题的展示行（含分区与出口）。 */
export interface ErrorBookHubRow {
  key: string;
  kind: L3ErrorBookKind;
  /** 站内回流 URL；null = 本条不可回看（题无来源且无题纸）。 */
  href: string | null;
  /** 不可回看时的原因（诚实提示，不给死按钮）。 */
  hrefMissingReason: string | null;
  item: L3UnifiedErrorBookItem;
}

/** 错题库分区：两腿各自成区，计数来自本页已加载条目。 */
export interface ErrorBookHubSection {
  kind: L3ErrorBookKind;
  label: string;
  rows: ErrorBookHubRow[];
}

export function buildErrorBookHubRow(item: L3UnifiedErrorBookItem): ErrorBookHubRow {
  const key = `${item.kind}:${item.id}`;
  if (item.kind === "sentence") {
    return {
      key,
      kind: "sentence",
      href: buildPracticeHref(item.target_id),
      hrefMissingReason: null,
      item,
    };
  }
  const href = buildQuestionHref(item);
  return {
    key,
    kind: "question",
    href,
    hrefMissingReason: href === null ? "该题既无来源文件也无题纸，暂无法回看原题" : null,
    item,
  };
}

/** 句级回流：只练这一条语境（练习页消费 `context` 参数，零新增端点）。 */
export function buildPracticeHref(contextId: string): string {
  const base = buildL3SectionUrl("practice") as string;
  return `${base}&context=${encodeURIComponent(contextId)}`;
}

/**
 * 题级回流：优先题型空间深链（带 `question` 定位 + `resumeSheet` 回看现场），
 * 其次 F-1 题纸回看深链；都没有 → null。
 * `file` 参数同时匹配 source_id 与 file_key（FilesTab 既有语义），source 型
 * 文件用 sourceId 代入。
 */
export function buildQuestionHref(item: L3UnifiedErrorBookItem): string | null {
  const search = new URLSearchParams();
  if (item.source_id) {
    if (item.question_type) search.set("venue", item.question_type);
    search.set("file", item.source_id);
    search.set("question", item.target_id);
    if (item.sheet_id) search.set("resumeSheet", item.sheet_id);
    return `/l3?${search.toString()}`;
  }
  if (item.sheet_id) return `/l3?sheet=${encodeURIComponent(item.sheet_id)}`;
  return null;
}

/** 分区：题级在前（更接近"刚做完的那套卷"），句级在后。 */
export function buildErrorBookHubSections(items: readonly L3UnifiedErrorBookItem[]): ErrorBookHubSection[] {
  const order: L3ErrorBookKind[] = ["question", "sentence"];
  return order.map((kind) => ({
    kind,
    label: ERROR_BOOK_KIND_LABELS[kind],
    rows: items.filter((item) => item.kind === kind).map(buildErrorBookHubRow),
  }));
}

/** 出口按钮文案（一个概念一个词，见 CONTEXT.md）。 */
export function errorBookRowActionLabel(row: ErrorBookHubRow): string {
  return row.kind === "sentence" ? "再练一次" : "回看原题";
}

/** 来源/来源标题缺失时的兜底文案（不编造来源）。 */
export function errorBookSourceLabel(item: L3UnifiedErrorBookItem): string {
  if (item.source_title) return item.source_title;
  if (item.source_id) return "（来源已删除）";
  return "（无来源）";
}
