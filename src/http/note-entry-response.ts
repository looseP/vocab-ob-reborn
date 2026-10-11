/**
 * Note entry 响应映射助手（0055，2026-10-10 笔记 UX 修复）——独立薄文件。
 *
 * 为什么外迁：`words.ts` 与 `review.ts` 均受**路由复杂度棘轮**按基线冻结
 * （行数不许净增），而 kind 字段要进两处 payload、四处单条映射还要复用
 * （papers-authoring / review-l3-contexts 的「新面另立」先例）。映射收敛到
 * 本文件后，两个路由文件以「一行调用替换九行内联」的方式腾出行数预算。
 *
 * 约定：pg 驱动对 timestamptz 返回 Date 对象（类型标注为 string），
 * `new Date(v)` 两者兼容 —— 与 words.ts 原内联实现的注释同款。
 */
import type { NoteEntryRow } from "../domain";

/** 单词笔记条目 DTO（详情页 `/:slug/notes` 全量含 hidden；单条创建/编辑/隐藏/恢复同形）。 */
export function toNoteEntryDto(row: NoteEntryRow): {
  id: string;
  content_md: string;
  kind: string;
  hidden_at: string | null;
  created_at: string;
  updated_at: string;
} {
  return {
    id: row.id,
    content_md: row.content_md,
    kind: row.kind,
    hidden_at: row.hidden_at ? new Date(row.hidden_at).toISOString() : null,
    created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.updated_at).toISOString(),
  };
}

/** 复习卡附带条目（队列 payload 窄形：id/content_md/kind/created_at）。 */
export function toReviewNoteEntries(rows: NoteEntryRow[]): Array<{
  id: string;
  content_md: string;
  kind: string;
  created_at: string;
}> {
  return rows.map((row) => ({
    id: row.id,
    content_md: row.content_md,
    kind: row.kind,
    created_at: new Date(row.created_at).toISOString(),
  }));
}
