/**
 * L3ContextService — minimal L3 context-space business rules.
 *
 * This service intentionally depends only on the L3 repository boundary. It
 * does not import LLM, dictionary, FSRS, L2 content, or review progress code.
 */

import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { ConflictError, NotFoundError, ValidationError, isForeignKeyViolation } from "../errors";
import { withTransaction } from "../db/transaction";
import { createRepositories } from "../repositories/factory";
import type {
  Direction,
  Json,
  L3ContextLinkListItem,
  L3ContextLinkRow,
  L3ContextRow,
  L3ImportJobRow,
  L3OccurrenceListItem,
  L3OccurrenceRow,
  L3PaginatedList,
  L3SourceContextListItem,
  L3SourceListPage,
  L3SourceRow,
  L3SpaceSummary,
  L3SubSpace,
  L3WordContextListItem,
} from "../domain";
import type {
  IL3ContextRepository,
  IRepositories,
  IWordRepository,
  L3ContextDeleteBlockers,
  L3ContextLinkLookup,
  L3OccurrenceLookup,
  L3SourceDeleteBlockers,
  NewL3Context,
  NewL3ContextLink,
  NewL3ImportJob,
  NewL3Occurrence,
  NewL3Source,
} from "../repositories/interfaces";
import { L3_SUB_SPACES } from "./l3-practice.service";
import { slugifyHeadword } from "./capture.service";
import { buildL3TrioInputs } from "./l3-trio";
import {
  L3_CONTEXT_LINK_TARGET_TYPES,
  L3_CONTEXT_LINK_TYPES,
  L3_CONTEXT_TYPES,
  L3_IMPORT_JOB_STATUSES,
  L3_SOURCE_TYPES,
  type CreateL3ContextInput,
  type CreateL3ContextLinkInput,
  type CreateL3ImportJobInput,
  type CreateL3OccurrenceInput,
  type CreateL3SelectionCaptureInput,
  type CreateL3SourceInput,
  type CreateWordContextTrioInput,
  type DeleteL3ContextInput,
  type DeleteL3ContextLinkInput,
  type DeleteL3OccurrenceInput,
  type DeleteL3SourceInput,
  type GetL3SpaceSummaryInput,
  type L3DeleteResult,
  type ListL3ContextLinksInput,
  type ListL3OccurrencesInput,
  type ListL3SourcesInput,
  type ReplaceL3SourceSpacesInput,
} from "../schemas/service";

type TxRunner = typeof withTransaction;
type RepositoryFactory = (tx?: PoolClient) => IRepositories;

function requireEnum(value: string, allowed: readonly string[], field: string): void {
  if (!allowed.includes(value)) {
    throw new ValidationError(`Invalid ${field}: ${value}`, field);
  }
}

const DIRECTIONS: readonly Direction[] = ["通用", "考研", "雅思"];

/** 可选枚举校验：缺省 → null；非法 → ValidationError（对齐练习线同名助手）。 */
function resolveOptionalEnum<T extends string>(
  value: T | null | undefined,
  allowed: readonly string[],
  field: string,
): T | null {
  if (value == null) return null;
  if (!allowed.includes(value)) {
    throw new ValidationError(`Invalid ${field}: ${value}`, field);
  }
  return value;
}

function requireNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new ValidationError(`${field} cannot be empty`, field);
  }
}

function validateConfidence(confidence: number | null | undefined, field = "confidence"): void {
  if (confidence === undefined || confidence === null) return;
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new ValidationError(`${field} must be between 0 and 1`, field);
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requireUuidTargetId(targetId: string | null | undefined, targetType: string): string {
  if (!targetId) {
    throw new ValidationError(`targetId is required when targetType is ${targetType}`, "targetId");
  }
  if (!UUID_RE.test(targetId)) {
    throw new ValidationError(`targetId must be a UUID when targetType is ${targetType}`, "targetId");
  }
  return targetId.toLowerCase();
}

function validateOffset(input: CreateL3OccurrenceInput, context: L3ContextRow): void {
  const start = input.startOffset ?? null;
  const end = input.endOffset ?? null;
  if (start === null && end === null) return;
  if (start === null || end === null) {
    throw new ValidationError("startOffset and endOffset must be provided together", "offset");
  }
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) {
    throw new ValidationError("Invalid occurrence offsets", "offset");
  }
  if (end > context.text.length) {
    throw new ValidationError("Occurrence offsets exceed context text length", "offset");
  }
  if (context.text.slice(start, end) !== input.surface) {
    throw new ValidationError("Occurrence surface does not match context text at offsets", "surface");
  }
}

