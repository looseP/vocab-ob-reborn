/**
 * 评析区（l3_question_assessments）domain 契约（批次二增补，ADR-0034 v2 条 10/11）。
 *
 * 一题一条的 owner/agent 共建沉淀：latest-wins 无历史版本（last_editor +
 * updated_at 留痕兜底）；挂题不挂题纸（跨题纸、跨 venue 永存）；与总结条双轨
 * （总结条管场次、评析区管题目）。agent 首个可写持久区（Amends ADR-0029，
 * 开口严格限于本区）；注记内容与 attempts 不可写红线不变。
 */
import { z } from "zod";

/** 评析正文上限（20k 字符；设计卡 v2 §11 定稿）。 */
export const ASSESSMENT_CONTENT_MAX = 20_000;

export const ASSESSMENT_EDITORS = ["owner", "agent"] as const;
export type AssessmentEditor = (typeof ASSESSMENT_EDITORS)[number];

/** PUT upsert 输入（strict；trim 后非空——评析是有内容的沉淀，空文不作清除语义）。 */
export const assessmentUpsertInputSchema = z.object({
  contentMd: z.string().trim().min(1).max(ASSESSMENT_CONTENT_MAX),
}).strict();

export type AssessmentUpsertInput = z.infer<typeof assessmentUpsertInputSchema>;
