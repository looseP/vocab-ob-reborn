/**
 * L3StudyNoteService — 笔记与专题的原子编排（N1，设计 §6/§7）。
 *
 * 保存一致性（设计 §6 顺序）：
 *   锁 note → 最后一次请求幂等（同 requestId 同规范化 hash 返回当前、异 hash 409）
 *   → CAS 版本比对（409 只返回 currentVersion）→ 归属/专题 blocker 校验 →
 *   marker 集合一致性（422）→ 引用处理（keep 保留原摘录 / capture 服务端快照；
 *   被其他笔记使用的引用 id 409；快照总量 ≤2MiB）→ 正文 CAS + 归属替换 +
 *   引用整组替换（同一事务，失败整体回滚）。
 *
 * 「最后一次请求幂等」为准确语义：旧 requestId 已被新写入覆盖时按版本冲突处理，
 * 不宣称全历史去重。GET/预览/搜索/反向引用零写。
 *
 * 锁序：专题成员操作 topic → note；笔记保存锁 note 后锁引用目标
 * （source FOR SHARE / question advisory），不反向取 topic 锁。
 */

import type { PoolClient } from "pg";
import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import { ConflictError, NotFoundError, ValidationError, isForeignKeyViolation, isUniqueViolation } from "../errors";
import { withTransaction } from "../db/transaction";
import { L3_QUESTION_TYPES, type L3QuestionType } from "../domain/l3-question-types";
import {
  assertReferenceSet,
  ReferenceContractError,
  normalizeStudyUuid,
  STUDY_PAGE_LIMIT_DEFAULT,
  STUDY_PAGE_LIMIT_MAX,
  STUDY_SNAPSHOT_BYTES_MAX,
  STUDY_TOPIC_MEMBER_MAX,
  type ReferenceTarget,
  type ReferenceWrite,
  type SaveNoteInput,
  type StudyNoteDto,
  type StudyNoteStatus,
  type StudyNoteSummary,
  type StudyPage,
  type StudyTopicDto,
  type StudyTopicStatus,
} from "../domain/l3-study-notes";
import {
  L3StudyNoteRepository,
  type IL3StudyNoteRepository,
  type L3StudyNoteListRow,
  type L3StudyNoteRow,
} from "../repositories/l3-study-notes.repository";
import {
  L3StudyTopicRepository,
  type IL3StudyTopicRepository,
  type L3StudyTopicRow,
} from "../repositories/l3-study-topics.repository";
import {
  L3StudyReferenceRepository,
  type IL3StudyReferenceRepository,
  type LoadedTarget,
  type StudyReferenceInsertRow,
} from "../repositories/l3-study-references.repository";
import {
  decodeStudyCursor,
  encodeStudyCursor,
  studyFilterFingerprint,
} from "../repositories/l3-study-cursor";
import { L3StudyReferenceService } from "./l3-study-reference.service";

type TxRunner = typeof withTransaction;

/** 本 service 在事务内使用的窄仓库集合。 */
export interface StudyNoteRepos {
  studyNotes: IL3StudyNoteRepository;
  studyTopics: IL3StudyTopicRepository;
  studyReferences: IL3StudyReferenceRepository;
}

export type StudyNoteReposFactory = (tx?: PoolClient) => StudyNoteRepos;

const DEFAULT_REPOS_FACTORY: StudyNoteReposFactory = (tx) => ({
  studyNotes: new L3StudyNoteRepository(tx),
  studyTopics: new L3StudyTopicRepository(tx),
  studyReferences: new L3StudyReferenceRepository(tx),
});

// ── 纯函数（规范化 hash / 展示序 / 限额）───────────────────────────────────

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function clampLimit(value: number | null | undefined): number {
  if (value == null || Number.isNaN(value)) return STUDY_PAGE_LIMIT_DEFAULT;
  return Math.min(Math.max(Math.trunc(value), 1), STUDY_PAGE_LIMIT_MAX);
}

