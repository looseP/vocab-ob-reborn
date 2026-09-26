/**
 * L3 做题子空间 URL 契约（2026-09-26）
 *
 * 锁死四件事：解析 fail-closed、构造唯一、writing/study-notes 不被此模块接管、
 * 以及「未知参数不得被猜成某个面」。
 */
import { describe, expect, it } from "vitest";
import {
  buildL3SectionUrl,
  hasL3SectionUrl,
  parseL3SectionParam,
} from "@/frontend/viewModels/l3SectionNavigation";
import { L3_SHELL_SECTIONS } from "@/frontend/viewModels/l3ShellViewModel";
import { buildStudyNoteUrl, STUDY_NOTES_SECTION } from "@/frontend/viewModels/studyNoteNavigation";
import { buildWritingUrl, WRITING_SECTION } from "@/frontend/viewModels/writingNavigation";

function search(query: string): URLSearchParams {
  return new URLSearchParams(query);
}

describe("parseL3SectionParam", () => {
  it("L3 全部用户面各自可解析", () => {
    expect(parseL3SectionParam(search("section=home"))).toBe("home");
    expect(parseL3SectionParam(search("section=source"))).toBe("source");
    expect(parseL3SectionParam(search("section=word"))).toBe("word");
    expect(parseL3SectionParam(search("section=graph"))).toBe("graph");
    expect(parseL3SectionParam(search("section=papers"))).toBe("papers");
    expect(parseL3SectionParam(search("section=practice"))).toBe("practice");
    expect(parseL3SectionParam(search("section=error-book"))).toBe("errorBook");
    expect(parseL3SectionParam(search("section=session"))).toBe("session");
  });

  it("缺省/空值 → null（无意图，不纠偏）", () => {
    expect(parseL3SectionParam(search(""))).toBeNull();
    expect(parseL3SectionParam(search("section="))).toBeNull();
    expect(parseL3SectionParam(search("section=%20%20"))).toBeNull();
  });

  it("未知值 → null（fail-closed，不猜成 home 或别的面）", () => {
    expect(parseL3SectionParam(search("section=whatever"))).toBeNull();
    expect(parseL3SectionParam(search("section=ErrorBook"))).toBeNull(); // 大小写敏感
    expect(parseL3SectionParam(search("section=errorbook"))).toBeNull(); // 不用 camelCase
  });

  it("writing / study-notes 归各自专用契约，本模块不接管（也不劫持）", () => {
    // 本模块对这两个面没有契约
    expect(hasL3SectionUrl("writing")).toBe(false);
    expect(hasL3SectionUrl("studyNotes")).toBe(false);
    expect(buildL3SectionUrl("writing")).toBeNull();
    expect(buildL3SectionUrl("studyNotes")).toBeNull();
    // 它们的参数值不被本模块误解析成别的面
    expect(parseL3SectionParam(search(`section=${WRITING_SECTION}`))).toBeNull();
    expect(parseL3SectionParam(search(`section=${STUDY_NOTES_SECTION}`))).toBeNull();
    // 但它们的规范 URL 依然能被各自的 effect 消费
    expect(buildWritingUrl({})).toBe(`/l3?section=${WRITING_SECTION}`);
    expect(buildStudyNoteUrl({})).toBe(`/l3?section=${STUDY_NOTES_SECTION}`);
  });

  it("与其它 query 参数共存（只读 section，不吞参数）", () => {
    expect(parseL3SectionParam(search("venue=cloze&file=abc&section=papers"))).toBe("papers");
  });
});

describe("buildL3SectionUrl", () => {
  it("构造稳定、可分享的规范 URL", () => {
    expect(buildL3SectionUrl("papers")).toBe("/l3?section=papers");
    expect(buildL3SectionUrl("practice")).toBe("/l3?section=practice");
    expect(buildL3SectionUrl("errorBook")).toBe("/l3?section=error-book");
    expect(buildL3SectionUrl("session")).toBe("/l3?section=session");
  });

  it("parse ∘ build 恒等（往返一致）", () => {
    for (const section of ["papers", "practice", "errorBook", "session"] as const) {
      const url = buildL3SectionUrl(section) as string;
      expect(parseL3SectionParam(new URL(url, "http://x").searchParams)).toBe(section);
    }
  });

  it("每个有契约的 section 都能构造（无遗漏）", () => {
    const owned = L3_SHELL_SECTIONS.map((s) => s.id).filter(hasL3SectionUrl);
    // 覆盖 L3 的全部**用户面**；刻意不含的只有两类：
    //  - writing / studyNotes：各有专用窄契约（携带 taskId/venue/noteId）
    //  - context / import / manual / proposals / recommendations：工程工具面
    expect(owned.sort()).toEqual([
      "errorBook", "graph", "home", "papers", "practice", "session", "source", "word",
    ]);
  });
});
