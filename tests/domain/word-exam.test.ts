/**
 * L1 词卡 exam 扩展的契约解析测试（2026-09-29）。
 *
 * 重点不是"能解析正常数据"——那由真实数据保证（6731 条 exam 全量实测），
 * 而是**脏数据不会让页面崩**。`words.examples` 是 jsonb，形状不受类型系统保护：
 * 实测 `reading.structure` 就缺 95/6731。未来 L1 产线回填还会继续写这个字段。
 */
import { describe, expect, it } from "vitest";
import { parseSplitSegments, parseWordExam, pickPrimaryExam, type WordExam } from "@/domain/word-exam";

/** 真实形状样本（取自库里 facilitate 一条，字段名与嵌套均未改动）。 */
const REAL = {
  reading: {
    split: [
      "Facilitating learning",
      "is about helping it emerge,",
      "whether by drawing on collective wisdom or awareness of different perspectives,",
      "clarifying unexamined beliefs and assumptions,",
      "or scaffolding towards achievable learning outcomes.",
    ],
    structure: "主句主干＋状语从句（条件）＋平行结构；主句先下定义，再用 whether 引导的三项并列展开具体做法。",
    split_roles: [
      ["主语（动名词）", "main"],
      ["系表 · 表语", "main"],
      ["条件状语", "mod"],
      ["并列", "mod"],
      ["并列 · 收束", "mod"],
    ],
  },
  translation: {
    model: "促进学习，就是帮助学习自然生发……",
    key_points: [
      { tag: "词义引申", note: "动名词主语，取「促成」义", text: "Facilitating learning", translation: "促进学习" },
      { tag: "平行结构", kind: "strategy", note: "三项并列不可并成一个", text: "whether by drawing on collective wisdom", translation: "三重 or 并列顺译" },
    ],
  },
  writing: {
    usage: "机制说明段的开篇句式",
    pattern: "[做法] [对象] is about [动作①] it [状态变化], whether by drawing on [路径①] or [路径②]...",
    function: "机制说明",
    imitating_example: "Planning a course is about seeing it run smoothly, whether by drawing on classroom experience...",
  },
};

describe("parseWordExam", () => {
  it("解析真实形状：三层齐全，角色按位对齐", () => {
    const exam = parseWordExam(REAL) as WordExam;
    expect(exam).not.toBeNull();
    expect(exam.reading?.blocks).toHaveLength(5);
    expect(exam.reading?.blocks[0]).toEqual({
      text: "Facilitating learning",
      role: "主语（动名词）",
      roleKind: "main",
      segments: [{ text: "Facilitating learning", depth: 0, nestType: null }],
    });
    expect(exam.reading?.blocks[2]?.roleKind).toBe("mod");
    expect(exam.reading?.structure).toBeTruthy();
    expect(exam.translation?.keyPoints).toHaveLength(2);
    expect(exam.translation?.keyPoints[1]?.kind).toBe("strategy");
    expect(exam.translation?.keyPoints[0]?.note).toBeTruthy();
    expect(exam.writing?.pattern).toContain("[做法]");
    expect(exam.writing?.functionLabel).toBe("机制说明");
  });

  it("缺 reading.structure（实测 95/6731 缺失）→ 结构为 null，其余层不受影响", () => {
    const exam = parseWordExam({ ...REAL, reading: { split: ["A", "B"], split_roles: [["主语", "main"], ["谓语", "main"]] } }) as WordExam;
    expect(exam.reading?.structure).toBeNull();
    expect(exam.reading?.blocks).toHaveLength(2);
    expect(exam.writing?.pattern).toBeTruthy();
  });

  it("split_roles 长度与 split 不符 → 超出部分 role 为 null，绝不错位", () => {
    // 危险形状：只有 1 个 role 却有 3 个 split。若按下标硬套，注释会贴到错误的句块上。
    const exam = parseWordExam({ reading: { split: ["A", "B", "C"], split_roles: [["主语", "main"]] } }) as WordExam;
    expect(exam.reading?.blocks).toHaveLength(3);
    expect(exam.reading?.blocks[0]?.role).toBe("主语");
    expect(exam.reading?.blocks[1]?.role).toBeNull();
    expect(exam.reading?.blocks[2]?.role).toBeNull();
  });

  it("未知 roleKind 不猜语义，归 null", () => {
    const exam = parseWordExam({ reading: { split: ["A"], split_roles: [["主语", "weird_category"]] } }) as WordExam;
    expect(exam.reading?.blocks[0]?.role).toBe("主语");
    expect(exam.reading?.blocks[0]?.roleKind).toBeNull();
  });

  it("key_points 缺最小可读单元（tag/text/translation）→ 丢弃该条，其余保留", () => {
    const exam = parseWordExam({
      translation: {
        key_points: [
          { tag: "有 tag 缺 text", translation: "x" },
          { text: "缺 tag", translation: "x" },
          { tag: "完整", text: "A", translation: "甲" },
        ],
      },
    }) as WordExam;
    expect(exam.translation?.keyPoints).toHaveLength(1);
    expect(exam.translation?.keyPoints[0]?.tag).toBe("完整");
  });

  it("三层各自独立降级：只有一层有效也返回该层", () => {
    const onlyReading = parseWordExam({ reading: { split: ["A"] } }) as WordExam;
    expect(onlyReading.reading).not.toBeNull();
    expect(onlyReading.translation).toBeNull();
    expect(onlyReading.writing).toBeNull();

    const onlyWriting = parseWordExam({ writing: { pattern: "X" } }) as WordExam;
    expect(onlyWriting.writing?.pattern).toBe("X");
    expect(onlyWriting.reading).toBeNull();
  });

  it("空层对象视为缺失（不渲染空壳）", () => {
    const exam = parseWordExam({ reading: {}, translation: {}, writing: {} }) as WordExam;
    expect(exam).toBeNull();
  });

  it("非对象 / null / 数组 → 返回 null，调用方不渲染", () => {
    expect(parseWordExam(null)).toBeNull();
    expect(parseWordExam(undefined)).toBeNull();
    expect(parseWordExam("exam")).toBeNull();
    expect(parseWordExam(42)).toBeNull();
    expect(parseWordExam([REAL])).toBeNull();
  });

  it("split 为空数组 → reading 层降级而非渲染空列表", () => {
    const exam = parseWordExam({ reading: { split: [], split_roles: [], structure: "只有结构描述" } });
    // structure 单独存在不足以撑起一层（没有块可标），但整层不至于崩
    expect(exam === null || exam.reading === null || exam.reading?.blocks.length === 0).toBe(true);
  });

  it("非字符串 split 元素被过滤，不渲染空白块", () => {
    const exam = parseWordExam({ reading: { split: ["A", null, 123, "", "  ", "B"] } }) as WordExam;
    expect(exam.reading?.blocks.map((b) => b.text)).toEqual(["A", "B"]);
  });
});

