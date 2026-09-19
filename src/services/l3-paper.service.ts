/**
 * L3PaperService — 题目/试卷入库与卷面组装（ADR-0030）。
 *
 * 边界：只碰 l3_questions/l3_papers 与 l3_sources/l3_source_spaces（自动打标）。
 * 不碰 context/occurrence、不碰 FSRS、不引入 LLM。owner 直写面（V1）；agent
 * 双级（pending/trusted 直写）后续波次在同一代码路径按角色分叉。
 */

import type { PoolClient } from "pg";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { withTransaction } from "../db/transaction";
import { createRepositories } from "../repositories/factory";
import type { IRepositories, IL3ContextRepository, IL3PaperRepository } from "../repositories/interfaces";
import type {
  Json,
  L3AssembledSection,
  L3PaperDetail,
  L3PaperListPage,
  L3PaperRow,
  L3PracticeFilePage,
  L3QuestionRow,
  L3SubSpace,
} from "../domain";
import {
  L3_QUESTION_TYPES,
  PAPER_PAYLOAD_VERSION,
  questionTypeAllowsSourceless,
  questionTypeSpace,
  validatePaperPayloadShape,
  type L3PaperPayload,
  type L3PaperSection,
  type L3QuestionType,
} from "../domain/l3-question-types";
import type {
  CreateL3PaperInput,
  CreateL3PaperSectionInput,
  CreateL3QuestionInput,
  DeleteL3QuestionInput,
  GetL3PracticeFileInput,
  ListL3PapersInput,
  ListL3PracticeFilesInput,
} from "../schemas/service";

type TxRunner = typeof withTransaction;
type RepositoryFactory = (tx?: PoolClient) => IRepositories;

const DIRECTIONS = ["通用", "考研", "雅思"] as const;

function requireEnum(value: string, allowed: readonly string[], field: string): void {
  if (!allowed.includes(value)) {
    throw new ValidationError(`Invalid ${field}: ${value}`, field);
  }
}

function requireNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new ValidationError(`${field} cannot be empty`, field);
  }
}

function trimOrNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/** section 文件身份：sourceId 优先；无正文题型必须显式给 fileKey。 */
function resolveSectionIdentity(
  section: CreateL3PaperSectionInput,
): { sourceId: string | null; fileKey: string | null } {
  const sourceId = trimOrNull(section.sourceId ?? null);
  const fileKey = trimOrNull(section.fileKey ?? null);
  if (sourceId) return { sourceId, fileKey };
  if (!questionTypeAllowsSourceless(section.questionType)) {
    throw new ValidationError(
      `question_type ${section.questionType} 的题目必须挂阅读材料 sourceId`,
      "sourceId",
    );
  }
  if (!fileKey) {
    throw new ValidationError("无正文材料的题组必须提供 fileKey（题组键）", "fileKey");
  }
  return { sourceId: null, fileKey };
}

export class L3PaperService {
  constructor(
    private readonly paperRepo: IL3PaperRepository,
    private readonly contextRepo: IL3ContextRepository,
    private readonly txRunner: TxRunner = withTransaction,
    private readonly repositoryFactory: RepositoryFactory = createRepositories,
  ) {}

  private withActor<T>(userId: string, callback: (repos: IRepositories) => Promise<T>): Promise<T> {
    return this.txRunner(async (tx) => callback(this.repositoryFactory(tx)), { actorId: userId });
  }