function isObject(value: Json | undefined | null): value is Record<string, Json> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireL2SoftTargetRef(targetRef: Json | undefined): void {
  if (!isObject(targetRef)) {
    throw new ValidationError("targetRef is required for l2_item soft references", "targetRef");
  }
  const hasField = typeof targetRef.field === "string" && targetRef.field.trim().length > 0;
  const hasContentLocator =
    (typeof targetRef.contentId === "string" && targetRef.contentId.trim().length > 0) ||
    (typeof targetRef.hash === "string" && targetRef.hash.trim().length > 0) ||
    (typeof targetRef.sourceRef === "string" && targetRef.sourceRef.trim().length > 0);
  if (!hasField || !hasContentLocator) {
    throw new ValidationError(
      "l2_item targetRef requires field plus one of contentId, hash, or sourceRef",
      "targetRef",
    );
  }
}

/**
 * 能力域标签归一（V0 接通 l3_source_spaces 死轴，ADR-0019 §4）：
 * 逐值枚举校验 + trim + 保序去重；省略/全空归一为 ['通用']。
 * 非法值抛 ValidationError（HTTP 层翻译为 400）。
 */
function normalizeSourceSpaces(spaces?: readonly string[] | null): L3SubSpace[] {
  if (!spaces || spaces.length === 0) return ["通用"];
  const seen = new Set<string>();
  const out: L3SubSpace[] = [];
  for (const raw of spaces) {
    const value = typeof raw === "string" ? raw.trim() : "";
    if (!value || seen.has(value)) continue;
    requireEnum(value, L3_SUB_SPACES, "spaces");
    seen.add(value);
    out.push(value as L3SubSpace);
  }
  return out.length > 0 ? out : ["通用"];
}

function hasSourceDeleteBlockers(blockers: L3SourceDeleteBlockers): boolean {
  return blockers.contextCount > 0 ||
    blockers.inboundContextLinkCount > 0 ||
    blockers.importJobCount > 0;
}

// P0 语境管理出口（2026-09-08 评估修正）：occurrences（圈记三件套必带）与同 context 的
// context_links 的 FK 均 ON DELETE CASCADE，随 context 一并删除，不构成删除阻断——若计入，
// 用户圈记的语境将永远无法删除（occurrenceCount 恒 > 0）。真正的 blocker 仅剩
// inboundContextLinkCount：target_type='context' 的软引用（target_id 为 text，无 FK 级联）。
function hasContextDeleteBlockers(blockers: L3ContextDeleteBlockers): boolean {
  return blockers.inboundContextLinkCount > 0;
}

function deleteConflict(
  entityType: "source" | "context",
  id: string,
  blockers: L3SourceDeleteBlockers | L3ContextDeleteBlockers,
): ConflictError {
  return new ConflictError(`Cannot delete L3 ${entityType} with active dependencies`, undefined, {
    entityType,
    id,
    blockers,
  });
}

/** 学习笔记引用阻止 source 删除（N1）：可读笔记标题/引用数 + 处理入口提示。 */
function sourceStudyNoteConflict(
  sourceId: string,
  noteBlockers: readonly { note_id: string; title: string; status: string; reference_count: number }[],
): ConflictError {
  return new ConflictError("Cannot delete L3 source referenced by study notes", undefined, {
    entityType: "source",
    id: sourceId,
    blockers: {
      studyNotes: noteBlockers.map((note) => ({
        id: note.note_id,
        title: note.title,
        status: note.status,
        referenceCount: note.reference_count,
      })),
    },
    resolution: "remove_references_or_convert_to_plain_excerpt",
  });
}

export class L3ContextService {
  constructor(
    private readonly l3Context: IL3ContextRepository,
    private readonly words?: IWordRepository,
    private readonly txRunner: TxRunner = withTransaction,
    private readonly repositoryFactory: RepositoryFactory = createRepositories,
  ) {}

