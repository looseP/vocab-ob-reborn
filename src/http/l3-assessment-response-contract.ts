/**
 * 评析区 HTTP 响应契约（批次二增补，0035）。
 *
 * GET 无行时 item 显式为 null（空态，非 404——题存在但没有评析是合法状态）；
 * 行字段沿用仓库 snake_case 惯例。
 */
import { z } from "zod";
import { ASSESSMENT_EDITORS } from "@/domain/l3-assessments";

export const l3AssessmentResponseSchema = z.object({
  id: z.string().uuid(),
  user_id: z.string().uuid(),
  question_id: z.string().uuid(),
  content_md: z.string(),
  last_editor: z.enum(ASSESSMENT_EDITORS),
  created_at: z.string(),
  updated_at: z.string(),
}).strict();

/** GET（空态 item:null）与 PUT 的响应。 */
export const l3AssessmentItemResponseSchema = z.object({
  item: l3AssessmentResponseSchema.nullable(),
}).strict();
