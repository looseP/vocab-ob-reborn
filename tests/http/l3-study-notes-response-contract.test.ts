/**
 * 学习笔记（N1）响应契约测试：设计 §7 形状解析通过 / 越界与内字段泄漏拒绝
 * （fail-closed；`.strict()`）。
 */
import { describe, expect, it } from "vitest";
import {
  l3ReferenceTargetListResponseSchema,
  l3ReferenceTargetPreviewResponseSchema,
  l3StudyBacklinkListResponseSchema,
  l3StudyNoteCreateResponseSchema,
  l3StudyNoteItemResponseSchema,
  l3StudyNoteListResponseSchema,
  l3StudyNoteResponseSchema,
  l3StudyTopicCreateResponseSchema,
  l3StudyTopicItemResponseSchema,
  l3StudyTopicListResponseSchema,
} from "@/http/l3-study-note-response-contract";

const NOTE_ID = "00000000-0000-4000-8000-000000000101";
const TOPIC_ID = "00000000-0000-4000-8000-000000000111";
const REF_ID = "00000000-0000-4000-8000-000000000001";
const SOURCE_ID = "00000000-0000-4000-8000-000000000201";
const QUESTION_ID = "00000000-0000-4000-8000-000000000211";

const sourceQuotePreview = {
  id: REF_ID,
  target: { kind: "source_quote", sourceId: SOURCE_ID, start: 0, end: 3, quote: "The" },
  status: "current",
  capturedAt: "2026-09-19T00:00:00.000Z",
  displaySnapshot: { kind: "source_quote", title: "来源", quote: "The" },
  liveTitle: "来源",
};

const noteSummary = {
  id: NOTE_ID, title: "标题", venues: ["reading_choice"], pinned: false, status: "active",
  version: 1, createdAt: "2026-09-19T00:00:00.000Z", updatedAt: "2026-09-19T00:00:00.000Z",
};

const noteDetail = { ...noteSummary, bodyMd: "正文", references: [sourceQuotePreview] };

const topic = {
  id: TOPIC_ID, questionType: "reading_choice", title: "专题", status: "active",
  version: 1, memberCount: 0, createdAt: "2026-09-19T00:00:00.000Z", updatedAt: "2026-09-19T00:00:00.000Z",
};

describe("笔记响应形状（解析通过）", () => {
  it("详情/创建/条目/列表 全形状通过", () => {
    expect(l3StudyNoteResponseSchema.safeParse(noteDetail).success).toBe(true);
    expect(l3StudyNoteCreateResponseSchema.safeParse({ item: noteDetail, created: true }).success).toBe(true);
    expect(l3StudyNoteCreateResponseSchema.safeParse({ item: noteDetail, created: false }).success).toBe(true);
    expect(l3StudyNoteItemResponseSchema.safeParse({ item: noteDetail }).success).toBe(true);
    expect(l3StudyNoteListResponseSchema.safeParse({ items: [noteSummary], total: 1, nextCursor: null }).success).toBe(true);
    expect(l3StudyNoteListResponseSchema.safeParse({ items: [], total: 0, nextCursor: "abc" }).success).toBe(true);
  });

  it("引用预览五种 kind 的快照形态均可解析", () => {
    const samples = [
      {
        id: REF_ID, target: { kind: "source", sourceId: SOURCE_ID }, status: "changed",
        capturedAt: "2026-09-19T00:00:00.000Z",
        displaySnapshot: { kind: "source", title: "T", excerpt: "E" }, liveTitle: "T2",
      },
      sourceQuotePreview,
      {
        id: REF_ID, target: { kind: "question", questionId: QUESTION_ID }, status: "unavailable",
        capturedAt: "2026-09-19T00:00:00.000Z",
        displaySnapshot: {
          kind: "question", stem: "Q?", options: [{ key: "A", text: "a" }],
          questionType: "reading_choice", sourceTitle: null,
        },
        liveTitle: null,
      },
      {
        id: REF_ID, target: { kind: "stem_quote", questionId: QUESTION_ID, start: 0, end: 4, quote: "What" },
        status: "current", capturedAt: "2026-09-19T00:00:00.000Z",
        displaySnapshot: { kind: "stem_quote", quote: "What", questionType: "reading_choice", sourceTitle: "S" },
        liveTitle: "S",
      },
      {
        id: REF_ID, target: { kind: "option_quote", questionId: QUESTION_ID, optionKey: "A", start: 0, end: 2, quote: "ab" },
        status: "current", capturedAt: "2026-09-19T00:00:00.000Z",
        displaySnapshot: { kind: "option_quote", optionKey: "A", quote: "ab", questionType: "reading_choice", sourceTitle: null },
        liveTitle: null,
      },
    ];
    for (const sample of samples) {
      const result = l3StudyNoteResponseSchema.safeParse({ ...noteDetail, references: [sample] });
      expect(result.success, JSON.stringify(result.error?.issues ?? [])).toBe(true);
    }
  });
});

