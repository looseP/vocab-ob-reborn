/**
 * L3PaperService — 题目/试卷入库与卷面组装（ADR-0030）。
 *
 * 边界：只碰 l3_questions/l3_papers 与 l3_sources/l3_source_spaces（自动打标）。
 * 不碰 context/occurrence、不碰 FSRS、不引入 LLM。owner 直写面（V1）；agent
 * 双级（pending/trusted 直写）后续波次在同一代码路径按角色分叉。
 */

import type { PoolClient } from "pg";
import { ConflictError, NotFoundError, ValidationError, isForeignKeyViolation } from "../errors";
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
  type L3EvidenceAnchor,
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
  UpdateL3PaperInput,
  UpdateL3PaperSectionInput,
  UpdateL3QuestionInput,
} from "../schemas/service";

type TxRunner = typeof withTransaction;
type RepositoryFactory = (tx?: PoolClient) => IRepositories;

const DIRECTIONS = ["通用", "考研", "雅思"] as const;

/**
 * 证据锚点归一（2026-09-26）。形状已由 HTTP schema 把关（start/end/label +
 * end>start）；这里做**读侧同一份**的防御性归一，让 service 层的两个调用点
 * （createPaper 逐题 / updateQuestion）不必各自重复 cast。
 * 保持顺序（阅读顺序 = 证据出现顺序），去重按 (start,end,label)。
 */