  async createSource(input: CreateL3SourceInput): Promise<{ source: L3SourceRow }> {
    requireNonEmpty(input.userId, "userId");
    requireNonEmpty(input.title, "title");
    requireEnum(input.sourceType, L3_SOURCE_TYPES, "sourceType");
    const contentText = input.contentText?.trim() || null;
    const spaces = normalizeSourceSpaces(input.spaces);

    return this.withActorRepository(input.userId, async (repository) => {
      if (input.wordbookId) {
        const wordbook = await repository.findWordbookByIdForUser(input.userId, input.wordbookId);
        if (!wordbook) {
          throw new NotFoundError("Wordbook", input.wordbookId);
        }
      }

      // content_hash 去重（历史 FR-1.7）：同 hash 提示已存在而非新建。
      let contentHash: string | null = null;
      if (contentText) {
        contentHash = createHash("sha256").update(contentText).digest("hex");
        const existing = await repository.findSourceByContentHash(input.userId, contentHash);
        if (existing) {
          throw new ConflictError("L3 source with identical content already exists", undefined, {
            existingId: existing.id,
            title: existing.title,
          });
        }
      }

      const source = await repository.createSource({
        user_id: input.userId,
        wordbook_id: input.wordbookId ?? null,
        source_type: input.sourceType,
        title: input.title.trim(),
        author: input.author ?? null,
        url: input.url ?? null,
        language: input.language ?? null,
        metadata: input.metadata ?? {},
        content_text: contentText,
        content_hash: contentHash,
      } satisfies NewL3Source, spaces);
      return { source };
    });
  }

  /** V0 接通子空间死轴：全量替换来源能力域标签（归一+所有权校验）。 */
  async replaceSourceSpaces(
    input: ReplaceL3SourceSpacesInput,
  ): Promise<{ sourceId: string; spaces: L3SubSpace[] }> {
    requireNonEmpty(input.userId, "userId");
    requireNonEmpty(input.sourceId, "sourceId");
    const spaces = normalizeSourceSpaces(input.spaces);
    return this.withActorRepository(input.userId, async (repository) => {
      const source = await repository.findSourceById(input.userId, input.sourceId);
      if (!source) {
        throw new NotFoundError("L3Source", input.sourceId);
      }
      await repository.replaceSourceSpaces(input.userId, input.sourceId, spaces);
      return { sourceId: input.sourceId, spaces };
    });
  }

  async createContext(input: CreateL3ContextInput): Promise<{ context: L3ContextRow }> {
    requireNonEmpty(input.userId, "userId");
    requireNonEmpty(input.text, "text");
    requireEnum(input.contextType, L3_CONTEXT_TYPES, "contextType");

    return this.withActorRepository(input.userId, async (repository) => {
      const source = await repository.findSourceById(input.userId, input.sourceId);
      if (!source) {
        throw new NotFoundError("L3Source", input.sourceId);
      }

      const context = await repository.createContext({
        user_id: input.userId,
        source_id: input.sourceId,
        context_type: input.contextType,
        text: input.text,
        normalized_text: input.normalizedText ?? null,
        language: input.language ?? source.language,
        position: input.position ?? {},
        metadata: input.metadata ?? {},
      } satisfies NewL3Context);
      return { context };
    });
  }

  async createOccurrence(input: CreateL3OccurrenceInput): Promise<{ occurrence: L3OccurrenceRow }> {
    requireNonEmpty(input.userId, "userId");
    requireNonEmpty(input.surface, "surface");
    validateConfidence(input.confidence);

    return this.withActorRepository(input.userId, async (repository) => {
      const contextWithSource = await repository.findContextWithSourceById(input.userId, input.contextId);
      if (!contextWithSource) {
        throw new NotFoundError("L3Context", input.contextId);
      }
      const { context, source } = contextWithSource;

      const word = source.wordbook_id
        ? input.wordId
          ? await repository.findWordInWordbookById(source.wordbook_id, input.wordId)
          : input.slug
            ? await repository.findWordInWordbookBySlug(source.wordbook_id, input.slug)
            : null
        : input.wordId
          ? await repository.findWordById(input.wordId)
          : input.slug
            ? await repository.findWordBySlug(input.slug)
            : null;
      if (!word) {
        throw new NotFoundError("Word", input.wordId ?? input.slug ?? "");
      }

      validateOffset(input, context);

      const occurrence = await repository.createOccurrence({
        user_id: input.userId,
        context_id: input.contextId,
        word_id: word.id,
        surface: input.surface,
        lemma: input.lemma ?? null,
        start_offset: input.startOffset ?? null,
        end_offset: input.endOffset ?? null,
        confidence: input.confidence ?? null,
        evidence: input.evidence ?? {},
        bound_sense: input.boundSense ?? null,
      } satisfies NewL3Occurrence);
      return { occurrence };
    });
  }