  /** 散题录入：归入某个做题文件（source 题组或 fileKey 题组）。 */
  async createQuestion(input: CreateL3QuestionInput): Promise<{ question: L3QuestionRow }> {
    requireNonEmpty(input.userId, "userId");
    requireNonEmpty(input.stem, "stem");
    requireEnum(input.questionType, L3_QUESTION_TYPES, "questionType");
    const sourceId = trimOrNull(input.sourceId ?? null);
    const fileKey = trimOrNull(input.fileKey ?? null);
    if (!sourceId && !fileKey) {
      throw new ValidationError("题目必须归属一个做题文件：sourceId 或 fileKey 至少给一个", "sourceId");
    }
    if (!sourceId && !questionTypeAllowsSourceless(input.questionType)) {
      throw new ValidationError(
        `question_type ${input.questionType} 的题目必须挂阅读材料 sourceId`,
        "sourceId",
      );
    }
    const ordinal = Number.isInteger(input.ordinal) && (input.ordinal as number) >= 0
      ? (input.ordinal as number)
      : 0;

    return this.withActor(input.userId, async (repos) => {
      if (sourceId) {
        const source = await repos.l3Context.findSourceById(input.userId, sourceId);
        if (!source) throw new NotFoundError("L3Source", sourceId);
      }
      const question = await repos.l3Paper.insertQuestion({
        user_id: input.userId,
        source_id: sourceId,
        file_key: fileKey,
        space: questionTypeSpace(input.questionType) as L3SubSpace,
        question_type: input.questionType,
        ordinal,
        stem: input.stem.trim(),
        options: (input.options ?? []) as unknown as Json,
        answer: (input.answer ?? {}) as Json,
        explanation: input.explanation?.trim() || null,
        evidence: (input.evidence ?? []) as unknown as Json,
      });
      if (sourceId) {
        await repos.l3Context.ensureSourceSpaces(input.userId, sourceId, [questionTypeSpace(input.questionType)]);
      }
      return { question };
    });
  }

  /**
   * 粘贴建卷（owner 直写）：单事务内逐 section 建题 → 组 payload 引用 → 建卷；
   * 同事务按题型给材料补能力域标签（ADR-0030 §3，用户不做两次分类）。
   */
  async createPaper(
    input: CreateL3PaperInput,
  ): Promise<{ paper: L3PaperRow; questions: L3QuestionRow[]; questionCount: number }> {
    requireNonEmpty(input.userId, "userId");
    requireNonEmpty(input.title, "title");
    const direction = trimOrNull(input.direction ?? null) as (typeof DIRECTIONS)[number] | null;
    if (direction) requireEnum(direction, DIRECTIONS, "direction");
    if (!Array.isArray(input.sections) || input.sections.length === 0) {
      throw new ValidationError("试卷至少包含一个 section", "sections");
    }

    return this.withActor(input.userId, async (repos) => {
      const created: L3QuestionRow[] = [];
      const payloadSections: L3PaperSection[] = [];
      const sourceSpaces = new Map<string, Set<string>>();

      for (let i = 0; i < input.sections.length; i += 1) {
        const section = input.sections[i];
        requireNonEmpty(section.title, `sections[${i}].title`);
        requireEnum(section.questionType, L3_QUESTION_TYPES, `sections[${i}].questionType`);
        if (!Array.isArray(section.questions) || section.questions.length === 0) {
          throw new ValidationError(`sections[${i}] 至少包含一道题`, `sections[${i}].questions`);
        }
        const identity = resolveSectionIdentity(section);
        if (identity.sourceId) {
          const source = await repos.l3Context.findSourceById(input.userId, identity.sourceId);
          if (!source) throw new NotFoundError("L3Source", identity.sourceId);
        }

        const questionIds: string[] = [];
        for (let q = 0; q < section.questions.length; q += 1) {
          const body = section.questions[q];
          requireNonEmpty(body.stem, `sections[${i}].questions[${q}].stem`);
          const ordinal = Number.isInteger(body.ordinal) && (body.ordinal as number) >= 0
            ? (body.ordinal as number)
            : q;
          const row = await repos.l3Paper.insertQuestion({
            user_id: input.userId,
            source_id: identity.sourceId,
            file_key: identity.fileKey,
            space: questionTypeSpace(section.questionType) as L3SubSpace,
            question_type: section.questionType,
            ordinal,
            stem: body.stem.trim(),
            options: (body.options ?? []) as unknown as Json,
            answer: (body.answer ?? {}) as Json,
            explanation: body.explanation?.trim() || null,
            evidence: (body.evidence ?? []) as unknown as Json,
          });
          created.push(row);
          questionIds.push(row.id);
        }

        if (identity.sourceId) {
          const set = sourceSpaces.get(identity.sourceId) ?? new Set<string>();
          set.add(questionTypeSpace(section.questionType));
          sourceSpaces.set(identity.sourceId, set);
        }
        payloadSections.push({
          key: `s${i + 1}`,
          title: section.title.trim(),
          questionType: section.questionType,
          sourceId: identity.sourceId,
          fileKey: identity.fileKey,
          questionIds,
        });
      }

      const payload: L3PaperPayload = { version: PAPER_PAYLOAD_VERSION, sections: payloadSections };
      // 防御性自校验：构造路径也要过 domain 纯函数（版本/唯一键/身份/题 id 唯一）。
      validatePaperPayloadShape(payload);

      const paper = await repos.l3Paper.insertPaper({
        user_id: input.userId,
        title: input.title.trim(),
        direction,
        metadata: (input.metadata ?? {}) as Json,
        payload: payload as unknown as Json,
        payload_version: PAPER_PAYLOAD_VERSION,
        status: "active",
      });

      for (const [sourceId, spaces] of sourceSpaces) {
        await repos.l3Context.ensureSourceSpaces(input.userId, sourceId, [...spaces]);
      }

      return { paper, questions: created, questionCount: created.length };
    });
  }