/** 展示序：按题型枚举固定顺序（集合语义不变，仅确定性展示）。 */
function orderVenues(venues: readonly L3QuestionType[]): L3QuestionType[] {
  return [...venues].sort(
    (a, b) => L3_QUESTION_TYPES.indexOf(a) - L3_QUESTION_TYPES.indexOf(b),
  );
}

/** 目标对象的固定键序规范化（hash 用；UUID 归一为小写）。 */
export function canonicalTarget(target: ReferenceTarget): Record<string, unknown> {
  switch (target.kind) {
    case "source":
      return { kind: "source", sourceId: target.sourceId.toLowerCase() };
    case "source_quote":
      return {
        kind: "source_quote",
        sourceId: target.sourceId.toLowerCase(),
        start: target.start,
        end: target.end,
        quote: target.quote,
      };
    case "question":
      return { kind: "question", questionId: target.questionId.toLowerCase() };
    case "stem_quote":
      return {
        kind: "stem_quote",
        questionId: target.questionId.toLowerCase(),
        start: target.start,
        end: target.end,
        quote: target.quote,
      };
    case "option_quote":
      return {
        kind: "option_quote",
        questionId: target.questionId.toLowerCase(),
        optionKey: target.optionKey,
        start: target.start,
        end: target.end,
        quote: target.quote,
      };
  }
}

function canonicalReferenceWrite(write: ReferenceWrite): Record<string, unknown> {
  if (write.action === "keep") {
    return { id: write.id.toLowerCase(), action: "keep" };
  }
  return { id: write.id.toLowerCase(), action: "capture", target: canonicalTarget(write.target) };
}

/** 保存请求的规范化 hash（固定键序；含引用动作与期望版本；不含 requestId 本身）。 */
export function computeSaveRequestHash(input: SaveNoteInput): string {
  return sha256Hex(JSON.stringify({
    expectedVersion: input.expectedVersion,
    title: input.title,
    bodyMd: input.bodyMd,
    venues: [...input.venues],
    pinned: input.pinned,
    status: input.status,
    references: input.references.map(canonicalReferenceWrite),
  }));
}

export function computeNoteCreateHash(venue: L3QuestionType): string {
  return sha256Hex(JSON.stringify({ venue }));
}

export function computeTopicCreateHash(venue: L3QuestionType, title: string): string {
  return sha256Hex(JSON.stringify({ venue, title }));
}

export function computeTopicSaveHash(input: {
  expectedVersion: number;
  title: string;
  status: StudyTopicStatus;
}): string {
  return sha256Hex(JSON.stringify({
    expectedVersion: input.expectedVersion,
    title: input.title,
    status: input.status,
  }));
}

export function computeMemberOpHash(input: {
  op: "move" | "remove";
  expectedVersion: number;
  noteId: string;
  beforeNoteId: string | null;
}): string {
  return sha256Hex(JSON.stringify({
    op: input.op,
    expectedVersion: input.expectedVersion,
    noteId: input.noteId.toLowerCase(),
    beforeNoteId: input.beforeNoteId === null ? null : input.beforeNoteId.toLowerCase(),
  }));
}

/** 目标引用 → loadTargets 键（F5：UUID 身份规范小写，与仓储返回的 DB 形态一致）。 */
function targetKey(target: ReferenceTarget): { kind: "source" | "question"; id: string } {
  if (target.kind === "source" || target.kind === "source_quote") {
    return { kind: "source", id: normalizeStudyUuid(target.sourceId) };
  }
  return { kind: "question", id: normalizeStudyUuid(target.questionId) };
}

// ── Service ──────────────────────────────────────────────────────────────

export interface StudyNoteListQuery {
  venue: L3QuestionType;
  q?: string | null;
  status?: StudyNoteStatus | null;
  pinned?: boolean | null;
  topicId?: string | null;
  unfiled?: boolean;
  limit?: number | null;
  cursor?: string | null;
}

export interface StudyTopicListQuery {
  venue: L3QuestionType;
  status?: StudyTopicStatus | null;
  limit?: number | null;
  cursor?: string | null;
}