function normalizeEvidence(input: readonly L3EvidenceAnchor[]): L3EvidenceAnchor[] {
  const seen = new Set<string>();
  const out: L3EvidenceAnchor[] = [];
  for (const anchor of input) {
    const label = anchor.label.trim();
    if (!Number.isInteger(anchor.start) || !Number.isInteger(anchor.end)) continue;
    if (anchor.start < 0 || anchor.end <= anchor.start || label.length === 0) continue;
    const key = `${anchor.start}:${anchor.end}:${label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ start: anchor.start, end: anchor.end, label });
  }
  return out;
}

/** 越界证据当场 422：正文长度是用户可核对的事实，错误信息必须带上它。 */
function assertEvidenceWithinText(
  evidence: readonly L3EvidenceAnchor[],
  textLength: number,
  sourceId: string,
): void {
  const outOfRange = evidence.find((anchor) => anchor.end > textLength);
  if (outOfRange) {
    throw new ValidationError(
      `evidence 越界：正文长度 ${textLength}，但锚点 end=${outOfRange.end}（sourceId=${sourceId}）`,
      "evidence",
    );
  }
}

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

  private withActor<T>(userId: string, callback: (repos: IRepositories, tx: PoolClient) => Promise<T>): Promise<T> {
    return this.txRunner(async (tx) => callback(this.repositoryFactory(tx), tx), { actorId: userId });
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

  /**
   * 改题面（2026-09-26）。
   *
   * 为什么需要：改题面此前**没有出口**——`deleteQuestion` 对"被 active 卷面/作文
   * 任务/学习笔记引用"的题返 409，于是「卷面里一道题有错字」既不能改也不能删，
   * 是个死胡同。
   *
   * 护栏（题面冻结，与删题同族但更宽——允许"没人做过"的题改）：
   *  - **已有作答历史 → 409**：attempts 记的是"当时那道题"的作答与判分；改题面
   *    等于让历史描述另一道题（与 ADR-0034「attempt 只存作答事实、判定归
   *    grading_results」同源的不变式：判定的对象必须稳定）。
   *  - **被作文任务引用 → 409**：题面冻结是《writing-workspace》§2 的钉死条款
   *    （改题面 = 新任务）。
   *  - **被学习笔记引用 → 放行**：那正是 N2 chain01 的 `field_hash` → `changed`
   *    机制存在的理由（引用快照不变、状态转为"底层已改"并提示），拦下来反而
   *    让机制无从触发。
   *  - 被 active 卷面引用但无人作答 → 放行（题单在开纸时已定格，见 0046；改题面
   *    不改变任何已定格的题单）。
   */
  async updateQuestion(input: UpdateL3QuestionInput): Promise<{ question: L3QuestionRow }> {
    requireNonEmpty(input.userId, "userId");
    requireNonEmpty(input.stem, "stem");

    return this.withActor(input.userId, async (repos) => {
      const existing = await repos.l3Paper.findQuestionById(input.userId, input.questionId);
      if (!existing) throw new NotFoundError("L3Question", input.questionId);
      if (existing.status !== "active") {
        throw new ConflictError("Only active questions can be edited", undefined, {
          entityType: "question",
          id: input.questionId,
          status: existing.status,
        });
      }

      const attemptCount = await repos.l3Paper.countQuestionAttempts(input.userId, input.questionId);
      if (attemptCount > 0) {
        throw new ConflictError(
          "Cannot edit a question that already has answer history（答案历史不可改写；请复制为新题）",
          undefined,
          {
            entityType: "question",
            id: input.questionId,
            blockers: { attempts: attemptCount },
          },
        );
      }

      const writingRefs = await repos.l3Paper.listWritingTaskRefs(input.userId, input.questionId);
      if (writingRefs.length > 0) {
        throw new ConflictError("Cannot edit a question referenced by an active writing task", undefined, {
          entityType: "question",
          id: input.questionId,
          blockers: { writingTasks: writingRefs.map((t) => ({ id: t.id, title: t.title })) },
        });
      }

      // 证据锚点：形状已由 HTTP schema 把关；这里补**越界**检查——offset 落在材料
      // 正文之外时，读侧只会静默丢弃该锚点（buildPassageSpans.validRange），
      // 那等于用户白填一个证据。改为当场 422 并说清正文长度。
      const evidence = normalizeEvidence(input.evidence ?? []);
      if (evidence.length > 0 && existing.source_id) {
        const source = await repos.l3Context.findSourceById(input.userId, existing.source_id);
        const textLength = source?.content_text?.length ?? null;
        if (textLength !== null) assertEvidenceWithinText(evidence, textLength, existing.source_id);
      }

      const question = await repos.l3Paper.updateQuestion({
        question_id: input.questionId,
        user_id: input.userId,
        stem: input.stem.trim(),
        options: (input.options ?? []) as unknown as Json,
        answer: (input.answer ?? {}) as Json,
        explanation: input.explanation?.trim() || null,
        evidence: evidence as unknown as Json,
        ordinal: Number.isInteger(input.ordinal) && (input.ordinal as number) >= 0 ? (input.ordinal as number) : existing.ordinal,
        input_hash: existing.input_hash,
      });
      if (!question) {
        // 条件 UPDATE 落空 = 并发下状态已变（被删/被驳回）：与删题同款二次判别。
        const latest = await repos.l3Paper.findQuestionById(input.userId, input.questionId);
        if (!latest) throw new NotFoundError("L3Question", input.questionId);
        throw new ConflictError("L3 question is no longer active", undefined, {
          entityType: "question",
          id: input.questionId,
          status: latest.status,
        });
      }
      return { question };
    });
  }

  /**
   * 改卷（2026-09-26）：标题/方向/元信息/**题单引用**。题单改动让"从卷里换掉一道题"
   * 成为可能（此前只能删卷重建）。归属与形状双校验：payload 过
   * `validatePaperPayloadShape`，且所有 questionId 必须是**本 owner 的 active 题**
   * （别人的题 id 猜到了也塞不进来）。
   */
  async updatePaper(input: UpdateL3PaperInput): Promise<{ paper: L3PaperRow }> {
    requireNonEmpty(input.userId, "userId");
    requireNonEmpty(input.title, "title");
    const direction = trimOrNull(input.direction ?? null) as (typeof DIRECTIONS)[number] | null;
    if (direction) requireEnum(direction, DIRECTIONS, "direction");
    const payload: L3PaperPayload = {
      version: PAPER_PAYLOAD_VERSION,
      sections: (input.sections ?? []) as L3PaperPayload["sections"],
    };
    if (payload.sections.length === 0) {
      throw new ValidationError("试卷至少包含一个 section", "sections");
    }
    validatePaperPayloadShape(payload);

    return this.withActor(input.userId, async (repos) => {
      const existing = await repos.l3Paper.findPaperById(input.userId, input.paperId);
      if (!existing) throw new NotFoundError("L3Paper", input.paperId);
      if (existing.status !== "active") {
        throw new ConflictError("Only active papers can be edited", undefined, {
          entityType: "paper",
          id: input.paperId,
          status: existing.status,
        });
      }

      const questionIds = [...new Set(payload.sections.flatMap((section) => section.questionIds))];
      const owned = await repos.l3Paper.findActiveQuestionsByIds(input.userId, questionIds);
      if (owned.length !== questionIds.length) {
        throw new ValidationError(
          "sections 引用了不存在、非 active 或不属主的题目",
          "sections",
        );
      }

      const paper = await repos.l3Paper.updatePaper({
        paper_id: input.paperId,
        user_id: input.userId,
        title: input.title.trim(),
        direction,
        metadata: (input.metadata ?? existing.metadata) as Json,
        payload: payload as unknown as { version: number; sections: unknown[] },
        input_hash: existing.input_hash,
      });
      if (!paper) {
        const latest = await repos.l3Paper.findPaperById(input.userId, input.paperId);
        if (!latest) throw new NotFoundError("L3Paper", input.paperId);
        throw new ConflictError("L3 paper is no longer active", undefined, {
          entityType: "paper",
          id: input.paperId,
          status: latest.status,
        });
      }
      return { paper };
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
    return this.withActor(input.userId, async (repos, tx) => {
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

      // 学习笔记引用保护（N1）：与 capture 取同一把 advisory 锁（l3_question:<id>）
      // 串行化并发窗口，再查可读 blocker（capture 先提交 → 本查询可见；本删除先执行
      // → capture 的引用插入 FK 失败 23503）。FK RESTRICT 于 catch 分支兜底转 409。
      await repos.studyReferences.lockTargets(input.userId, [{ kind: "question", id: input.questionId }]);
      const noteBlockers = await repos.studyReferences.getQuestionDeleteBlockers(input.userId, input.questionId);
      if (noteBlockers.length > 0) {
        throw questionStudyNoteConflict(input.questionId, noteBlockers);
      }

      // F1：FK 兜底必须先恢复失败事务（保存点）再重查 blocker——aborted 事务内查询
      // 会得到 25P02，丢失约定的 409 合同。保存点名称为静态常量、不从请求插值。
      await tx.query("SAVEPOINT study_note_delete");
      try {
        await repos.l3Paper.deleteQuestion(input.userId, input.questionId);
      } catch (error) {
        if (isForeignKeyViolation(error)) {
          await tx.query("ROLLBACK TO SAVEPOINT study_note_delete");
          await tx.query("RELEASE SAVEPOINT study_note_delete");
          const latestNoteBlockers = await repos.studyReferences.getQuestionDeleteBlockers(input.userId, input.questionId);
          if (latestNoteBlockers.length > 0) {
            throw questionStudyNoteConflict(input.questionId, latestNoteBlockers);
          }
          // 无匹配 blocker：保持原错误语义（不伪造笔记阻塞）
        }
        throw error;
      }
      await tx.query("RELEASE SAVEPOINT study_note_delete");
      return { deleted: true };
    });
  }
}

/** 学习笔记引用阻止 question 删除（N1）：可读笔记标题/引用数 + 处理入口提示。 */
function questionStudyNoteConflict(
  questionId: string,
  noteBlockers: readonly { note_id: string; title: string; status: string; reference_count: number }[],
): ConflictError {
  return new ConflictError("Cannot delete L3 question referenced by study notes", undefined, {
    entityType: "question",
    id: questionId,
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