  /**
   * 圈记（grill 定案 2026-09-07）：阅读视图选中文本 → 记录语境条目。
   * 锚点 = position{start,end}（全文 UTF-16 偏移）；occurrence 偏移相对 text。
   * 词不在库 → 先经 words.insertMany（batch-pool 角色）建 stub 再绑（capture-first）。
   * owner 直写 = trusted foundation-write（ADR-0007），不走提案队列。
   */
  async createSelectionCapture(input: CreateL3SelectionCaptureInput): Promise<{
    contextId: string; occurrenceId: string; word: { id: string; slug: string; title: string }; created: boolean;
  }> {
    requireNonEmpty(input.userId, "userId");
    requireNonEmpty(input.text, "text");
    requireNonEmpty(input.surface, "surface");
    requireNonEmpty(input.wordSlug, "wordSlug");
    if (!(Number.isInteger(input.anchorStart) && Number.isInteger(input.anchorEnd) && input.anchorEnd > input.anchorStart)) {
      throw new ValidationError("anchor range is invalid", "anchor");
    }
    const contextType = input.contextType ?? "sentence";
    requireEnum(contextType, ["sentence", "excerpt"], "contextType");

    // ① 词解析/stub —— words INSERT 仅 batch_import 角色可执行，必须在 app 事务外（capture.service 同款）
    const slug = slugifyHeadword(input.wordSlug);
    if (!slug) throw new ValidationError("wordSlug must contain word characters", "wordSlug");
    let word = await this.l3Context.findWordBySlug(slug);
    let created = false;
    if (!word) {
      if (!this.words?.insertMany) throw new Error("words repository with insertMany is required for selection capture");
      await this.words.insertMany([
        { slug, title: slug, lemma: slug, pos: null, cefr: null, ipa: null, short_definition: null },
      ]);
      created = true;
    }
    word = await this.l3Context.findWordBySlug(slug);
    if (!word) throw new Error(`capture word upsert failed for slug "${slug}"`);

    // ② 语境 + occurrence 同事务（RLS actor）。圈记幂等复用（2026-09-08 用户反馈）：
    // 一句话常涉及多个词——同来源同锚点已存在语境时复用它、只追加 occurrence；
    // 同词重复圈记幂等返回既有 occurrence。数据模型天然支持一语境多 occurrence。
    return this.withActorRepository(input.userId, async (repository) => {
      const source = await repository.lockSourceByIdForUser(input.userId, input.sourceId);
      if (!source) throw new NotFoundError("L3Source", input.sourceId);
      const fullText = source.content_text;
      if (fullText == null) throw new ValidationError("source has no content text", "contentText");
      if (input.anchorEnd > fullText.length || fullText.slice(input.anchorStart, input.anchorEnd).length === 0) {
        throw new ValidationError("anchor range out of content bounds", "anchor");
      }

      const existingContext = await repository.findContextByAnchor(
        input.userId, input.sourceId, input.anchorStart, input.anchorEnd,
      );
      let contextId: string;
      if (existingContext) {
        contextId = existingContext.id;
        const siblings = await repository.listOccurrencesForContext(input.userId, contextId);
        const sameWord = siblings.find((o) => o.word_id === word!.id);
        if (sameWord) {
          return {
            contextId,
            occurrenceId: sameWord.id,
            word: { id: word!.id, slug: word!.slug, title: word!.title },
            created,
          };
        }
      }

      const context = existingContext ?? await repository.createContext({
        user_id: input.userId,
        source_id: input.sourceId,
        context_type: contextType,
        text: input.text,
        normalized_text: null,
        language: source.language,
        position: { start: input.anchorStart, end: input.anchorEnd },
        metadata: {},
      } satisfies NewL3Context);
      contextId = context.id;

      const rel = input.text.toLowerCase().indexOf(input.surface.toLowerCase());
      const occurrence = await repository.createOccurrence({
        user_id: input.userId,
        context_id: contextId,
        word_id: word!.id,
        surface: input.surface,
        lemma: word!.lemma,
        start_offset: rel >= 0 ? rel : null,
        end_offset: rel >= 0 ? rel + input.surface.length : null,
        confidence: null,
        evidence: { via: "selection_capture" },
        bound_sense: input.boundSense || null,
      } satisfies NewL3Occurrence);

      return {
        contextId,
        occurrenceId: occurrence.id,
        word: { id: word!.id, slug: word!.slug, title: word!.title },
        created,
      };
    });
  }

