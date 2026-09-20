/**
 * 学习笔记导航参数模型（Task 08）——URL 契约单一真源。
 *
 * 规范 URL：`/l3?section=study-notes[&venue=<questionType>][&topicId=<uuid>][&noteId=<uuid>][&refId=<uuid>]`
 * 纪律：
 *  - `section=study-notes` 优先于旧 venue/file 深链（L3Page 只触发一个导航 effect，不互抢）；
 *  - `parseStudyNoteNavigation` 严格校验（venue 枚举 / UUID 归一），返回已验证对象 + 结构化错误；
 *  - `noteId` 必须有合法 `venue`：否则 = 无效入口（结构化错误，不静默纠偏）；
 *  - `buildStudyNoteUrl` 唯一构造入口（parse ∘ build = 恒等；测试双向一致）。
 */
import { L3_QUESTION_TYPES, type L3QuestionType } from "@/domain/l3-question-types";

export const STUDY_NOTES_SECTION = "study-notes";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type StudyNoteNavigationErrorCode =
  | "venue_invalid"
  | "topic_id_invalid"
  | "note_id_invalid"
  | "ref_id_invalid"
  | "note_requires_venue";

export interface StudyNoteNavigationError {
  code: StudyNoteNavigationErrorCode;
  field: "venue" | "topicId" | "noteId" | "refId";
  value: string;
}

export interface StudyNoteNavigation {
  /** section 参数是否指向学习笔记。 */
  isStudyNotes: boolean;
  venue: L3QuestionType | null;
  topicId: string | null;
  noteId: string | null;
  refId: string | null;
  /** 结构化错误（消费方按需显示；不静默纠偏）。 */
  errors: StudyNoteNavigationError[];
  /** 无效入口：noteId 组合非法（非 UUID / 缺 venue）——显示无效入口空态，不创建、不加载。 */
  invalidEntry: boolean;
}

function trimmed(value: string | null): string | null {
  if (value == null) return null;
  const next = value.trim();
  return next.length > 0 ? next : null;
}

function parseUuidField(
  raw: string | null,
  field: StudyNoteNavigationError["field"],
  code: StudyNoteNavigationErrorCode,
  errors: StudyNoteNavigationError[],
): string | null {
  const value = trimmed(raw);
  if (value === null) return null;
  if (!UUID_PATTERN.test(value)) {
    errors.push({ code, field, value });
    return null;
  }
  return value.toLowerCase();
}

export function parseStudyNoteNavigation(search: URLSearchParams): StudyNoteNavigation {
  const errors: StudyNoteNavigationError[] = [];

  const section = trimmed(search.get("section"));
  const isStudyNotes = section === STUDY_NOTES_SECTION;

  const venueRaw = trimmed(search.get("venue"));
  let venue: L3QuestionType | null = null;
  if (venueRaw !== null) {
    if ((L3_QUESTION_TYPES as readonly string[]).includes(venueRaw)) {
      venue = venueRaw as L3QuestionType;
    } else {
      errors.push({ code: "venue_invalid", field: "venue", value: venueRaw });
    }
  }

  const topicId = parseUuidField(search.get("topicId"), "topicId", "topic_id_invalid", errors);
  const noteId = parseUuidField(search.get("noteId"), "noteId", "note_id_invalid", errors);
  const refId = parseUuidField(search.get("refId"), "refId", "ref_id_invalid", errors);

  if (noteId !== null && venue === null) {
    errors.push({ code: "note_requires_venue", field: "venue", value: venueRaw ?? "" });
  }

  const invalidEntry = errors.some(
    (error) => error.code === "note_id_invalid" || error.code === "note_requires_venue",
  );

  return { isStudyNotes, venue, topicId, noteId, refId, errors, invalidEntry };
}

export function isStudyNotesSection(search: URLSearchParams): boolean {
  return trimmed(search.get("section")) === STUDY_NOTES_SECTION;
}

export interface StudyNoteUrlInput {
  venue?: L3QuestionType | null;
  topicId?: string | null;
  noteId?: string | null;
  refId?: string | null;
}

/** 唯一构造入口：只输出非空参数；顺序稳定（section → venue → topicId → noteId → refId）。 */
export function buildStudyNoteUrl(input: StudyNoteUrlInput = {}): string {
  const search = new URLSearchParams();
  search.set("section", STUDY_NOTES_SECTION);
  if (input.venue) search.set("venue", input.venue);
  if (input.topicId) search.set("topicId", input.topicId);
  if (input.noteId) search.set("noteId", input.noteId);
  if (input.refId) search.set("refId", input.refId);
  return `/l3?${search.toString()}`;
}