/**
 * `reading.split` 里的 `[]` 与 `｜标记` 是**编码**，不是正文。
 *
 * 不剥离的后果是真实可见的：真库实测 **126 词** 的例句正文里混进了 `｜定` / `｜状`。
 * 设计稿（`wordcard-mock-2026-09-11.html`）把嵌套片段做成 `.nest`、分类做成
 * **独立的 `.nest-type` 角标**，且设计稿全部迭代备份中 `｜` 出现次数为 0。
 *
 * 三种编码形态在真库中并存（全量统计 2026-10-03）：
 *   ① `[片段｜定]` 124 词   ② `[片段]` 1 词   ③ `[片段]｜状,` 2 词（bow / boss）
 */
describe("parseSplitSegments（`[]` / `｜` 编码剥离）", () => {
  const joined = (raw: string) => parseSplitSegments(raw).map((s) => s.text).join("");

  it("无标记的纯文本 → 单个 depth 0 片段", () => {
    expect(parseSplitSegments("Facilitating learning")).toEqual([
      { text: "Facilitating learning", depth: 0, nestType: null },
    ]);
  });

  it("形态① `[片段｜定]`：标记归 nestType，正文里不得残留 `｜`", () => {
    const segs = parseSplitSegments("Levitt wore a [brown suède｜定] coat and gloves;");
    expect(segs).toEqual([
      { text: "Levitt wore a ", depth: 0, nestType: null },
      { text: "brown suède", depth: 1, nestType: "定" },
      { text: " coat and gloves;", depth: 0, nestType: null },
    ]);
    expect(joined("Levitt wore a [brown suède｜定] coat and gloves;")).not.toContain("｜");
  });

  it("形态② `[片段]`（无标记）→ 仍是嵌套片段，nestType 为 null", () => {
    expect(parseSplitSegments("Given [China's shrinking labor force] and more,")).toEqual([
      { text: "Given ", depth: 0, nestType: null },
      { text: "China's shrinking labor force", depth: 1, nestType: null },
      { text: " and more,", depth: 0, nestType: null },
    ]);
  });

  it("形态③ `[片段]｜状,`：标记在括号外，且**尾随逗号必须交回正文**（不能吞掉）", () => {
    // 真实脏数据：bow = "seated [in the second row directly behind his daughter]｜状,"
    const raw = "seated [in the second row directly behind his daughter]｜状,";
    const segs = parseSplitSegments(raw);
    expect(segs).toEqual([
      { text: "seated ", depth: 0, nestType: null },
      { text: "in the second row directly behind his daughter", depth: 1, nestType: "状" },
      { text: ",", depth: 0, nestType: null },
    ]);
    // 关键：正文拼回来必须与去掉编码后的原句逐字相同 —— 既不残留 `｜`/`[]`，也不丢标点
    expect(joined(raw)).toBe("seated in the second row directly behind his daughter,");
  });

  it("形态③ 变体 `[片段]｜定.`：句点同样交回正文", () => {
    // 真实脏数据：boss = "and the dangerous orbit of [their crime boss mother]｜定."
    const segs = parseSplitSegments("and the dangerous orbit of [their crime boss mother]｜定.");
    expect(segs[segs.length - 1]).toEqual({ text: ".", depth: 0, nestType: null });
    expect(segs.find((s) => s.nestType !== null)?.nestType).toBe("定");
  });

  it("同一块内多处标记各自解析", () => {
    const segs = parseSplitSegments("[26｜同] people were [12 people ill｜宾] in total");
    expect(segs.filter((s) => s.depth === 1).map((s) => s.nestType)).toEqual(["同", "宾"]);
    expect(segs.map((s) => s.text).join("")).not.toContain("｜");
  });

  it("真实样本（analogy 的 split[0]）：`｜状` 不再落进正文", () => {
    const raw = "Asante draws a manufacturing analogy[—with some exaggeration—｜状]";
    const segs = parseSplitSegments(raw);
    expect(segs).toEqual([
      { text: "Asante draws a manufacturing analogy", depth: 0, nestType: null },
      { text: "—with some exaggeration—", depth: 1, nestType: "状" },
    ]);
    expect(segs.map((s) => s.text).join("")).not.toContain("｜");
  });

  it("嵌套深度 >1 时按层计数（实测仅 1 词，但契约要如实标注）", () => {
    const segs = parseSplitSegments("a [b [c] d] e");
    expect(segs).toEqual([
      { text: "a ", depth: 0, nestType: null },
      { text: "b ", depth: 1, nestType: null },
      { text: "c", depth: 2, nestType: null },
      { text: " d", depth: 1, nestType: null },
      { text: " e", depth: 0, nestType: null },
    ]);
  });

  // ── 脏数据容错：不崩、不白屏，也不静默吞字 ──
  it("空标记 `[x｜]`：剥括号但不出角标", () => {
    expect(parseSplitSegments("[x｜] tail")).toEqual([
      { text: "x", depth: 1, nestType: null },
      { text: " tail", depth: 0, nestType: null },
    ]);
  });

  it("括号不配对 → 整串当正文原样返回，不剥不猜（实测真库 154 个含 `[` 片段全部配对）", () => {
    const unclosed = "a [b c";
    expect(parseSplitSegments(unclosed)).toEqual([{ text: unclosed, depth: 0, nestType: null }]);
    const strayClose = "a ] b";
    expect(parseSplitSegments(strayClose)).toEqual([{ text: strayClose, depth: 0, nestType: null }]);
  });

  it("空串 → 空数组（不产出空片段）", () => {
    expect(parseSplitSegments("")).toEqual([]);
  });

  it("解析结果被挂到 block.segments 上，且 block.text 保留原文以便追溯", () => {
    const exam = parseWordExam({
      reading: {
        split: ["x [y｜定] z"],
        split_roles: [["主语", "main"]],
      },
    }) as WordExam;
    expect(exam.reading?.blocks[0]?.text).toBe("x [y｜定] z");
    expect(exam.reading?.blocks[0]?.segments).toEqual([
      { text: "x ", depth: 0, nestType: null },
      { text: "y", depth: 1, nestType: "定" },
      { text: " z", depth: 0, nestType: null },
    ]);
  });
});

describe("pickPrimaryExam", () => {
  it("取第一条有可展示 exam 的例句", () => {
    const got = pickPrimaryExam([
      { text: "no exam" },
      { text: "with exam", exam: REAL },
    ]);
    expect(got?.reading?.blocks).toHaveLength(5);
  });

  it("首条例句 exam 脏数据 → 继续找下一条，不整体放弃", () => {
    const got = pickPrimaryExam([
      { text: "broken", exam: { reading: "not-an-object" } },
      { text: "good", exam: REAL },
    ]);
    expect(got?.writing?.pattern).toBeTruthy();
  });

  it("全部无有效 exam / 非数组 → null", () => {
    expect(pickPrimaryExam([])).toBeNull();
    expect(pickPrimaryExam(null)).toBeNull();
    expect(pickPrimaryExam([{ text: "a" }, { text: "b" }])).toBeNull();
  });
});