  /** golden 快记（grill 定案 2026-09-07）：粘贴即建 mini-source 三件套，单事务。 */
  async createWordContextTrio(input: CreateWordContextTrioInput): Promise<{
    sourceId: string; contextId: string; occurrenceId: string;
  }> {
    return this.withActorRepository(input.userId, async (repository) => {
      const word = await repository.findWordBySlug(input.slug);
      if (!word) throw new NotFoundError("Word", input.slug);
      const trio = buildL3TrioInputs({
        userId: input.userId,
        wordId: word.id,
        lemma: word.lemma,
        sentence: input.text,
        sourceTitle: input.sourceTitle,
        sourceUrl: input.sourceUrl,
        obsidianRef: input.obsidianRef,
      });
      const source = await repository.createSource({
        ...trio.source,
        metadata: trio.source.metadata as Json,
        // golden 快记来源无题型上下文：落「通用」能力域（新建来源恒至少一个标签）。
      }, ["通用"]);
      const context = await repository.createContext({
        ...trio.context,
        source_id: source.id,
        position: trio.context.position as Json,
        metadata: trio.context.metadata as Json,
      });
      const occurrence = await repository.createOccurrence({
        ...trio.occurrence,
        context_id: context.id,
        evidence: trio.occurrence.evidence as Json,
        bound_sense: input.boundSense || null,
      });
      return { sourceId: source.id, contextId: context.id, occurrenceId: occurrence.id };
    });
  }

  async createContextLink(input: CreateL3ContextLinkInput): Promise<{ link: L3ContextLinkRow }> {
    requireNonEmpty(input.userId, "userId");
    requireEnum(input.linkType, L3_CONTEXT_LINK_TYPES, "linkType");
    requireEnum(input.targetType, L3_CONTEXT_LINK_TARGET_TYPES, "targetType");
    validateConfidence(input.confidence);

    const needsSoftTargetLock =
      input.targetType === "source" || input.targetType === "context" || input.targetType === "word";
    if (needsSoftTargetLock) {
      return this.txRunner(async (tx) => {
        const repos = this.repositoryFactory(tx);
        return this.createContextLinkWithRepository(input, repos.l3Context, true);
      }, { actorId: input.userId });
    }

    return this.withActorRepository(
      input.userId,
      (repository) => this.createContextLinkWithRepository(input, repository, false),
    );
  }

  private async createContextLinkWithRepository(
    input: CreateL3ContextLinkInput,
    repository: IL3ContextRepository,
    lockSoftTarget: boolean,
  ): Promise<{ link: L3ContextLinkRow }> {
    if (!input.contextId && !input.wordId) {
      throw new ValidationError("contextId or wordId is required", "contextId");
    }
    let targetIdForInsert = input.targetId ?? null;
    let contextWithSource: Awaited<ReturnType<IL3ContextRepository["findContextWithSourceById"]>> = null;
    if (input.contextId) {
      contextWithSource = await repository.findContextWithSourceById(input.userId, input.contextId);
      if (!contextWithSource) {
        throw new NotFoundError("L3Context", input.contextId);
      }
    }
    if (input.wordId) {
      const word = contextWithSource?.source.wordbook_id
        ? await repository.findWordInWordbookById(contextWithSource.source.wordbook_id, input.wordId)
        : await repository.findWordById(input.wordId);
      if (!word) {
        throw new NotFoundError("Word", input.wordId);
      }
    }
    if (input.targetType === "word") {
      const targetId = requireUuidTargetId(input.targetId, "word");
      targetIdForInsert = targetId;
      // word 目标同样是 text 软引用（无 FK 级联）：与删词的 advisory lock
      // 互斥（0023 stub 删除走同一把 l3:active-target 锁），防建链-删词竞态。
      if (lockSoftTarget) {
        await repository.lockActiveL3TargetReference(input.userId, "word", targetId);
      }
      const word = contextWithSource?.source.wordbook_id
        ? await repository.findWordInWordbookById(contextWithSource.source.wordbook_id, targetId)
        : await repository.findWordById(targetId);
      if (!word) {
        throw new NotFoundError("Word", targetId);
      }
    }
    if (input.targetType === "context") {
      const targetId = requireUuidTargetId(input.targetId, "context");
      targetIdForInsert = targetId;
      if (lockSoftTarget) {
        await repository.lockActiveL3TargetReference(input.userId, "context", targetId);
      }
      const context = await repository.findContextById(input.userId, targetId);
      if (!context) {
        throw new NotFoundError("L3Context", targetId);
      }
    }
    if (input.targetType === "source") {
      const targetId = requireUuidTargetId(input.targetId, "source");
      targetIdForInsert = targetId;
      if (lockSoftTarget) {
        await repository.lockActiveL3TargetReference(input.userId, "source", targetId);
      }
      const source = await repository.findSourceById(input.userId, targetId);
      if (!source) {
        throw new NotFoundError("L3Source", targetId);
      }
    }
    if (input.targetType === "l2_item") {
      requireL2SoftTargetRef(input.targetRef);
    }

    const link = await repository.createContextLink({
      user_id: input.userId,
      context_id: input.contextId ?? null,
      word_id: input.wordId ?? null,
      link_type: input.linkType,
      target_type: input.targetType,
      target_id: targetIdForInsert,
      target_ref: input.targetRef ?? {},
      confidence: input.confidence ?? null,
      provenance: input.provenance ?? {},
    } satisfies NewL3ContextLink);
    return { link };
  }