describe("越界与内字段拒绝（fail-closed）", () => {
  it("笔记响应不得泄漏 userId / create_request_id / hash 等内部字段（strict）", () => {
    expect(l3StudyNoteResponseSchema.safeParse({ ...noteDetail, userId: SOURCE_ID }).success).toBe(false);
    expect(l3StudyNoteResponseSchema.safeParse({ ...noteDetail, createRequestId: REF_ID }).success).toBe(false);
    expect(l3StudyNoteResponseSchema.safeParse({ ...noteDetail, lastWriteHash: "a".repeat(64) }).success).toBe(false);
  });

  it("引用预览：status/kind 枚举外拒绝；capturedAt 必须存在", () => {
    expect(l3StudyNoteResponseSchema.safeParse({
      ...noteDetail, references: [{ ...sourceQuotePreview, status: "stale" }],
    }).success).toBe(false);
    expect(l3StudyNoteResponseSchema.safeParse({
      ...noteDetail, references: [{ ...sourceQuotePreview, target: { kind: "unknown" } }],
    }).success).toBe(false);
    const { capturedAt: _drop, ...withoutCapturedAt } = sourceQuotePreview;
    void _drop;
    expect(l3StudyNoteResponseSchema.safeParse({
      ...noteDetail, references: [withoutCapturedAt],
    }).success).toBe(false);
  });

  it("note venues 只能为七题型；version 必须正整数", () => {
    expect(l3StudyNoteListResponseSchema.safeParse({
      items: [{ ...noteSummary, venues: ["not_a_venue"] }], total: 1, nextCursor: null,
    }).success).toBe(false);
    expect(l3StudyNoteListResponseSchema.safeParse({
      items: [{ ...noteSummary, version: 0 }], total: 1, nextCursor: null,
    }).success).toBe(false);
  });

  it("专题：memberCount 非负；title 非空", () => {
    expect(l3StudyTopicListResponseSchema.safeParse({
      items: [{ ...topic, memberCount: -1 }], total: 1, nextCursor: null,
    }).success).toBe(false);
    expect(l3StudyTopicCreateResponseSchema.safeParse({
      item: { ...topic, title: "" }, created: true,
    }).success).toBe(false);
    expect(l3StudyTopicItemResponseSchema.safeParse({ item: topic }).success).toBe(true);
  });

  it("目标列表：item 必须为 source 或 question 摘要制式", () => {
    expect(l3ReferenceTargetListResponseSchema.safeParse({
      items: [{ id: SOURCE_ID, title: "T", createdAt: "2026-09-19T00:00:00.000Z" }],
      total: 1, nextCursor: null,
    }).success).toBe(true);
    expect(l3ReferenceTargetListResponseSchema.safeParse({
      items: [{ id: QUESTION_ID, stem: "Q", questionType: "reading_choice", createdAt: "2026-09-19T00:00:00.000Z" }],
      total: 1, nextCursor: null,
    }).success).toBe(true);
    // 摘要混入 answer → 拒绝
    expect(l3ReferenceTargetListResponseSchema.safeParse({
      items: [{ id: QUESTION_ID, stem: "Q", questionType: "reading_choice", createdAt: "x", answer: { choice: "A" } }],
      total: 1, nextCursor: null,
    }).success).toBe(false);
  });

  it("preview 响应必须包在 {preview}；backlinks refIds 必须为 uuid", () => {
    expect(l3ReferenceTargetPreviewResponseSchema.safeParse({
      preview: {
        target: { kind: "source", sourceId: SOURCE_ID },
        displaySnapshot: { kind: "source", title: "T", excerpt: "E" },
        liveTitle: "T",
      },
    }).success).toBe(true);
    expect(l3ReferenceTargetPreviewResponseSchema.safeParse({
      target: { kind: "source", sourceId: SOURCE_ID },
      displaySnapshot: { kind: "source", title: "T", excerpt: "E" },
      liveTitle: "T",
    }).success).toBe(false);

    expect(l3StudyBacklinkListResponseSchema.safeParse({
      items: [{ noteId: NOTE_ID, title: "T", status: "active", referenceCount: 1, refIds: [REF_ID] }],
      total: 1, nextCursor: null,
    }).success).toBe(true);
    expect(l3StudyBacklinkListResponseSchema.safeParse({
      items: [{ noteId: NOTE_ID, title: "T", status: "active", referenceCount: 1, refIds: ["not-uuid"] }],
      total: 1, nextCursor: null,
    }).success).toBe(false);
  });
});
