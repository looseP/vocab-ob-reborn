/**
 * L3StudyReferenceService — 引用解析、capture 快照与只读预览（N1，设计 §3/§4）。
 *
 * 合同要点：
 * - capture：**服务端**读取真实目标生成 field_hash 与 display_snapshot（客户端
 *   不得指定出处/hash/快照）；quote 必须严格等于原字段 slice(start,end)
 *   （UTF-16 code unit，不 trim、不归一化、不拆代理对）。
 * - hash 口径：source/source_quote=完整 content_text（NULL 按空字符串）；
 *   stem_quote=stem；option_quote=对应 option.text；question={stem,options}
 *   固定键序 JSON（options 保持题面顺序、显式重建对象保序）。
 * - resolve：已存引用行 → 预览（current/changed/unavailable + liveTitle）；
 *   changed 时保留旧摘录、不按旧 offset 重定位。
 * - preview：只读（独立 actor 事务、零写、不持久化）。
 * - 并发：capture 应运行在调用方（保存流程）已 lockTargets 的事务内——
 *   本 service 不自行取锁，锁序由保存编排统一持有（source FOR SHARE /
 *   question advisory，见 L3StudyReferenceRepository.lockTargets）。
 */

import type { PoolClient } from "pg";
import { createHash } from "node:crypto";
import { NotFoundError, ValidationError } from "../errors";
import { withTransaction } from "../db/transaction";
import {
  validateQuote,
  normalizeStudyUuid,
  STUDY_PAGE_LIMIT_DEFAULT,
  STUDY_PAGE_LIMIT_MAX,
  STUDY_SOURCE_EXCERPT_MAX,
  type ReferenceDisplaySnapshot,
  type ReferencePreview,
  type ReferenceStatus,
  type ReferenceTarget,
  type ReferenceTargetPreview,
  type ReferenceKind,
  type StudyBacklinkItem,
  type StudyNoteStatus,
  type StudyPage,
  type StudyQuestionTargetItem,
  type StudySourceTargetItem,
} from "../domain/l3-study-notes";
import type { L3QuestionType } from "../domain/l3-question-types";
import {
  L3StudyReferenceRepository,
  type IL3StudyReferenceRepository,
  type L3StudyNoteReferenceRow,
  type LoadedQuestionTarget,
  type LoadedTarget,
  type ReferenceTargetKind,
  type StudyReferenceInsertRow,
} from "../repositories/l3-study-references.repository";
import {
  decodeStudyCursor,
  encodeStudyCursor,
  studyFilterFingerprint,
} from "../repositories/l3-study-cursor";

type TxRunner = typeof withTransaction;

/** 本 service 在事务内使用的窄仓库集合。 */
export interface StudyReferenceRepos {
  studyReferences: IL3StudyReferenceRepository;
}

export type StudyReferenceReposFactory = (tx?: PoolClient) => StudyReferenceRepos;

export interface CaptureReferenceInput {
  id: string;
  target: ReferenceTarget;
}

// ── 纯函数（可独立单测）──────────────────────────────────────────────────

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** question 的 hash 字段文本：固定键序 {stem, options}，options 显式重建保序。 */
export function questionFieldText(target: LoadedQuestionTarget): string {
  return JSON.stringify({
    stem: target.stem,
    options: target.options.map((option) => ({ key: option.key, text: option.text })),
  });
}

/** 按引用 kind 取"当前字段文本"（与 capture 的 hash 口径一致）；不可得返回 null。 */
export function currentFieldText(
  kind: ReferenceKind,
  optionKey: string | null,
  target: LoadedTarget,
): string | null {
  if (kind === "source" || kind === "source_quote") {
    return target.kind === "source" ? (target.content_text ?? "") : null;
  }
  if (target.kind !== "question") return null;
  if (kind === "question") return questionFieldText(target);
  if (kind === "stem_quote") return target.stem;
  if (kind === "option_quote") {
    const option = target.options.find((candidate) => candidate.key === optionKey);
    return option ? option.text : null;
  }
  return null;
}

/** 目标"当前标题"（source=标题；question=可读来源标题，可能 null）。 */
function liveTitleOf(target: LoadedTarget): string | null {
  return target.kind === "source" ? target.title : target.source_title;
}

/** 摘要截断不切代理对（前 max 个 UTF-16 code unit）。 */
function safeExcerpt(text: string | null, max: number): string {
  if (!text) return "";
  const cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) return cut.slice(0, -1);
  return cut;
}

/** 分页上限（默认 20、最大 50，设计 §7）。 */
function clampPageLimit(value: number | null | undefined): number {
  if (value == null || Number.isNaN(value)) return STUDY_PAGE_LIMIT_DEFAULT;
  return Math.min(Math.max(Math.trunc(value), 1), STUDY_PAGE_LIMIT_MAX);
}