  async deleteOccurrence(input: DeleteL3OccurrenceInput): Promise<L3DeleteResult> {
    requireNonEmpty(input.userId, "userId");
    requireNonEmpty(input.occurrenceId, "occurrenceId");

    return this.withActorRepository(input.userId, async (repository) => {
      const deleted = await repository.deleteOccurrence(input.userId, input.occurrenceId);
      if (!deleted) {
        throw new NotFoundError("L3Occurrence", input.occurrenceId);
      }

      return {
        deleted: { entityType: "occurrence", id: deleted.id },
        activeReadInvalidation: true,
      };
    });
  }

  async deleteContextLink(input: DeleteL3ContextLinkInput): Promise<L3DeleteResult> {
    requireNonEmpty(input.userId, "userId");
    requireNonEmpty(input.contextLinkId, "contextLinkId");

    return this.withActorRepository(input.userId, async (repository) => {
      const deleted = await repository.deleteContextLink(input.userId, input.contextLinkId);
      if (!deleted) {
        throw new NotFoundError("L3ContextLink", input.contextLinkId);
      }

      return {
        deleted: { entityType: "context_link", id: deleted.id },
        activeReadInvalidation: true,
      };
    });
  }

  async deleteSource(input: DeleteL3SourceInput): Promise<L3DeleteResult> {
    requireNonEmpty(input.userId, "userId");
    requireNonEmpty(input.sourceId, "sourceId");

    return this.txRunner(async (tx) => {
      const repos = this.repositoryFactory(tx);
      const source = await repos.l3Context.lockSourceByIdForUser(input.userId, input.sourceId);
      if (!source) {
        throw new NotFoundError("L3Source", input.sourceId);
      }

      await repos.l3Context.lockActiveL3TargetReference(input.userId, "source", input.sourceId);
      const blockers = await repos.l3Context.getSourceDeleteBlockers(input.userId, input.sourceId);
      if (hasSourceDeleteBlockers(blockers)) {
        throw deleteConflict("source", input.sourceId, blockers);
      }

      // 学习笔记引用保护（N1）：被引用的 source 先移除引用或显式转普通摘录才能删。
      // 预检查**计入子题引用**（getSourceDeleteBlockers 同时匹配 source 直引与其下
      // 题目的引用），并与 FK RESTRICT 兜底构成双保险（见 catch 分支）。
      const noteBlockers = await repos.studyReferences.getSourceDeleteBlockers(input.userId, input.sourceId);
      if (noteBlockers.length > 0) {
        throw sourceStudyNoteConflict(input.sourceId, noteBlockers);
      }

      let deleted: Awaited<ReturnType<typeof repos.l3Context.deleteSource>>;
      // F1：DELETE 的 FK 兜底必须先恢复失败事务（保存点）再重查 blocker——在 aborted
      // 事务里查询会得到 25P02，丢失约定的 409 合同。保存点名称为静态常量、不从请求插值。
      await tx.query("SAVEPOINT study_note_delete");
      try {
        deleted = await repos.l3Context.deleteSource(input.userId, input.sourceId);
      } catch (error) {
        // 并发兜底：capture 在本事务预检查之后插入引用 → DELETE 触发 FK RESTRICT
        // （23503）；回滚到保存点后重查可读 blocker 转 409，不把数据库异常当 500。
        if (isForeignKeyViolation(error)) {
          await tx.query("ROLLBACK TO SAVEPOINT study_note_delete");
          await tx.query("RELEASE SAVEPOINT study_note_delete");
          const latestNoteBlockers = await repos.studyReferences.getSourceDeleteBlockers(input.userId, input.sourceId);
          if (latestNoteBlockers.length > 0) {
            throw sourceStudyNoteConflict(input.sourceId, latestNoteBlockers);
          }
          // 无匹配 blocker：保持原错误语义（不伪造笔记阻塞，由既有通用约束处理收口）
        }
        throw error;
      }
      await tx.query("RELEASE SAVEPOINT study_note_delete");
      if (!deleted) {
        const current = await repos.l3Context.findSourceById(input.userId, input.sourceId);
        if (!current) {
          throw new NotFoundError("L3Source", input.sourceId);
        }
        const latestNoteBlockers = await repos.studyReferences.getSourceDeleteBlockers(input.userId, input.sourceId);
        if (latestNoteBlockers.length > 0) {
          throw sourceStudyNoteConflict(input.sourceId, latestNoteBlockers);
        }
        const latestBlockers = await repos.l3Context.getSourceDeleteBlockers(input.userId, input.sourceId);
        throw deleteConflict("source", input.sourceId, latestBlockers);
      }

      return {
        deleted: { entityType: "source", id: deleted.id },
        activeReadInvalidation: true,
      };
    }, { actorId: input.userId });
  }

