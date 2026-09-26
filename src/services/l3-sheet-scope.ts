/**
 * 题纸作用域题集解析（批次二共享）：file=题组（ordinal 序）；paper=payload
 * sections 顺序（现拉现组装）；writing=任务单题（W3：只读解析，不触发创建）。
 * sheet 与 export 两个 service 共用同一实现——作用域语义只有一处（不复制、
 * 不漂移，ADR-0025 单一代码路径纪律）。
 *
 * 题单快照优先（2026-09-26）：`l3_submissions.question_ids` 非空时它是**唯一**
 * 题集来源——开纸后题组加题/删题都不再改变这张已开的题纸（否则交卷物化与
 * 评卷读面会看到不同的卷）。`null`（历史行 / 写作草稿另路）才回退按作用域现拉。
 */
import type { IRepositories } from "../repositories/interfaces";
import type { L3QuestionRow, L3SubmissionRow } from "../domain";

export async function resolveSheetScopedQuestions(
  repos: IRepositories,
  userId: string,
  sheet: L3SubmissionRow,
): Promise<L3QuestionRow[]> {
  if (sheet.question_ids && sheet.question_ids.length > 0) {
    return orderByFrozenIds(repos, userId, sheet.question_ids);
  }
  if (sheet.scope === "file" && sheet.source_id && sheet.question_type) {
    return repos.l3Paper.listActiveQuestionsForFile(userId, {
      sourceId: sheet.source_id,
      questionType: sheet.question_type,
    });
  }
  if (sheet.scope === "paper" && sheet.paper_id) {
    const paper = await repos.l3Paper.findPaperById(userId, sheet.paper_id);
    if (!paper) return [];
    return orderByFrozenIds(repos, userId, paper.payload.sections.flatMap((section) => section.questionIds));
  }
  if (sheet.scope === "writing" && sheet.writing_task_id) {
    // 作文（W3）：作用域 = 任务关联的题（题面引用式，单题）。只读解析——不建纸、
    // 不写库；task→question 经只读查询（W6 注册 l3Writing 后可改道写作 repo）。
    const questionId = await repos.l3Sheets.findWritingTaskQuestionId(userId, sheet.writing_task_id);
    if (!questionId) return [];
    const question = await repos.l3Paper.findQuestionById(userId, questionId);
    return question ? [question] : [];
  }
  return [];
}

/**
 * 按快照顺序解析题目。快照里已删除/非 active 的题被**剔除**而不是替换成别的题
 * ——题单只缩不换（用户看到的范围只会变窄，不会凭空多出没做的题）。
 */
async function orderByFrozenIds(
  repos: IRepositories,
  userId: string,
  ids: readonly string[],
): Promise<L3QuestionRow[]> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return [];
  const questions = await repos.l3Paper.findActiveQuestionsByIds(userId, unique);
  const byId = new Map(questions.map((question) => [question.id, question]));
  return unique.map((id) => byId.get(id)).filter((question): question is L3QuestionRow => Boolean(question));
}
