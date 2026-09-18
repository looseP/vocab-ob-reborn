/**
 * 作文子空间 repo 层行类型（W1 冻结，ADR《writing-workspace》§1/§5）。
 * DB row 形状（snake_case）仅在本文件与 repository 实现层出现；HTTP 面一律
 * 经 DTO 映射（domain/l3-writing.ts），不把 row 直接暴露。
 */
import type { Json } from "../domain";
import type {
  WritingDirection,
  WritingKind,
  WritingTaskStatus,
} from "../domain/l3-writing";

/** l3_writing_tasks 行（题面引用式：question_id 为唯一题面真源）。 */
export interface L3WritingTaskRow {
  id: string;
  user_id: string;
  question_id: string;
  title: string;
  kind: WritingKind;
  direction: WritingDirection;
  status: WritingTaskStatus;
  /** 客户端一次创建意图的 UUID（幂等；失败重试沿用，成功后才换）。 */
  create_request_id: string;
  /** 规范化创建输入 hash（同 requestId 不同输入 → 409；不随 title 变化）。 */
  create_input_hash: string;
  created_at: string;
  updated_at: string;
}

/** l3_writing_feedback 行（一稿一条 latest-wins；无历史版本）。 */
export interface L3WritingFeedbackRow {
  id: string;
  user_id: string;
  sheet_id: string;
  /** SHA256(UTF-8(NORMALIZE_LF(原样正文)))——绑定精确稿。 */
  text_sha256: string;
  schema_version: number;
  feedback: Json;
  version: number;
  /** 本次写入请求 id（同 requestId 同内容重传 → 200 不升版）。 */
  request_id: string;
  /** 服务端按 Principal 认定（owner / agent:<agentId>），不信请求体。 */
  last_editor: string;
  created_at: string;
  updated_at: string;
}