function assertQuote(field: string, start: number, end: number, quote: string): void {
  if (!validateQuote(field, start, end, quote)) {
    throw new ValidationError("原文已变化，请重新选择引用", "quote");
  }
}

/** 输入 target → ({kind,id}) 的 loadTargets 键（F5：UUID 身份规范小写，与 DB 返回形态一致）。 */
function targetRefOf(target: ReferenceTarget): { kind: "source" | "question"; id: string } {
  if (target.kind === "source" || target.kind === "source_quote") {
    return { kind: "source", id: normalizeStudyUuid(target.sourceId) };
  }
  return { kind: "question", id: normalizeStudyUuid(target.questionId) };
}

/** 引用行 → 重建输入 target（响应与 resolve 用）。 */
export function referenceRowToTarget(row: L3StudyNoteReferenceRow): ReferenceTarget {
  switch (row.kind) {
    case "source":
      return { kind: "source", sourceId: row.source_id! };
    case "source_quote":
      return {
        kind: "source_quote",
        sourceId: row.source_id!,
        start: row.start_offset!,
        end: row.end_offset!,
        quote: row.quote_snapshot!,
      };
    case "question":
      return { kind: "question", questionId: row.question_id! };
    case "stem_quote":
      return {
        kind: "stem_quote",
        questionId: row.question_id!,
        start: row.start_offset!,
        end: row.end_offset!,
        quote: row.quote_snapshot!,
      };
    case "option_quote":
      return {
        kind: "option_quote",
        questionId: row.question_id!,
        optionKey: row.option_key!,
        start: row.start_offset!,
        end: row.end_offset!,
        quote: row.quote_snapshot!,
      };
  }
}

// ── Service ──────────────────────────────────────────────────────────────

export class L3StudyReferenceService {
  constructor(
    private readonly txRunner: TxRunner = withTransaction,
    private readonly reposFactory: StudyReferenceReposFactory = (tx) => ({
      studyReferences: new L3StudyReferenceRepository(tx),
    }),
  ) {}

  /**
   * 读取真实目标并生成一条待保存的引用行（快照/hash 均服务端生成）。
   * 应在已 lockTargets 的保存事务内调用；目标不存在或不可见 → 404，
   * quote 不匹配/选项不存在 → 422。
   */
  async capture(
    userId: string,
    input: CaptureReferenceInput,
    repos: StudyReferenceRepos,
  ): Promise<StudyReferenceInsertRow> {
    const ref = targetRefOf(input.target);
    const loaded = await repos.studyReferences.loadTargets(userId, [ref]);
    const target = loaded.get(`${ref.kind}:${ref.id}`);
    if (!target) {
      throw new NotFoundError("StudyReferenceTarget", `${ref.kind}:${ref.id}`);
    }
    return {
      id: normalizeStudyUuid(input.id),
      ...this.captureAgainst(input.target, target),
      captured_at: new Date().toISOString(),
    };
  }