  listPracticeFiles(input: ListL3PracticeFilesInput): Promise<L3PracticeFilePage> {
    if (input.questionType) requireEnum(input.questionType, L3_QUESTION_TYPES, "questionType");
    if (input.direction) requireEnum(input.direction, DIRECTIONS, "direction");
    return this.withActor(input.userId, (repos) => repos.l3Paper.listPracticeFiles({
      userId: input.userId,
      questionType: input.questionType ?? null,
      direction: input.direction ?? null,
      q: input.q ?? null,
      sourceId: input.sourceId ?? null,
      fileKey: input.fileKey ?? null,
      limit: input.limit,
      offset: input.offset,
    }));
  }

  listPapers(input: ListL3PapersInput): Promise<L3PaperListPage> {
    if (input.status) requireEnum(input.status, ["draft", "active", "archived"], "status");
    return this.withActor(input.userId, (repos) => repos.l3Paper.listPapers({
      userId: input.userId,
      status: input.status ?? null,
      q: input.q ?? null,
      limit: input.limit,
      offset: input.offset,
    }));
  }

  async getPracticeFile(
    input: GetL3PracticeFileInput,
  ): Promise<{
    question_type: L3QuestionType;
    source: { id: string; title: string } | null;
    /** 原文正文（file venue 做题表面文栏数据源；fileKey 型为 null）。 */
    source_content: string | null;
    file_key: string | null;
    questions: L3QuestionRow[];
  }> {
    requireEnum(input.questionType, L3_QUESTION_TYPES, "questionType");
    const sourceId = trimOrNull(input.sourceId ?? null);
    const fileKey = trimOrNull(input.fileKey ?? null);
    if (!sourceId && !fileKey) {
      throw new ValidationError("文件身份缺失：sourceId 或 fileKey 至少给一个", "sourceId");
    }
    return this.withActor(input.userId, async (repos) => {
      if (sourceId) {
        const source = await repos.l3Context.findSourceById(input.userId, sourceId);
        if (!source) throw new NotFoundError("L3Source", sourceId);
        const questions = await repos.l3Paper.listActiveQuestionsForFile(input.userId, {
          sourceId,
          questionType: input.questionType,
        });
        return {
          question_type: input.questionType,
          source: { id: source.id, title: source.title },
          source_content: source.content_text,
          file_key: null,
          questions,
        };
      }
      const questions = await repos.l3Paper.listActiveQuestionsForFile(input.userId, {
        fileKey,
        questionType: input.questionType,
      });
      return {
        question_type: input.questionType,
        source: null,
        source_content: null,
        file_key: fileKey,
        questions,
      };
    });
  }

