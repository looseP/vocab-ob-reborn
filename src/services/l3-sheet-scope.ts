/**
 * 题纸作用域题集解析（批次二共享）：file=题组（ordinal 序）；paper=payload
 * sections 顺序（现拉现组装）。sheet 与 export 两个 service 共用同一实现——
 * 作用域语义只有一处（不复制、不漂移，ADR-0025 单一代码路径纪律）。
 */
import type { IRepositories } from "../repositories/interfaces";
import type { L3QuestionRow, L3SubmissionRow } from "../domain";

export async function resolveSheetScopedQuestions(
  repos: IRepositories,
  userId: string,
  sheet: L3SubmissionRow,
): Promise<L3QuestionRow[]> {
  if (sheet.scope === "file" && sheet.source_id && sheet.question_type) {
    return repos.l3Paper.listActiveQuestionsForFile(userId, {
      sourceId: sheet.source_id,
      questionType: sheet.question_type,
    });
  }
  if (sheet.scope === "paper" && sheet.paper_id) {
    const paper = await repos.l3Paper.findPaperById(userId, sheet.paper_id);
    if (!paper) return [];
    const ids = paper.payload.sections.flatMap((section) => section.questionIds);
    const questions = await repos.l3Paper.findActiveQuestionsByIds(userId, ids);
    const byId = new Map(questions.map((question) => [question.id, question]));
    return ids.map((id) => byId.get(id)).filter((question): question is L3QuestionRow => Boolean(question));
  }
  return [];
}