  async deleteContext(input: DeleteL3ContextInput): Promise<L3DeleteResult> {
    requireNonEmpty(input.userId, "userId");
    requireNonEmpty(input.contextId, "contextId");

    return this.txRunner(async (tx) => {
      const repos = this.repositoryFactory(tx);
      const context = await repos.l3Context.lockContextByIdForUser(input.userId, input.contextId);
      if (!context) {
        throw new NotFoundError("L3Context", input.contextId);
      }

      await repos.l3Context.lockActiveL3TargetReference(input.userId, "context", input.contextId);
      const blockers = await repos.l3Context.getContextDeleteBlockers(input.userId, input.contextId);
      if (hasContextDeleteBlockers(blockers)) {
        throw deleteConflict("context", input.contextId, blockers);
      }

      const deleted = await repos.l3Context.deleteContext(input.userId, input.contextId);
      if (!deleted) {
        const current = await repos.l3Context.findContextById(input.userId, input.contextId);
        if (!current) {
          throw new NotFoundError("L3Context", input.contextId);
        }
        const latestBlockers = await repos.l3Context.getContextDeleteBlockers(input.userId, input.contextId);
        throw deleteConflict("context", input.contextId, latestBlockers);
      }

      return {
        deleted: { entityType: "context", id: deleted.id },
        activeReadInvalidation: true,
      };
    }, { actorId: input.userId });
  }

  async createImportJob(input: CreateL3ImportJobInput): Promise<{ importJob: L3ImportJobRow }> {
    requireNonEmpty(input.userId, "userId");
    requireNonEmpty(input.inputHash, "inputHash");
    requireEnum(input.status, L3_IMPORT_JOB_STATUSES, "status");
    return this.withActorRepository(input.userId, async (repository) => {
      if (input.sourceId) {
        const source = await repository.findSourceById(input.userId, input.sourceId);
        if (!source) {
          throw new NotFoundError("L3Source", input.sourceId);
        }
      }

      const importJob = await repository.createImportJob({
        user_id: input.userId,
        source_id: input.sourceId ?? null,
        status: input.status,
        input_hash: input.inputHash,
        input_summary: input.inputSummary ?? null,
        stats: input.stats ?? {},
        error: input.error ?? null,
      } satisfies NewL3ImportJob);
      return { importJob };
    });
  }

  async listContextsForWord(input: {
    userId: string;
    wordId?: string;
    slug?: string;
    /** 两轴过滤（ADR-0029 §6②）：方向 × 子空间。 */
    direction?: Direction | null;
    space?: L3SubSpace | null;
    limit: number;
    cursor?: string | null;
  }): Promise<L3PaginatedList<L3WordContextListItem>> {
    requireNonEmpty(input.userId, "userId");
    if (!input.wordId && !input.slug) {
      throw new ValidationError("wordId or slug is required", "word");
    }
    const direction = resolveOptionalEnum(input.direction, DIRECTIONS, "direction");
    const space = resolveOptionalEnum(input.space, L3_SUB_SPACES, "space");
    return this.withActorRepository(input.userId, async (repository) => {
      if (input.slug) {
        const word = await repository.findWordBySlug(input.slug);
        if (!word) throw new NotFoundError("Word", input.slug);
      }
      if (input.wordId) {
        const word = await repository.findWordById(input.wordId);
        if (!word) throw new NotFoundError("Word", input.wordId);
      }
      return repository.listContextsForWord({ ...input, direction, space });
    });
  }

