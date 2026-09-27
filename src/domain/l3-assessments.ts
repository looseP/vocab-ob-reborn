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

/**
 * GET /l3/question-assessments?questionIds=<uuid,uuid,...> 的 query 契约（1–200 个 uuid）。
 *
 * **为什么需要批量口**（2026-09-27）：原本只有单题 `GET /questions/:id/assessment`，
 * 于是「本卷有几条评析」在卷面里**数不出来** —— 父层拿不到事实，纯净模式就不敢按
 * S-1「隐藏必须自带声明」去隐藏评析（数不出就无法在声明条里如实告知）。批量口把
 * 「计数」与「渲染」变成**同一份数据**，那条登记在案的偏离才得以关闭。
 *
 * 口径沿原文分析条目（`l3QuestionAnnotationListQuerySchema`）：CSV 查询串、1–200 上限、
 * 逐个校 uuid。不复用注记那条 schema —— 两条端点的上限将来可能各自调，绑在一起就成了
 * 隐式耦合。
 */
export const assessmentListQuerySchema = z.object({
  questionIds: z.string().trim().min(1).max(12_000)
    .transform((raw) => raw.split(",").map((value) => value.trim()).filter(Boolean))
    .refine((ids) => ids.length >= 1 && ids.length <= 200, { message: "questionIds 必须为 1–200 个 uuid" })
    .refine((ids) => ids.every((id) => z.string().uuid().safeParse(id).success), { message: "questionIds 需全为 uuid" }),
});

/** 批量评析的题目数上限（与 query 契约同值；service 侧再兜一层，防绕过 schema 的调用）。 */
export const ASSESSMENT_LIST_MAX_IDS = 200;
