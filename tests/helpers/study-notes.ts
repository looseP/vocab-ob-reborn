/**
 * 学习笔记（N1）纯 fixture —— 固定 UUID 与输入数据。
 * 零依赖、不启动数据库、不读环境变量（DB fixture 见 study-notes-db.ts）。
 */

export const STUDY_OWNER = "00000000-0000-4000-8000-0000000000a1";
export const STUDY_OWNER_B = "00000000-0000-4000-8000-0000000000a2";

/** 引用 id 固定锚（执行计划指定）。 */
export const REF = "00000000-0000-4000-8000-000000000001";
export const REF_B = "00000000-0000-4000-8000-000000000002";
export const REF_C = "00000000-0000-4000-8000-000000000003";

export const NOTE_ID = "00000000-0000-4000-8000-000000000101";
export const NOTE_ID_B = "00000000-0000-4000-8000-000000000102";
export const TOPIC_ID = "00000000-0000-4000-8000-000000000111";
export const REQUEST_ID = "00000000-0000-4000-8000-000000000121";
export const REQUEST_ID_B = "00000000-0000-4000-8000-000000000122";

export const SOURCE_ID = "00000000-0000-4000-8000-000000000201";
export const SOURCE_ID_B = "00000000-0000-4000-8000-000000000202";
export const QUESTION_ID = "00000000-0000-4000-8000-000000000211";
export const QUESTION_ID_B = "00000000-0000-4000-8000-000000000212";

/** 正文引用标记字面量（与 domain 标记语法一致；测试内不用字符串拼接散布）。 */
export function marker(refId: string): string {
  return `[[ref:${refId}]]`;
}
