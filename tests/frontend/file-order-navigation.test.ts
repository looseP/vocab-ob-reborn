/**
 * 文件顺序导航（2026-09-26）纯逻辑测试。
 *
 * 锁死三件事：
 *  - 身份口径 = `(question_type, source_id | file_key)`，与 `?file=` 深链一致；
 *  - 邻居按**列表原序**，不跳题、不分组；
 *  - 认不出身份时返回空邻居而**不默认跳第一份**（否则用户丢了自己刚做完的位置）。
 */
import { describe, expect, it } from "vitest";
import {
  filePositionLabel,
  fileSiblingLabel,
  findFileSiblings,
  sameFileIdentity,
  type OrderedPracticeFile,
} from "@/frontend/viewModels/fileOrderNavigation";

function file(overrides: Partial<OrderedPracticeFile>): OrderedPracticeFile {
  return {
    question_type: "reading_choice",
    source_id: null,
    file_key: null,
    title: "未命名",
    question_count: 3,
    ...overrides,
  };
}

const A = file({ source_id: "src-a", title: "2023 Text2" });
const B = file({ source_id: "src-b", title: "2023 Text3" });
const C = file({ file_key: "writing:essay-set", question_type: "long_essay", title: "大作文题组" });

describe("sameFileIdentity", () => {
  it("source 型：sourceId 匹配", () => {
    expect(sameFileIdentity(A, { questionType: "reading_choice", sourceId: "src-a", fileKey: null })).toBe(true);
    expect(sameFileIdentity(A, { questionType: "reading_choice", sourceId: "src-b", fileKey: null })).toBe(false);
  });

  it("fileKey 型：fileKey 匹配（source 型文件无 fileKey 时以 sourceId 代入）", () => {
    expect(sameFileIdentity(C, { questionType: "long_essay", sourceId: null, fileKey: "writing:essay-set" })).toBe(true);
  });

  it("题型不同即不同文件（同一 source 的阅读题与完形题是两份）", () => {
    const sameSourceOtherType = file({ source_id: "src-a", question_type: "cloze" });
    expect(sameFileIdentity(sameSourceOtherType, { questionType: "reading_choice", sourceId: "src-a", fileKey: null })).toBe(false);
  });

  it("fileKey 优先于 sourceId（fileKey 型身份不应被 sourceId 误配）", () => {
    const f = file({ source_id: "src-x", file_key: "key-x" });
    expect(sameFileIdentity(f, { questionType: "reading_choice", sourceId: "src-x", fileKey: null })).toBe(true);
    expect(sameFileIdentity(f, { questionType: "reading_choice", sourceId: null, fileKey: "key-x" })).toBe(true);
  });

  it("两个标识都缺 → 不匹配（不猜）", () => {
    expect(sameFileIdentity(A, { questionType: "reading_choice", sourceId: null, fileKey: null })).toBe(false);
  });
});

describe("findFileSiblings", () => {
  const files = [A, B, C];

  it("中间项：前后各取一份（按列表原序）", () => {
    const s = findFileSiblings(files, { questionType: "reading_choice", sourceId: "src-b", fileKey: null });
    expect(s.previous?.title).toBe("2023 Text2");
    expect(s.next?.title).toBe("大作文题组");
    expect(s.index).toBe(1);
    expect(s.total).toBe(3);
  });

  it("首项：没有上一份（不越界）", () => {
    const s = findFileSiblings(files, { questionType: "reading_choice", sourceId: "src-a", fileKey: null });
    expect(s.previous).toBeNull();
    expect(s.next?.title).toBe("2023 Text3");
    expect(s.index).toBe(0);
  });

  it("末项：没有下一份", () => {
    const s = findFileSiblings(files, { questionType: "long_essay", sourceId: null, fileKey: "writing:essay-set" });
    expect(s.next).toBeNull();
    expect(s.previous?.title).toBe("2023 Text3");
    expect(s.index).toBe(2);
  });

  it("单份列表：两侧都为空，index=0", () => {
    const s = findFileSiblings([A], { questionType: "reading_choice", sourceId: "src-a", fileKey: null });
    expect(s.previous).toBeNull();
    expect(s.next).toBeNull();
    expect(s.index).toBe(0);
    expect(s.total).toBe(1);
  });

  it("认不出身份 → 空邻居 + index -1（**不**默认跳第一份）", () => {
    const s = findFileSiblings(files, { questionType: "cloze", sourceId: "src-zzz", fileKey: null });
    expect(s.previous).toBeNull();
    expect(s.next).toBeNull();
    expect(s.index).toBe(-1);
    expect(s.total).toBe(3);
  });

  it("identity 为 null（还没打开任何文件）→ 空邻居", () => {
    expect(findFileSiblings(files, null)).toEqual({ previous: null, next: null, index: -1, total: 3 });
  });

  it("空列表 → 全部为空", () => {
    const s = findFileSiblings([], { questionType: "reading_choice", sourceId: "src-a", fileKey: null });
    expect(s).toEqual({ previous: null, next: null, index: -1, total: 0 });
  });
});

describe("文案", () => {
  it("位置文案：认得出报「第 n / m 份」，认不出只报总数（不谎报位置）", () => {
    const known = findFileSiblings([A, B, C], { questionType: "reading_choice", sourceId: "src-b", fileKey: null });
    expect(filePositionLabel(known)).toBe("第 2 / 3 份");
    const unknown = findFileSiblings([A, B, C], { questionType: "cloze", sourceId: "x", fileKey: null });
    expect(filePositionLabel(unknown)).toBe("共 3 份");
    expect(filePositionLabel(findFileSiblings([], null))).toBe("");
  });

  it("邻项按钮带目标文件名；无邻项时用 fallback", () => {
    const s = findFileSiblings([A, B, C], { questionType: "reading_choice", sourceId: "src-b", fileKey: null });
    expect(fileSiblingLabel(s.previous, "上一份")).toBe("上一份：2023 Text2");
    expect(fileSiblingLabel(s.next, "下一份")).toBe("下一份：大作文题组");
    expect(fileSiblingLabel(null, "上一份")).toBe("上一份");
  });
});