  /** 对已加载目标构建引用行（id/captured_at 由调用方补；供批量保存复用，避免重复 loadTargets）。 */
  captureAgainst(target: ReferenceTarget, loaded: LoadedTarget): Omit<StudyReferenceInsertRow, "id" | "captured_at"> {
    switch (target.kind) {
      case "source": {
        if (loaded.kind !== "source" || loaded.id !== normalizeStudyUuid(target.sourceId)) {
          throw new NotFoundError("StudyReferenceTarget", `source:${target.sourceId}`);
        }
        return {
          kind: "source",
          source_id: loaded.id,
          question_id: null,
          option_key: null,
          start_offset: null,
          end_offset: null,
          quote_snapshot: null,
          field_hash: sha256Hex(loaded.content_text ?? ""),
          display_snapshot: {
            kind: "source",
            title: loaded.title,
            excerpt: safeExcerpt(loaded.content_text, STUDY_SOURCE_EXCERPT_MAX),
          },
        };
      }
      case "source_quote": {
        if (loaded.kind !== "source" || loaded.id !== normalizeStudyUuid(target.sourceId)) {
          throw new NotFoundError("StudyReferenceTarget", `source:${target.sourceId}`);
        }
        if (loaded.content_text == null) {
          throw new ValidationError("该来源没有可引用的正文", "quote");
        }
        assertQuote(loaded.content_text, target.start, target.end, target.quote);
        return {
          kind: "source_quote",
          source_id: loaded.id,
          question_id: null,
          option_key: null,
          start_offset: target.start,
          end_offset: target.end,
          quote_snapshot: target.quote,
          field_hash: sha256Hex(loaded.content_text),
          display_snapshot: { kind: "source_quote", title: loaded.title, quote: target.quote },
        };
      }
      case "question": {
        if (loaded.kind !== "question" || loaded.id !== normalizeStudyUuid(target.questionId)) {
          throw new NotFoundError("StudyReferenceTarget", `question:${target.questionId}`);
        }
        return {
          kind: "question",
          source_id: null,
          question_id: loaded.id,
          option_key: null,
          start_offset: null,
          end_offset: null,
          quote_snapshot: null,
          field_hash: sha256Hex(questionFieldText(loaded)),
          display_snapshot: {
            kind: "question",
            stem: loaded.stem,
            options: loaded.options.map((option) => ({ key: option.key, text: option.text })),
            questionType: loaded.question_type,
            sourceTitle: loaded.source_title,
          },
        };
      }
      case "stem_quote": {
        if (loaded.kind !== "question" || loaded.id !== normalizeStudyUuid(target.questionId)) {
          throw new NotFoundError("StudyReferenceTarget", `question:${target.questionId}`);
        }
        assertQuote(loaded.stem, target.start, target.end, target.quote);
        return {
          kind: "stem_quote",
          source_id: null,
          question_id: loaded.id,
          option_key: null,
          start_offset: target.start,
          end_offset: target.end,
          quote_snapshot: target.quote,
          field_hash: sha256Hex(loaded.stem),
          display_snapshot: {
            kind: "stem_quote",
            quote: target.quote,
            questionType: loaded.question_type,
            sourceTitle: loaded.source_title,
          },
        };
      }
      case "option_quote": {
        if (loaded.kind !== "question" || loaded.id !== normalizeStudyUuid(target.questionId)) {
          throw new NotFoundError("StudyReferenceTarget", `question:${target.questionId}`);
        }
        const option = loaded.options.find((candidate) => candidate.key === target.optionKey);
        if (!option) {
          throw new ValidationError("选项不存在，请重新选择引用", "optionKey");
        }
        assertQuote(option.text, target.start, target.end, target.quote);
        return {
          kind: "option_quote",
          source_id: null,
          question_id: loaded.id,
          option_key: target.optionKey,
          start_offset: target.start,
          end_offset: target.end,
          quote_snapshot: target.quote,
          field_hash: sha256Hex(option.text),
          display_snapshot: {
            kind: "option_quote",
            optionKey: target.optionKey,
            quote: target.quote,
            questionType: loaded.question_type,
            sourceTitle: loaded.source_title,
          },
        };
      }
    }
  }

  /**
   * 批量解析已存引用行为预览（current/changed/unavailable）。
   * changed 保留旧摘录与旧 offset（不按新文本重定位）。
   */
  async resolve(
    userId: string,
    rows: readonly L3StudyNoteReferenceRow[],
    repos: StudyReferenceRepos,
  ): Promise<ReferencePreview[]> {
    if (rows.length === 0) return [];
    const loaded = await repos.studyReferences.loadTargets(
      userId,
      rows.map((row) =>
        row.kind === "source" || row.kind === "source_quote"
          ? { kind: "source" as const, id: row.source_id! }
          : { kind: "question" as const, id: row.question_id! },
      ),
    );

    return rows.map((row) => {
      const key = row.kind === "source" || row.kind === "source_quote"
        ? `source:${row.source_id}`
        : `question:${row.question_id}`;
      const target = loaded.get(key);
      let status: ReferenceStatus;
      let liveTitle: string | null = null;
      if (!target) {
        status = "unavailable";
      } else {
        liveTitle = liveTitleOf(target);
        const field = currentFieldText(row.kind, row.option_key, target);
        status = field !== null && sha256Hex(field) === row.field_hash ? "current" : "changed";
      }
      return {
        id: row.id,
        target: referenceRowToTarget(row),
        status,
        capturedAt: row.captured_at,
        displaySnapshot: row.display_snapshot as unknown as ReferenceDisplaySnapshot,
        liveTitle,
      };
    });
  }

  /**
   * 只读预览（POST /reference-preview）：独立 actor 事务、零写、不持久化。
   * 目标不存在/不可见 → 404；quote 不匹配/选项不存在 → 422。
   */
  async preview(userId: string, target: ReferenceTarget): Promise<{ preview: ReferenceTargetPreview }> {
    return this.txRunner(
      async (tx) => {
        const repos = this.reposFactory(tx);
        const ref = targetRefOf(target);
        const loaded = await repos.studyReferences.loadTargets(userId, [ref]);
        const loadedTarget = loaded.get(`${ref.kind}:${ref.id}`);
        if (!loadedTarget) {
          throw new NotFoundError("StudyReferenceTarget", `${ref.kind}:${ref.id}`);
        }
        const preview = this.captureAgainst(target, loadedTarget);
        return {
          preview: {
            target,
            displaySnapshot: preview.display_snapshot as unknown as ReferenceDisplaySnapshot,
            liveTitle: liveTitleOf(loadedTarget),
          },
        };
      },
      { actorId: userId },
    );
  }