  async listContextsForSource(input: {
    userId: string;
    sourceId: string;
    limit: number;
    cursor?: string | null;
  }): Promise<L3PaginatedList<L3SourceContextListItem>> {
    requireNonEmpty(input.userId, "userId");
    return this.withActorRepository(input.userId, async (repository) => {
      const source = await repository.findSourceById(input.userId, input.sourceId);
      if (!source) {
        throw new NotFoundError("L3Source", input.sourceId);
      }
      return repository.listContextsForSource(input);
    });
  }

  async listSources(input: ListL3SourcesInput): Promise<L3SourceListPage> {
    requireNonEmpty(input.userId, "userId");
    const direction = resolveOptionalEnum(input.direction, DIRECTIONS, "direction");
    const space = resolveOptionalEnum(input.space, L3_SUB_SPACES, "space");
    return this.withActorRepository(input.userId, (repository) =>
      repository.listSources({
        userId: input.userId,
        sourceType: input.sourceType,
        q: input.q,
        sort: input.sort,
        direction,
        space,
        limit: Math.min(input.limit, 50),
        offset: Math.max(input.offset, 0),
      }),
    );
  }


  /** ADR-0029 §6①：occurrence 只读列表（词 / 语境 / 两轴过滤 + cursor 分页）。 */
  async listOccurrences(input: ListL3OccurrencesInput): Promise<L3PaginatedList<L3OccurrenceListItem>> {
    requireNonEmpty(input.userId, "userId");
    const direction = resolveOptionalEnum(input.direction, DIRECTIONS, "direction");
    const space = resolveOptionalEnum(input.space, L3_SUB_SPACES, "space");
    return this.withActorRepository(input.userId, async (repository) => {
      if (input.slug) {
        const word = await repository.findWordBySlug(input.slug);
        if (!word) throw new NotFoundError("Word", input.slug);
      }
      if (input.wordId) {
        const word = await repository.findWordById(input.wordId);
        if (!word) throw new NotFoundError("Word", input.wordId);
      }
      if (input.contextId) {
        const context = await repository.findContextById(input.userId, input.contextId);
        if (!context) throw new NotFoundError("L3Context", input.contextId);
      }
      return repository.listOccurrences({ ...input, direction, space });
    });
  }

  /** ADR-0029 §6①：context-link 只读列表（词 / 语境 / 类型 / 两轴过滤 + cursor 分页）。 */
  async listContextLinks(input: ListL3ContextLinksInput): Promise<L3PaginatedList<L3ContextLinkListItem>> {
    requireNonEmpty(input.userId, "userId");
    const direction = resolveOptionalEnum(input.direction, DIRECTIONS, "direction");
    const space = resolveOptionalEnum(input.space, L3_SUB_SPACES, "space");
    return this.withActorRepository(input.userId, async (repository) => {
      if (input.slug) {
        const word = await repository.findWordBySlug(input.slug);
        if (!word) throw new NotFoundError("Word", input.slug);
      }
      if (input.wordId) {
        const word = await repository.findWordById(input.wordId);
        if (!word) throw new NotFoundError("Word", input.wordId);
      }
      if (input.contextId) {
        const context = await repository.findContextById(input.userId, input.contextId);
        if (!context) throw new NotFoundError("L3Context", input.contextId);
      }
      return repository.listContextLinks({ ...input, direction, space });
    });
  }

  /**
   * B1 素材宇宙：空间汇总（四类实体全量计数 + 近 N 天每日新增）。
   * 只读、user-scoped；同 actorId 读事务内顺序执行两次查询（pg 单连接不并发）。
   * windowDays 在此夹紧到 [1, 90]（与 HTTP schema 双保险，便于非 HTTP 调用方）。
   */
  async getSpaceSummary(input: GetL3SpaceSummaryInput): Promise<L3SpaceSummary> {
    requireNonEmpty(input.userId, "userId");
    const windowDays = Math.min(Math.max(Math.trunc(input.windowDays), 1), 90);
    return this.withActorRepository(input.userId, async (repository) => {
      const counts = await repository.getSpaceSummaryCounts(input.userId);
      const byDay = await repository.getSpaceGrowth(input.userId, windowDays);
      return { counts, growth: { windowDays, byDay } };
    });
  }

  private withActorRepository<T>(
    userId: string,
    callback: (repository: IL3ContextRepository) => Promise<T>,
  ): Promise<T> {
    return this.txRunner(async (tx) => callback(this.repositoryFactory(tx).l3Context), { actorId: userId });
  }
}
