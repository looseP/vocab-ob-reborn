/**
 * Task 08 · 学习笔记导航模型测试（先红后绿）。
 *
 * 覆盖 URL 合同（§3.2）：section 优先、字段严格校验、noteId 无效入口、
 * build/parse 双向一致、与旧 venue/file 参数共存不互抢。
 */
import { describe, expect, it } from "vitest";
import {
  buildStudyNoteUrl,
  isStudyNotesSection,
  parseStudyNoteNavigation,
  STUDY_NOTES_SECTION,
} from "@/frontend/viewModels/studyNoteNavigation";

const NOTE_ID = "00000000-0000-4000-8000-000000000701";
const TOPIC_ID = "00000000-0000-4000-8000-000000000801";
const REF_ID = "00000000-0000-4000-8000-000000000802";

function parse(query: string) {
  return parseStudyNoteNavigation(new URLSearchParams(query));
}

describe("studyNoteNavigation · parse", () => {
  it("空参数：非学习笔记（section 未给出），全部字段为 null，无错误", () => {
    const nav = parse("");
    expect(nav.isStudyNotes).toBe(false);
    expect(nav.venue).toBeNull();
    expect(nav.topicId).toBeNull();
    expect(nav.noteId).toBeNull();
    expect(nav.refId).toBeNull();
    expect(nav.errors).toEqual([]);
    expect(nav.invalidEntry).toBe(false);
  });

  it("section=study-notes + venue：isStudyNotes=true，venue 解析", () => {
    const nav = parse(`section=${STUDY_NOTES_SECTION}&venue=cloze`);
    expect(nav.isStudyNotes).toBe(true);
    expect(nav.venue).toBe("cloze");
    expect(nav.errors).toEqual([]);
  });

  it("非法 venue：记录结构化错误；noteId 存在时构成无效入口", () => {
    const nav = parse(`section=${STUDY_NOTES_SECTION}&venue=bogus&noteId=${NOTE_ID}`);
    expect(nav.venue).toBeNull();
    expect(nav.errors.map((e) => e.code)).toEqual(["venue_invalid", "note_requires_venue"]);
    expect(nav.invalidEntry).toBe(true);
  });

  it("非法 venue 且无 noteId：仅记录错误，不构成无效入口（回落到题型选择）", () => {
    const nav = parse(`section=${STUDY_NOTES_SECTION}&venue=bogus`);
    expect(nav.errors.map((e) => e.code)).toEqual(["venue_invalid"]);
    expect(nav.invalidEntry).toBe(false);
  });

  it("非法 noteId（非 UUID）：无效入口，不静默纠偏", () => {
    const nav = parse(`section=${STUDY_NOTES_SECTION}&venue=cloze&noteId=not-a-uuid`);
    expect(nav.noteId).toBeNull();
    expect(nav.errors.map((e) => e.code)).toEqual(["note_id_invalid"]);
    expect(nav.invalidEntry).toBe(true);
  });

  it("noteId 缺少 venue：无效入口（note_requires_venue）", () => {
    const nav = parse(`section=${STUDY_NOTES_SECTION}&noteId=${NOTE_ID}`);
    expect(nav.noteId).toBe(NOTE_ID);
    expect(nav.errors.map((e) => e.code)).toEqual(["note_requires_venue"]);
    expect(nav.invalidEntry).toBe(true);
  });

  it("topicId / refId：合法 UUID 归一为小写；非法值记录错误但保留其余字段", () => {
    const upper = TOPIC_ID.toUpperCase();
    const nav = parse(`section=${STUDY_NOTES_SECTION}&venue=cloze&topicId=${upper}&refId=${REF_ID}`);
    expect(nav.topicId).toBe(TOPIC_ID);
    expect(nav.refId).toBe(REF_ID);
    expect(nav.errors).toEqual([]);

    const bad = parse(`section=${STUDY_NOTES_SECTION}&venue=cloze&topicId=nope&refId=${REF_ID}`);
    expect(bad.topicId).toBeNull();
    expect(bad.refId).toBe(REF_ID);
    expect(bad.errors.map((e) => e.code)).toEqual(["topic_id_invalid"]);
    expect(bad.invalidEntry).toBe(false);
  });

  it("旧深链参数（venue/file/sheet/paper）与 section=study-notes 共存：本次只消费学习笔记字段", () => {
    const nav = parse(`section=${STUDY_NOTES_SECTION}&venue=cloze&file=abc&sheet=${NOTE_ID}&paper=x`);
    expect(nav.isStudyNotes).toBe(true);
    expect(nav.venue).toBe("cloze");
    // file/sheet/paper 不属于本模型字段，解析结果不含它们（不互相覆盖）
    expect(Object.keys(nav)).not.toContain("file");
    expect(Object.keys(nav)).not.toContain("sheet");
  });

  it("isStudyNotesSection 仅当 section 精确等于 study-notes", () => {
    expect(isStudyNotesSection(new URLSearchParams(`section=${STUDY_NOTES_SECTION}`))).toBe(true);
    expect(isStudyNotesSection(new URLSearchParams("section=writing"))).toBe(false);
    expect(isStudyNotesSection(new URLSearchParams("venue=cloze"))).toBe(false);
  });
});

describe("studyNoteNavigation · build", () => {
  it("只输出非空参数，顺序稳定（section → venue → topicId → noteId → refId）", () => {
    expect(buildStudyNoteUrl({})).toBe(`/l3?section=${STUDY_NOTES_SECTION}`);
    expect(buildStudyNoteUrl({ venue: "cloze", noteId: NOTE_ID })).toBe(
      `/l3?section=${STUDY_NOTES_SECTION}&venue=cloze&noteId=${NOTE_ID}`,
    );
    expect(buildStudyNoteUrl({ venue: "cloze", topicId: TOPIC_ID, refId: REF_ID })).toBe(
      `/l3?section=${STUDY_NOTES_SECTION}&venue=cloze&topicId=${TOPIC_ID}&refId=${REF_ID}`,
    );
  });

  it("双向一致：build → parse 还原同一导航对象（忽略大小写归一）", () => {
    const input = { venue: "reading_choice" as const, topicId: TOPIC_ID, noteId: NOTE_ID, refId: REF_ID };
    const url = buildStudyNoteUrl(input);
    const search = new URLSearchParams(url.slice(url.indexOf("?") + 1));
    const nav = parseStudyNoteNavigation(search);
    expect(nav.isStudyNotes).toBe(true);
    expect(nav.venue).toBe("reading_choice");
    expect(nav.topicId).toBe(TOPIC_ID);
    expect(nav.noteId).toBe(NOTE_ID);
    expect(nav.refId).toBe(REF_ID);
    expect(nav.errors).toEqual([]);
  });

  it("七题型全部可构造并还原", () => {
    const venues = ["cloze", "reading_choice", "new_question", "sentence_translation", "short_essay", "long_essay", "grammar_blank"] as const;
    for (const venue of venues) {
      const url = buildStudyNoteUrl({ venue });
      const nav = parseStudyNoteNavigation(new URLSearchParams(url.slice(url.indexOf("?") + 1)));
      expect(nav.venue).toBe(venue);
      expect(nav.errors).toEqual([]);
    }
  });
});