  /**
   * GET /reference-targets：目标搜索（每次只查一个 kind；摘要不含答案/解析/evidence）。
   * F4：游标为 createdAt 族并携带**过滤指纹**——绑定目标搜索族/kind/规范化 q/
   * 有效 venue（source 忽略无效 venue；limit 不参与指纹）。换 kind/q/有效 venue
   * 复用游标、或使用旧的不绑定条件游标 → 400（设计 §7）。
   */
  async search(
    userId: string,
    query: {
      kind: ReferenceTargetKind;
      q?: string | null;
      venue?: L3QuestionType | null;
      limit?: number | null;
      cursor?: string | null;
    },
  ): Promise<StudyPage<StudySourceTargetItem | StudyQuestionTargetItem>> {
    const limit = clampPageLimit(query.limit);
    // 与 SQL 一致的规范化条件：q 去首尾空白（空白视为无过滤）；venue 仅 question 生效。
    const effectiveQ = query.q?.trim() || null;
    const effectiveVenue = query.kind === "question" ? query.venue ?? null : null;
    const filter = studyFilterFingerprint([
      "reference-targets", query.kind, effectiveQ, effectiveVenue,
    ]);
    const cursor = decodeStudyCursor(query.cursor);
    if (cursor && (cursor.filter !== filter || cursor.sortKind !== "createdAt")) {
      throw new ValidationError("Invalid pagination cursor", "cursor");
    }
    return this.txRunner(
      async (tx) => {
        const repos = this.reposFactory(tx);
        const { items, total } = await repos.studyReferences.searchTargets({
          userId,
          kind: query.kind,
          q: effectiveQ,
          venue: effectiveVenue,
          cursor: cursor ? { createdAt: cursor.lastSort, id: cursor.id } : null,
          limit: limit + 1,
        });
        const hasMore = items.length > limit;
        const pageItems = hasMore ? items.slice(0, limit) : items;
        const mapped = pageItems.map((row) =>
          "stem" in row
            ? {
                id: row.id,
                stem: row.stem,
                questionType: row.question_type,
                createdAt: row.created_at,
              }
            : { id: row.id, title: row.title, createdAt: row.created_at },
        );
        let nextCursor: string | null = null;
        if (hasMore && pageItems.length > 0) {
          const last = pageItems[pageItems.length - 1]!;
          nextCursor = encodeStudyCursor({
            sortKind: "createdAt",
            lastSort: last.created_at,
            id: last.id,
            filter,
          });
        }
        return { items: mapped, total, nextCursor };
      },
      { actorId: userId },
    );
  }

  /**
   * GET /backlinks：反向引用（按 note 去重聚合，默认不含归档）。
   * cursor 绑定 targetKind+targetId 指纹（不能用于另一目标）。
   */
  async backlinks(
    userId: string,
    query: {
      targetKind: ReferenceTargetKind;
      targetId: string;
      limit?: number | null;
      cursor?: string | null;
    },
  ): Promise<StudyPage<StudyBacklinkItem>> {
    const limit = clampPageLimit(query.limit);
    const targetId = normalizeStudyUuid(query.targetId);
    const filter = studyFilterFingerprint([query.targetKind, targetId]);
    const cursor = decodeStudyCursor(query.cursor);
    if (cursor && (cursor.filter !== filter || cursor.sortKind !== "updatedAt")) {
      throw new ValidationError("Invalid pagination cursor", "cursor");
    }
    return this.txRunner(
      async (tx) => {
        const repos = this.reposFactory(tx);
        const { items, total } = await repos.studyReferences.listBacklinks({
          userId,
          targetKind: query.targetKind,
          targetId,
          cursor: cursor ? { updatedAt: cursor.lastSort, id: cursor.id } : null,
          limit: limit + 1,
        });
        const hasMore = items.length > limit;
        const pageItems = hasMore ? items.slice(0, limit) : items;
        const mapped = pageItems.map((row) => ({
          noteId: row.note_id,
          title: row.title,
          status: row.status as StudyNoteStatus,
          referenceCount: row.reference_count,
          refIds: row.ref_ids,
        }));
        let nextCursor: string | null = null;
        if (hasMore && pageItems.length > 0) {
          const last = pageItems[pageItems.length - 1]!;
          nextCursor = encodeStudyCursor({
            sortKind: "updatedAt",
            lastSort: last.updated_at,
            id: last.note_id,
            filter,
          });
        }
        return { items: mapped, total, nextCursor };
      },
      { actorId: userId },
    );
  }
}