  /** 卷面现拉组装：引用缺失降级 missing 占位（ADR-0030 §2 护栏②），不抛 500。 */
  async getPaper(userId: string, paperId: string): Promise<L3PaperDetail> {
    return this.withActor(userId, async (repos) => {
      const paper = await repos.l3Paper.findPaperById(userId, paperId);
      if (!paper) throw new NotFoundError("L3Paper", paperId);

      const allIds = paper.payload.sections.flatMap((section) => section.questionIds);
      const questions = await repos.l3Paper.findActiveQuestionsByIds(userId, allIds);
      const questionsById = new Map(questions.map((question) => [question.id, question]));

      const sourceIds = [...new Set(paper.payload.sections.map((s) => s.sourceId).filter((v): v is string => Boolean(v)))];
      const sourceById = new Map<string, { title: string; content_text: string | null }>();
      for (const sourceId of sourceIds) {
        const source = await repos.l3Context.findSourceById(userId, sourceId);
        if (source) sourceById.set(sourceId, { title: source.title, content_text: source.content_text ?? null });
      }

      const sections: L3AssembledSection[] = paper.payload.sections.map((section) => {
        const found = section.questionIds
          .map((id) => questionsById.get(id))
          .filter((q): q is L3QuestionRow => Boolean(q));
        const missingIds = section.questionIds.filter((id) => !questionsById.has(id));
        const sourceInfo = section.sourceId ? sourceById.get(section.sourceId) ?? null : null;
        if (section.sourceId && !sourceInfo) {
          return { ...section, missing: true, missing_reason: "source", source_title: null, source_content: null, questions: found };
        }
        if (missingIds.length > 0) {
          return { ...section, missing: true, missing_reason: "questions", source_title: sourceInfo?.title ?? null, source_content: sourceInfo?.content_text ?? null, questions: found };
        }
        return {
          ...section,
          missing: false,
          source_title: sourceInfo?.title ?? null,
          source_content: sourceInfo?.content_text ?? null,
          questions: found,
        };
      });

      return { ...paper, sections };
    });
  }

  /** 删题护栏③：active 卷面引用中的题 / 被作文任务引用的题不可删，409 带引用清单（中文化在 HTTP 层）。 */
  async deleteQuestion(input: DeleteL3QuestionInput): Promise<{ deleted: true }> {
    return this.withActor(input.userId, async (repos) => {
      const question = await repos.l3Paper.findQuestionById(input.userId, input.questionId);
      if (!question) throw new NotFoundError("L3Question", input.questionId);

      // 护栏③-b（作文子空间 V1，W2）：被当前 owner 写作任务引用的题不可删。
      // owner 作用域查询，返回信息不含任何他人数据（不泄露）；沿用 papers blocker 风格。
      const writingRefs = await repos.l3Paper.listWritingTaskRefs(input.userId, input.questionId);
      if (writingRefs.length > 0) {
        throw new ConflictError("Cannot delete L3 question referenced by an active writing task", undefined, {
          entityType: "question",
          id: input.questionId,
          blockers: { writingTasks: writingRefs.map((t) => ({ id: t.id, title: t.title })) },
        });
      }

      const papers = await repos.l3Paper.listActivePaperRefsWithPayload(input.userId);
      const blockers = papers
        .filter((paper) => {
          const payload = paper.payload as Partial<L3PaperPayload> | null;
          return Array.isArray(payload?.sections)
            && payload.sections.some((section) => Array.isArray(section.questionIds) && section.questionIds.includes(input.questionId));
        })
        .map((paper) => ({ id: paper.id, title: paper.title }));
      if (blockers.length > 0) {
        throw new ConflictError("Cannot delete L3 question referenced by active papers", undefined, {
          entityType: "question",
          id: input.questionId,
          blockers: { papers: blockers },
        });
      }
      await repos.l3Paper.deleteQuestion(input.userId, input.questionId);
      return { deleted: true };
    });
  }
}
