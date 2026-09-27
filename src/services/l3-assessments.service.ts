/**
 * L3AssessmentService — 评析区编排（批次二增补，ADR-0034 v2 条 10/11）。
 *
 * agent 首个可写持久区（Amends ADR-0029）：GET/PUT 同一端点双身份，last_editor
 * 按服务端认定的 actor role 留痕。挂题不挂题纸——归属校验借道 l3Paper
 * （findQuestionById；RLS 已隔离，他人题表现为不存在 → 404）。
 */
import type { PoolClient } from "pg";
import { NotFoundError } from "../errors";
import { withTransaction } from "../db/transaction";
import { createRepositories } from "../repositories/factory";
import type { IRepositories, IL3AssessmentRepository, IL3PaperRepository } from "../repositories/interfaces";
import type { L3QuestionAssessmentRow } from "../domain";
import { ASSESSMENT_LIST_MAX_IDS } from "../domain/l3-assessments";
import type { PutL3AssessmentInput } from "../schemas/service";

type TxRunner = typeof withTransaction;
type RepositoryFactory = (tx?: PoolClient) => IRepositories;

export class L3AssessmentService {
  constructor(
    private readonly assessmentRepo: IL3AssessmentRepository,
    private readonly paperRepo: IL3PaperRepository,
    private readonly txRunner: TxRunner = withTransaction,
    private readonly repositoryFactory: RepositoryFactory = createRepositories,
  ) {}

  private withActor<T>(userId: string, callback: (repos: IRepositories) => Promise<T>): Promise<T> {
    return this.txRunner(async (tx) => callback(this.repositoryFactory(tx)), { actorId: userId });
  }

  /** GET（无则空态 item:null）：题归属校验 404 语义同批次一。 */
  async getAssessment(userId: string, questionId: string): Promise<{ item: L3QuestionAssessmentRow | null }> {
    return this.withActor(userId, async (repos) => {
      const question = await repos.l3Paper.findQuestionById(userId, questionId);
      if (!question) throw new NotFoundError("L3Question", questionId);
      return { item: await repos.l3Assessments.findByQuestion(userId, questionId) };
    });
  }

  /**
   * 批量读（1–200 题）：本卷题目的评析。
   *
   * 存在理由是**计数**：卷面（父层）要回答「这一卷有几条评析被纯净模式隐藏了」，
   * 而单题 GET 只能一条条问、要 N 个请求。批量口让「声明条里的数字」与「解析档渲染
   * 的内容」来自同一次读 —— 否则计数与渲染可能读到不同时刻的两种事实（S-1 的声明
   * 会与实际不符，而那比不声明更坏：用户会以为评析真的丢了）。
   *
   * 归属：不做逐题 `findQuestionById` 校验（同 `l3Annotations.listForQuestions`）——
   * SQL 按 `user_id` 过滤 + RLS 隔离，他人的评析天然读不出来；为省 N 次往返而放宽到
   * 「读不到即不存在」，与单题 GET 的 404 语义在结果上一致。
   */
  async listForQuestions(
    userId: string,
    questionIds: readonly string[],
  ): Promise<{ items: L3QuestionAssessmentRow[] }> {
    const ids = [...new Set(questionIds)].slice(0, ASSESSMENT_LIST_MAX_IDS);
    if (ids.length === 0) return { items: [] };
    return this.withActor(userId, async (repos) => ({
      items: await repos.l3Assessments.listByQuestions(userId, ids),
    }));
  }

  /** PUT upsert（latest-wins）：last_editor 按服务端认定的 actor 身份（owner/agent 双身份）。 */  async putAssessment(input: PutL3AssessmentInput): Promise<{ item: L3QuestionAssessmentRow }> {
    return this.withActor(input.userId, async (repos) => {
      const question = await repos.l3Paper.findQuestionById(input.userId, input.questionId);
      if (!question) throw new NotFoundError("L3Question", input.questionId);
      const item = await repos.l3Assessments.upsert({
        user_id: input.userId,
        question_id: input.questionId,
        content_md: input.contentMd,
        last_editor: input.editor,
      });
      return { item };
    });
  }
}