export class L3StudyNoteService {
  constructor(
    private readonly txRunner: TxRunner = withTransaction,
    private readonly reposFactory: StudyNoteReposFactory = DEFAULT_REPOS_FACTORY,
    private readonly referenceService: L3StudyReferenceService = new L3StudyReferenceService(),
  ) {}

  private withActor<T>(userId: string, callback: (repos: StudyNoteRepos) => Promise<T>): Promise<T> {
    return this.txRunner(async (tx) => callback(this.reposFactory(tx)), { actorId: userId });
  }

  // ── 笔记 ────────────────────────────────────────────────────────────────

  /** POST /：幂等创建（同 requestId 同输入返回当前；异输入 409）；从零可建（无任何依赖）。 */
  async create(
    userId: string,
    input: { requestId: string; venue: L3QuestionType },
  ): Promise<{ item: StudyNoteDto; created: boolean }> {
    const requestId = normalizeStudyUuid(input.requestId);
    const createHash = computeNoteCreateHash(input.venue);
    return this.withActor(userId, async (repos) => {
      const existing = await repos.studyNotes.findByCreateRequestId(userId, requestId);
      if (existing) {
        if (existing.create_input_hash !== createHash) {
          throw new ConflictError("Idempotency conflict: same requestId with different input", undefined, {
            entityType: "studyNote",
          });
        }
        return { item: await this.buildNoteDto(userId, existing, repos), created: false };
      }

      let row: L3StudyNoteRow;
      try {
        row = await repos.studyNotes.create({
          id: randomUUID(),
          user_id: userId,
          title: "",
          body_md: "",
          status: "active",
          pinned: false,
          version: 1,
          create_request_id: requestId,
          create_input_hash: createHash,
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          // 并发竞态回读（l3-import 同款范式）：同 requestId 已被并行创建。
          const raced = await repos.studyNotes.findByCreateRequestId(userId, requestId);
          if (raced && raced.create_input_hash === createHash) {
            return { item: await this.buildNoteDto(userId, raced, repos), created: false };
          }
          throw new ConflictError("Idempotency conflict: same requestId with different input", undefined, {
            entityType: "studyNote",
          });
        }
        throw error;
      }
      await repos.studyNotes.replaceVenues(userId, row.id, [input.venue]);
      return { item: await this.buildNoteDto(userId, row, repos), created: true };
    });
  }

  /** GET /：venue 必填的 keyset 分页（cursor 绑定过滤指纹，跨过滤复用 400）。 */
  async list(userId: string, query: StudyNoteListQuery): Promise<StudyPage<StudyNoteSummary>> {
    const limit = clampLimit(query.limit);
    const topicId = query.topicId ? normalizeStudyUuid(query.topicId) : null;
    const unfiled = Boolean(query.unfiled) && topicId === null;
    const filter = studyFilterFingerprint([
      query.venue,
      query.status ?? null,
      query.pinned ?? null,
      topicId,
      unfiled,
      query.q?.trim() ?? null,
    ]);
    const cursor = decodeStudyCursor(query.cursor);
    if (cursor) {
      if (cursor.filter !== filter) {
        throw new ValidationError("Invalid pagination cursor", "cursor");
      }
      const expectedSort = topicId ? "position" : "updatedAt";
      if (cursor.sortKind !== expectedSort) {
        throw new ValidationError("Invalid pagination cursor", "cursor");
      }
    }

    return this.withActor(userId, async (repos) => {
      const { items, total } = await repos.studyNotes.list({
        userId,
        venue: query.venue,
        q: query.q ?? null,
        status: query.status ?? null,
        pinned: query.pinned ?? null,
        topicId,
        unfiled,
        cursor,
        limit: limit + 1,
      });
      const hasMore = items.length > limit;
      const pageItems = hasMore ? items.slice(0, limit) : items;
      const venueMap = await repos.studyNotes.listVenuesForNotes(
        userId,
        pageItems.map((row) => row.id),
      );
      const dtos = pageItems.map((row) =>
        this.toNoteSummary(row, venueMap.get(row.id) ?? []),
      );
      let nextCursor: string | null = null;
      if (hasMore && pageItems.length > 0) {
        const last = pageItems[pageItems.length - 1]!;
        nextCursor = topicId
          ? encodeStudyCursor({
              sortKind: "position",
              lastSort: String(last.position ?? 0),
              id: last.id,
              filter,
            })
          : encodeStudyCursor({
              sortKind: "updatedAt",
              lastSort: last.updated_at,
              id: last.id,
              filter,
            });
      }
      return { items: dtos, total, nextCursor };
    });
  }

  /** GET /:noteId：详情（含正文、归属、引用预览）。 */
  async get(userId: string, noteId: string): Promise<{ item: StudyNoteDto }> {
    const id = normalizeStudyUuid(noteId);
    return this.withActor(userId, async (repos) => {
      const note = await repos.studyNotes.get(userId, id);
      if (!note) throw new NotFoundError("StudyNote", noteId);
      return { item: await this.buildNoteDto(userId, note, repos) };
    });
  }

  /** PUT /:noteId：完整状态保存（原子；失败整体回滚）。 */
  async save(userId: string, noteId: string, input: SaveNoteInput): Promise<{ item: StudyNoteDto }> {
    const requestHash = computeSaveRequestHash(input);
    const id = normalizeStudyUuid(noteId);
    return this.withActor(userId, async (repos) => {
      const note = await repos.studyNotes.lock(userId, id);
      if (!note) throw new NotFoundError("StudyNote", noteId);

      // 1) 最后一次请求幂等：同 requestId 同规范化 hash → 返回当前结果（不二次推进版本）。
      if (note.last_write_request_id === input.requestId.toLowerCase()) {
        if (note.last_write_hash === requestHash) {
          return { item: await this.buildNoteDto(userId, note, repos) };
        }
        throw new ConflictError(
          "Idempotency conflict: same requestId with different payload",
          undefined,
          { noteId: id },
        );
      }

      // 2) 版本合同：冲突只返回 currentVersion，不自动返回内容。
      if (note.version !== input.expectedVersion) {
        throw new ConflictError("Study note version conflict", undefined, {
          noteId: id,
          currentVersion: note.version,
        });
      }

      // 3) 归属：被移除的题型若仍属于该题型专题 → 409（含归档专题；先移出专题）。
      const currentVenues = await repos.studyNotes.listVenues(userId, id);
      const nextVenues = orderVenues([...new Set(input.venues)]);
      const removedVenues = currentVenues.filter((venue) => !nextVenues.includes(venue));
      if (removedVenues.length > 0) {
        const topicBlockers = await repos.studyNotes.listTopicBlockers(userId, id, removedVenues);
        if (topicBlockers.length > 0) {
          throw new ConflictError(
            "The note still belongs to topics of the removed venue",
            undefined,
            {
              noteId: id,
              blockers: {
                topics: topicBlockers.map((topic) => ({
                  id: topic.topic_id,
                  title: topic.title,
                  status: topic.status,
                })),
              },
            },
          );
        }
      }

      // 4) marker 集合一致性（缺失/多余/重复/未知标记 → 422）。
      try {
        assertReferenceSet(input.bodyMd, input.references);
      } catch (error) {
        if (error instanceof ReferenceContractError) {
          throw new ValidationError(error.message, "bodyMd");
        }
        throw error;
      }

      // 5) 引用处理（keep 保留原摘录与时间；capture 服务端快照）。
      const referenceRows = await this.prepareReferences(userId, id, input.references, repos);

      // 6) 正文/元数据 CAS（行已锁，失败为理论兜底）。
      const updated = await repos.studyNotes.updateIfVersion(userId, id, input.expectedVersion, {
        title: input.title,
        body_md: input.bodyMd,
        status: input.status,
        pinned: input.pinned,
        last_write_request_id: input.requestId.toLowerCase(),
        last_write_hash: requestHash,
      });
      if (!updated) {
        throw new ConflictError("Study note version conflict", undefined, { noteId: id });
      }

      // 7) 归属与引用替换（同事务；整体回滚保障正文/归属/引用一致）。
      await repos.studyNotes.replaceVenues(userId, id, nextVenues);
      try {
        await repos.studyReferences.replaceForNote(userId, id, referenceRows);
      } catch (error) {
        // 并发兜底：keep/目标被数据库直删等 FK 异常 → 可读 409，不落 500。
        if (isForeignKeyViolation(error)) {
          throw new ConflictError("Referenced material is no longer available", undefined, { noteId: id });
        }
        throw error;
      }

      return { item: await this.buildNoteDto(userId, updated, repos) };
    });
  }

  // ── 专题 ────────────────────────────────────────────────────────────────

  async createTopic(
    userId: string,
    input: { requestId: string; venue: L3QuestionType; title: string },
  ): Promise<{ item: StudyTopicDto; created: boolean }> {
    const requestId = normalizeStudyUuid(input.requestId);
    const createHash = computeTopicCreateHash(input.venue, input.title);
    return this.withActor(userId, async (repos) => {
      const existing = await repos.studyTopics.findByCreateRequestId(userId, requestId);
      if (existing) {
        if (existing.create_input_hash !== createHash) {
          throw new ConflictError("Idempotency conflict: same requestId with different input", undefined, {
            entityType: "studyTopic",
          });
        }
        return { item: await this.buildTopicDto(userId, existing, repos), created: false };
      }
      let row: L3StudyTopicRow;
      try {
        row = await repos.studyTopics.create({
          id: randomUUID(),
          user_id: userId,
          question_type: input.venue,
          title: input.title,
          status: "active",
          version: 1,
          create_request_id: requestId,
          create_input_hash: createHash,
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          const raced = await repos.studyTopics.findByCreateRequestId(userId, requestId);
          if (raced && raced.create_input_hash === createHash) {
            return { item: await this.buildTopicDto(userId, raced, repos), created: false };
          }
          throw new ConflictError("Idempotency conflict: same requestId with different input", undefined, {
            entityType: "studyTopic",
          });
        }
        throw error;
      }
      return { item: await this.buildTopicDto(userId, row, repos), created: true };
    });
  }

  async listTopics(userId: string, query: StudyTopicListQuery): Promise<StudyPage<StudyTopicDto>> {
    const limit = clampLimit(query.limit);
    const filter = studyFilterFingerprint([query.venue, query.status ?? null]);
    const cursor = decodeStudyCursor(query.cursor);
    if (cursor) {
      if (cursor.filter !== filter || cursor.sortKind !== "updatedAt") {
        throw new ValidationError("Invalid pagination cursor", "cursor");
      }
    }
    return this.withActor(userId, async (repos) => {
      const { items, total } = await repos.studyTopics.list({
        userId,
        questionType: query.venue,
        status: query.status ?? null,
        cursor: cursor ? { updatedAt: cursor.lastSort, id: cursor.id } : null,
        limit: limit + 1,
      });
      const hasMore = items.length > limit;
      const pageItems = hasMore ? items.slice(0, limit) : items;
      const countMap = await repos.studyTopics.countMembersForTopics(
        userId,
        pageItems.map((row) => row.id),
      );
      const dtos = pageItems.map((row) => this.toTopicDto(row, countMap.get(row.id) ?? 0));
      let nextCursor: string | null = null;
      if (hasMore && pageItems.length > 0) {
        const last = pageItems[pageItems.length - 1]!;
        nextCursor = encodeStudyCursor({
          sortKind: "updatedAt",
          lastSort: last.updated_at,
          id: last.id,
          filter,
        });
      }
      return { items: dtos, total, nextCursor };
    });
  }

  /** PUT /:topicId：元数据保存（title/status 共享版本；归档恢复同路径）。 */
  async saveTopic(
    userId: string,
    topicId: string,
    input: { requestId: string; expectedVersion: number; title: string; status: StudyTopicStatus },
  ): Promise<{ item: StudyTopicDto }> {
    const requestHash = computeTopicSaveHash(input);
    const id = normalizeStudyUuid(topicId);
    return this.withActor(userId, async (repos) => {
      const topic = await repos.studyTopics.lock(userId, id);
      if (!topic) throw new NotFoundError("StudyTopic", topicId);
      if (topic.last_write_request_id === input.requestId.toLowerCase()) {
        if (topic.last_write_hash === requestHash) {
          return { item: await this.buildTopicDto(userId, topic, repos) };
        }
        throw new ConflictError("Idempotency conflict: same requestId with different payload", undefined, {
          topicId,
        });
      }
      if (topic.version !== input.expectedVersion) {
        throw new ConflictError("Study topic version conflict", undefined, {
          topicId,
          currentVersion: topic.version,
        });
      }
      const updated = await repos.studyTopics.updateIfVersion(userId, id, input.expectedVersion, {
        title: input.title,
        status: input.status,
        last_write_request_id: input.requestId.toLowerCase(),
        last_write_hash: requestHash,
      });
      if (!updated) {
        throw new ConflictError("Study topic version conflict", undefined, { topicId });
      }
      return { item: await this.buildTopicDto(userId, updated, repos) };
    });
  }

  /**
   * PUT /:topicId/members/:noteId —— 加入或移动（beforeNoteId=null 移到末尾）。
   * 失败：beforeNoteId 非本专题另一成员 422；跨题型未归属 409；归档 topic 409；
   * 成员上限 422。加入/移动/移除共享 topic 版本与 last_request 幂等字段。
   */
  async moveTopicMember(
    userId: string,
    topicId: string,
    noteId: string,
    input: { requestId: string; expectedVersion: number; beforeNoteId: string | null },
  ): Promise<{ item: StudyTopicDto }> {
    // F5：身份规范化（同一 UUID 的大小写表示同一对象；锁/比较/成员键/幂等键同用规范值）
    const id = normalizeStudyUuid(topicId);
    const memberNoteId = normalizeStudyUuid(noteId);
    const beforeNoteId = input.beforeNoteId === null ? null : normalizeStudyUuid(input.beforeNoteId);
    const opHash = computeMemberOpHash({
      op: "move",
      expectedVersion: input.expectedVersion,
      noteId: memberNoteId,
      beforeNoteId,
    });
    return this.withActor(userId, async (repos) => {
      const topic = await repos.studyTopics.lock(userId, id);
      if (!topic) throw new NotFoundError("StudyTopic", topicId);

      if (topic.last_write_request_id === input.requestId.toLowerCase()) {
        if (topic.last_write_hash === opHash) {
          return { item: await this.buildTopicDto(userId, topic, repos) };
        }
        throw new ConflictError("Idempotency conflict: same requestId with different payload", undefined, {
          topicId,
        });
      }
      if (topic.version !== input.expectedVersion) {
        throw new ConflictError("Study topic version conflict", undefined, {
          topicId,
          currentVersion: topic.version,
        });
      }
      if (topic.status !== "active") {
        throw new ConflictError("Archived topics cannot change members; restore it first", undefined, {
          topicId,
        });
      }

      // 锁序 topic → note（设计防竞态）：与 note save 的「锁 note 后读成员」互斥，
      // 避免「移除归属 vs 加入专题」两边均成功破坏 成员 ⊆ 题型归属 不变量。
      const note = await repos.studyNotes.lock(userId, memberNoteId);
      if (!note) {
        throw new NotFoundError("StudyNote", noteId);
      }
      const noteVenues = await repos.studyNotes.listVenues(userId, memberNoteId);
      if (!noteVenues.includes(topic.question_type)) {
        throw new ConflictError(
          "The note does not belong to the topic's question type",
          undefined,
          { topicId, noteId, requiredVenue: topic.question_type },
        );
      }

      const members = await repos.studyTopics.listMembers(userId, id);
      const isMember = members.some((member) => member.note_id === memberNoteId);
      if (!isMember && members.length >= STUDY_TOPIC_MEMBER_MAX) {
        throw new ValidationError(`专题成员已达上限（${STUDY_TOPIC_MEMBER_MAX}）`, "noteId");
      }
      if (beforeNoteId !== null) {
        const isValid = members.some(
          (member) => member.note_id === beforeNoteId && member.note_id !== memberNoteId,
        );
        if (!isValid) {
          throw new ValidationError("beforeNoteId must be another member of the same topic", "beforeNoteId");
        }
      }

      const orderedIds = members.map((member) => member.note_id).filter((memberId) => memberId !== memberNoteId);
      if (beforeNoteId === null) {
        orderedIds.push(memberNoteId);
      } else {
        const index = orderedIds.indexOf(beforeNoteId);
        orderedIds.splice(index, 0, memberNoteId);
      }

      if (!isMember) {
        await repos.studyTopics.insertMember({
          topicId: id,
          noteId: memberNoteId,
          userId,
          position: orderedIds.length - 1,
        });
      }
      await repos.studyTopics.replaceMemberPositions(userId, id, orderedIds);
      const updated = await repos.studyTopics.bumpVersion(
        userId,
        id,
        topic.version,
        input.requestId.toLowerCase(),
        opHash,
      );
      if (!updated) {
        throw new ConflictError("Study topic version conflict", undefined, { topicId });
      }
      return { item: await this.buildTopicDto(userId, updated, repos) };
    });
  }

  /**
   * DELETE /:topicId/members/:noteId —— 移出成员。
   * 成员不存在时：相同 requestId 重试返回当前 topic；新请求按空操作成功且版本递增。
   */
  async removeTopicMember(
    userId: string,
    topicId: string,
    noteId: string,
    input: { requestId: string; expectedVersion: number },
  ): Promise<{ item: StudyTopicDto }> {
    // F5：身份规范化（与 moveTopicMember 同口径）
    const id = normalizeStudyUuid(topicId);
    const memberNoteId = normalizeStudyUuid(noteId);
    const opHash = computeMemberOpHash({
      op: "remove",
      expectedVersion: input.expectedVersion,
      noteId: memberNoteId,
      beforeNoteId: null,
    });
    return this.withActor(userId, async (repos) => {
      const topic = await repos.studyTopics.lock(userId, id);
      if (!topic) throw new NotFoundError("StudyTopic", topicId);

      if (topic.last_write_request_id === input.requestId.toLowerCase()) {
        if (topic.last_write_hash === opHash) {
          return { item: await this.buildTopicDto(userId, topic, repos) };
        }
        throw new ConflictError("Idempotency conflict: same requestId with different payload", undefined, {
          topicId,
        });
      }
      if (topic.version !== input.expectedVersion) {
        throw new ConflictError("Study topic version conflict", undefined, {
          topicId,
          currentVersion: topic.version,
        });
      }
      if (topic.status !== "active") {
        throw new ConflictError("Archived topics cannot change members; restore it first", undefined, {
          topicId,
        });
      }

      const deleted = await repos.studyTopics.deleteMember(userId, id, memberNoteId);
      if (deleted) {
        const remaining = await repos.studyTopics.listMembers(userId, id);
        await repos.studyTopics.replaceMemberPositions(
          userId,
          id,
          remaining.map((member) => member.note_id),
        );
      }
      const updated = await repos.studyTopics.bumpVersion(
        userId,
        id,
        topic.version,
        input.requestId.toLowerCase(),
        opHash,
      );
      if (!updated) {
        throw new ConflictError("Study topic version conflict", undefined, { topicId });
      }
      return { item: await this.buildTopicDto(userId, updated, repos) };
    });
  }

  // ── 内部 ────────────────────────────────────────────────────────────────

  /**
   * 引用写入集处理：
   * - keep 必须已属于当前笔记（保留原摘录/时间，不重读目标）；被其他笔记使用 409；
   * - capture：被其他笔记使用 409；目标 lockTargets + loadTargets 后服务端生成快照；
   * - 快照序列化总量 ≤2MiB。
   */
  private async prepareReferences(
    userId: string,
    noteId: string,
    writes: readonly ReferenceWrite[],
    repos: StudyNoteRepos,
  ): Promise<StudyReferenceInsertRow[]> {
    if (writes.length === 0) return [];

    const owners = await repos.studyReferences.findReferenceOwners(
      userId,
      writes.map((write) => write.id.toLowerCase()),
    );
    const existingRows = await repos.studyReferences.listForNote(userId, noteId);
    const existingById = new Map(existingRows.map((row) => [row.id.toLowerCase(), row]));

    for (const write of writes) {
      const id = write.id.toLowerCase();
      const owner = owners.get(id);
      if (owner !== undefined && owner !== noteId) {
        throw new ConflictError("Reference id already used by another note", undefined, {
          referenceId: id,
        });
      }
      if (write.action === "keep" && !existingById.has(id)) {
        throw new ValidationError("keep 引用必须已属于当前笔记（请改用 capture 新建）", "references");
      }
    }

    const captureWrites = writes.filter(
      (write): write is Extract<ReferenceWrite, { action: "capture" }> => write.action === "capture",
    );
    let loaded = new Map<string, LoadedTarget>();
    if (captureWrites.length > 0) {
      const targets = captureWrites.map((write) => targetKey(write.target));
      await repos.studyReferences.lockTargets(userId, targets);
      loaded = await repos.studyReferences.loadTargets(userId, targets);
    }

    const nowIso = new Date().toISOString();
    const rows: StudyReferenceInsertRow[] = [];
    for (const write of writes) {
      const id = write.id.toLowerCase();
      if (write.action === "keep") {
        const existing = existingById.get(id)!;
        rows.push({
          id: existing.id,
          kind: existing.kind,
          source_id: existing.source_id,
          question_id: existing.question_id,
          option_key: existing.option_key,
          start_offset: existing.start_offset,
          end_offset: existing.end_offset,
          quote_snapshot: existing.quote_snapshot,
          field_hash: existing.field_hash,
          display_snapshot: existing.display_snapshot,
          captured_at: existing.captured_at,
        });
      } else {
        const ref = targetKey(write.target);
        const target = loaded.get(`${ref.kind}:${ref.id}`);
        if (!target) {
          throw new NotFoundError("StudyReferenceTarget", `${ref.kind}:${ref.id}`);
        }
        const core = this.referenceService.captureAgainst(write.target, target);
        rows.push({ id, ...core, captured_at: nowIso });
      }
    }

    const snapshotBytes = Buffer.byteLength(
      JSON.stringify(rows.map((row) => row.display_snapshot)),
      "utf8",
    );
    if (snapshotBytes > STUDY_SNAPSHOT_BYTES_MAX) {
      throw new ValidationError("引用快照总量超过限制", "references");
    }
    return rows;
  }

  private async buildNoteDto(
    userId: string,
    note: L3StudyNoteRow,
    repos: StudyNoteRepos,
  ): Promise<StudyNoteDto> {
    const venues = orderVenues(await repos.studyNotes.listVenues(userId, note.id));
    const refRows = await repos.studyReferences.listForNote(userId, note.id);
    const references = await this.referenceService.resolve(userId, refRows, repos);
    return { ...this.toNoteSummary(note, venues), bodyMd: note.body_md, references };
  }

  private toNoteSummary(row: L3StudyNoteRow, venues: readonly L3QuestionType[]): StudyNoteSummary {
    return {
      id: row.id,
      title: row.title,
      venues: orderVenues(venues),
      pinned: row.pinned,
      status: row.status,
      version: row.version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private toTopicDto(row: L3StudyTopicRow, memberCount: number): StudyTopicDto {
    return {
      id: row.id,
      questionType: row.question_type,
      title: row.title,
      status: row.status,
      version: row.version,
      memberCount,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private async buildTopicDto(
    userId: string,
    topic: L3StudyTopicRow,
    repos: StudyNoteRepos,
  ): Promise<StudyTopicDto> {
    const memberCount = await repos.studyTopics.countMembers(userId, topic.id);
    return this.toTopicDto(topic, memberCount);
  }
}

/** 供上层（services/index）复用的导出别名（列表行类型便于 service 测试断言）。 */
export type { L3StudyNoteListRow };
