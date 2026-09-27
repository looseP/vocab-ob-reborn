import { describe, expect, it } from "vitest";
import {
  buildPracticeFileUrl,
  practiceFileRef,
} from "@/frontend/viewModels/practiceFileNavigation";

/**
 * 缺口 A 的 URL 侧单测：写出去的地址必须**恰好**是深链读侧认得的那个地址。
 * 「读侧认得」是这层的全部价值——写错一个参数名，深链就成了只写不读的单向广播。
 */
describe("buildPracticeFileUrl", () => {
  it("打开文件：写 section=papers + venue + file", () => {
    expect(buildPracticeFileUrl("/l3", { questionType: "reading_choice", fileRef: "src-1" }))
      .toBe("/l3?file=src-1&section=papers&venue=reading_choice");
  });

  it("返回列表：清掉 file 但保留 venue（否则刷新会把刚退出的文件重开）", () => {
    expect(buildPracticeFileUrl("/l3?file=src-1&section=papers&venue=reading_choice", {
      questionType: "reading_choice",
      fileRef: null,
    })).toBe("/l3?section=papers&venue=reading_choice");
  });

  it("保留 mode：切文件不得把解析档打回做题档（B3 同 query 邻居）", () => {
    expect(buildPracticeFileUrl("/l3?section=papers&mode=review&venue=cloze&file=src-0", {
      questionType: "cloze",
      fileRef: "src-9",
    })).toBe("/l3?file=src-9&mode=review&section=papers&venue=cloze");
  });

  it("保留 I3 回原题参数（question / resumeSheet）与题纸深链（sheet / paper）", () => {
    const url = buildPracticeFileUrl(
      "/l3?question=q-1&resumeSheet=sh-1&section=papers&sheet=sh-0&venue=short_essay&file=ek-0",
      { questionType: "short_essay", fileRef: "ek-1" },
    );
    const search = new URLSearchParams(url.split("?")[1]);
    expect(search.get("question")).toBe("q-1");
    expect(search.get("resumeSheet")).toBe("sh-1");
    expect(search.get("sheet")).toBe("sh-0");
    expect(search.get("file")).toBe("ek-1");
  });

  it("URL 自足：显式带 section=papers，不依赖来路", () => {
    // 来路是 /l3（无 section）时也必须落到 papers 面，否则复制出去打不开。
    expect(buildPracticeFileUrl("/l3?mode=pure", { questionType: "cloze", fileRef: "s1" }))
      .toBe("/l3?file=s1&mode=pure&section=papers&venue=cloze");
  });

  it("参数顺序稳定：与传入 query 的顺序无关", () => {
    const a = buildPracticeFileUrl("/l3?venue=cloze&mode=review&section=papers", { questionType: "cloze", fileRef: "s1" });
    const b = buildPracticeFileUrl("/l3?mode=review&venue=cloze&section=papers", { questionType: "cloze", fileRef: "s1" });
    expect(a).toBe(b);
  });

  it("引用需转义：fileKey 含特殊字符时不破 URL", () => {
    const url = buildPracticeFileUrl("/l3", { questionType: "long_essay", fileRef: "a b&c=d" });
    expect(url).toBe("/l3?file=a+b%26c%3Dd&section=papers&venue=long_essay");
    expect(new URLSearchParams(url.split("?")[1]).get("file")).toBe("a b&c=d");
  });
});

describe("practiceFileRef", () => {
  it("fileKey 型取 file_key（写作/翻译无 source）", () => {
    expect(practiceFileRef({ source_id: null, file_key: "ek-1" })).toBe("ek-1");
  });

  it("source 型取 source_id", () => {
    expect(practiceFileRef({ source_id: "src-1", file_key: null })).toBe("src-1");
  });

  it("两者皆空 → null（不编造引用；写 null 等于「没有可深链的文件」）", () => {
    expect(practiceFileRef({ source_id: null, file_key: null })).toBeNull();
  });

  it("fileKey 优先（与 sameFileIdentity 的身份口径同源）", () => {
    expect(practiceFileRef({ source_id: "src-1", file_key: "ek-1" })).toBe("ek-1");
  });
});
