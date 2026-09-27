/**
 * 卷面三模式：可见性矩阵 + URL 契约的纯逻辑单测（批次 B2）。
 *
 * 本批**不接线**：组件仍用 `revealAll`。这样做的理由是让判定逻辑在没有渲染消费方的
 * 情况下被穷尽测透 —— 接线时若出错，能立刻分清是「判定错了」还是「接线错了」，
 * 而不是两者混在一个 diff 里互相掩护。
 *
 * 矩阵断言是**表驱动**的：14 个字段 × 3 档，缺一格即失败。这是执行文档 §5-1 的要求。
 */
import { describe, expect, it } from "vitest";

import {
  EXAM_MODES,
  EXAM_MODE_DEFAULT,
  EXAM_MODE_PARAM,
  buildExamModeUrl,
  parseExamMode,
  resolveExamMode,
} from "@/frontend/viewModels/examModeNavigation";
import {
  defaultVisibility,
  hiddenTraceNotice,
  visibilityFor,
  type ExamVisibility,
} from "@/frontend/viewModels/examModeVisibility";

/** 矩阵真值表（与设计卡 §2.4 + 执行文档 §3.2 逐格对应）。 */
const MATRIX: Record<"pure" | "practice" | "review", ExamVisibility> = {
  pure: {
    showMaterial: true, showNotesPanel: true,
    // 评析在纯净档**全隐**（设计卡 §2.4）：B3 时曾有意偏离为可见（数不出条数就无法
    // 如实声明），2026-09-27 补上批量读面后偏离关闭。
    showPicked: false, showUserMarks: false, showAnnotations: false, showAssessments: false,
    showEvidence: false, showOptionVerdict: false, showExplanation: false,
    showReferenceAnswer: false, showGrading: false, showScore: false,
    showGradingCoverage: false,
    canAnswer: false,
  },
  practice: {
    showMaterial: true, showNotesPanel: true,
    showPicked: true, showUserMarks: true, showAnnotations: true, showAssessments: true,
    showEvidence: false, showOptionVerdict: false, showExplanation: false,
    showReferenceAnswer: false, showGrading: false, showScore: false,
    showGradingCoverage: true,
    canAnswer: true,
  },
  review: {
    showMaterial: true, showNotesPanel: true,
    showPicked: true, showUserMarks: true, showAnnotations: true, showAssessments: true,
    showEvidence: true, showOptionVerdict: true, showExplanation: true,
    showReferenceAnswer: true, showGrading: true, showScore: true,
    showGradingCoverage: true,
    canAnswer: false,
  },
};

const FIELDS = Object.keys(MATRIX.practice) as (keyof ExamVisibility)[];

describe("examModeNavigation · 解析（fail-closed）", () => {
  it("三档原样解析", () => {
    for (const mode of EXAM_MODES) {
      expect(parseExamMode(mode)).toBe(mode);
    }
  });

  it("缺省与空串 → null（不是非法，是没写）", () => {
    expect(parseExamMode(null)).toBeNull();
    expect(parseExamMode(undefined)).toBeNull();
    expect(parseExamMode("")).toBeNull();
    expect(parseExamMode("   ")).toBeNull();
  });

  it("非法值 → null，且不抛错（URL 是用户可随手敲的面）", () => {
    for (const raw of ["xxx", "Practice", "PRACTICE", "pure1", "1", "purE", "reviews"]) {
      expect(parseExamMode(raw), raw).toBeNull();
    }
  });

  it("两端空白容忍（沿 parseL3SectionParam 先例：手滑不是敌意）", () => {
    expect(parseExamMode(" practice ")).toBe("practice");
    expect(parseExamMode("pure ")).toBe("pure");
    expect(parseExamMode("  review")).toBe("review");
  });

  it("resolveExamMode 是唯一回落入口：缺省与非法都落 practice", () => {
    expect(EXAM_MODE_DEFAULT).toBe("practice");
    expect(resolveExamMode(null)).toBe("practice");
    expect(resolveExamMode("")).toBe("practice");
    expect(resolveExamMode("garbage")).toBe("practice");
    expect(resolveExamMode("pure")).toBe("pure");
    expect(resolveExamMode("review")).toBe("review");
  });
});

describe("examModeNavigation · URL 构造（保留定位参数）", () => {
  it("设置模式：保留其余全部参数，不丢定位信息", () => {
    const href = "/l3?section=papers&venue=reading_choice&file=rls-file-1&question=Q1";
    const next = buildExamModeUrl(href, "review");
    const params = new URLSearchParams(next.slice(next.indexOf("?") + 1));
    expect(params.get(EXAM_MODE_PARAM)).toBe("review");
    expect(params.get("section")).toBe("papers");
    expect(params.get("venue")).toBe("reading_choice");
    expect(params.get("file")).toBe("rls-file-1");
    expect(params.get("question")).toBe("Q1");
  });

  it("null → 清除参数（缺省档不落 URL，便于与「显式写默认档」区分）", () => {
    const href = "/l3?section=papers&mode=review&file=x";
    const next = buildExamModeUrl(href, null);
    expect(next).not.toContain(EXAM_MODE_PARAM);
    expect(next).toContain("file=x");
  });

  it("显式写默认档会保留（与缺省不同 URL）", () => {
    const explicit = buildExamModeUrl("/l3?section=papers", "practice");
    const implicit = buildExamModeUrl("/l3?section=papers", null);
    expect(explicit).toContain("mode=practice");
    expect(implicit).not.toContain(EXAM_MODE_PARAM);
    expect(explicit).not.toBe(implicit);
  });

  it("幂等与顺序稳定：同输入同输出，与参数传入顺序无关", () => {
    const a = buildExamModeUrl("/l3?section=papers&venue=cloze", "pure");
    const b = buildExamModeUrl("/l3?venue=cloze&section=papers", "pure");
    expect(a).toBe(b);
    expect(buildExamModeUrl(a, "pure")).toBe(a);
  });

  it("无 query 的路径不产生裸问号", () => {
    expect(buildExamModeUrl("/l3", "pure")).toBe("/l3?mode=pure");
    expect(buildExamModeUrl("/l3", null)).toBe("/l3");
  });

  it("非法模式类型进不来（TS 层收口）：本测试只确认运行时不会静默写出脏值", () => {
    // 调用方若绕过类型检查塞进脏值，URL 会出现 mode=xxx —— 解析端会判非法并回落。
    // 也就是说脏值**不可解析**，这是刻意不 throw 的补偿。
    const dirty = buildExamModeUrl("/l3", "garbage" as never);
    expect(parseExamMode(new URL(dirty, "http://x").searchParams.get(EXAM_MODE_PARAM))).toBeNull();
  });
});

describe("examModeVisibility · 矩阵（14 字段 × 3 档，表驱动）", () => {
  it("每个字段在每档都等于矩阵真值（缺一格即失败）", () => {
    for (const mode of EXAM_MODES) {
      const actual = visibilityFor(mode);
      for (const field of FIELDS) {
        expect(actual[field], `${mode}.${field}`).toBe(MATRIX[mode][field]);
      }
    }
  });

  it("三档 × 全字段：没有多出或漏掉字段（表与实现同源判定）", () => {
    for (const mode of EXAM_MODES) {
      expect(Object.keys(visibilityFor(mode)).sort()).toEqual([...FIELDS].sort());
    }
    expect(FIELDS).toHaveLength(14);
  });

  it("不变量：材料与笔记侧栏三档都可见（基础面永不隐藏）", () => {
    for (const mode of EXAM_MODES) {
      expect(visibilityFor(mode).showMaterial, mode).toBe(true);
      expect(visibilityFor(mode).showNotesPanel, mode).toBe(true);
    }
  });

  it("不变量：答案面只在解析档可见（纯净与做题都不得泄题）", () => {
    for (const mode of ["pure", "practice"] as const) {
      const vis = visibilityFor(mode);
      for (const field of [
        "showEvidence", "showOptionVerdict", "showExplanation",
        "showReferenceAnswer", "showGrading", "showScore",
      ] as const) {
        expect(vis[field], `${mode}.${field}`).toBe(false);
      }
    }
    const review = visibilityFor("review");
    for (const field of [
      "showEvidence", "showOptionVerdict", "showExplanation",
      "showReferenceAnswer", "showGrading", "showScore",
    ] as const) {
      expect(review[field], `review.${field}`).toBe(true);
    }
  });

  it("不变量：只有做题档允许作答（解析档只读陈列，纯净档只读查看）", () => {
    expect(visibilityFor("practice").canAnswer).toBe(true);
    expect(visibilityFor("review").canAnswer).toBe(false);
    expect(visibilityFor("pure").canAnswer).toBe(false);
  });

  it("不变量：作答痕迹（已选/划重点/注记/评析）在纯净档全隐，在做题/解析档全显", () => {
    const pure = visibilityFor("pure");
    // 评析自 2026-09-27 起**进入本列**（批量读面让父层能数出条数并写进隐藏声明 ⇒
    // S-1 的前提满足，按设计卡 §2.4 隐藏；B3 时它是本不变量的唯一例外）。
    for (const field of ["showPicked", "showUserMarks", "showAnnotations", "showAssessments"] as const) {
      expect(pure[field], field).toBe(false);
    }
    for (const mode of ["practice", "review"] as const) {
      const vis = visibilityFor(mode);
      for (const field of ["showPicked", "showUserMarks", "showAnnotations", "showAssessments"] as const) {
        expect(vis[field], `${mode}.${field}`).toBe(true);
      }
    }
  });

  it("未知模式抛错（不静默回落默认 —— 那会错显答案）", () => {
    expect(() => visibilityFor("nope" as never)).toThrow(/unknown exam mode/);
  });

  it("defaultVisibility 等于缺省档判定", () => {
    expect(defaultVisibility()).toEqual(visibilityFor(EXAM_MODE_DEFAULT));
  });
});

describe("examModeVisibility · 纯净模式的隐藏声明（签字项 S-1 / 护栏 G-2）", () => {
  it("非纯净档不产生声明条（做题/解析档没隐藏任何东西）", () => {
    const counts = { marks: 3, annotations: 2, assessments: 1, picked: 5 };
    expect(hiddenTraceNotice("practice", counts)).toBeNull();
    expect(hiddenTraceNotice("review", counts)).toBeNull();
  });

  it("有痕迹时必须声明，且逐类计数", () => {
    const notice = hiddenTraceNotice("pure", { marks: 3, annotations: 2, assessments: 1, picked: 5 });
    expect(notice).toContain("3 处高亮");
    expect(notice).toContain("2 条注记");
    expect(notice).toContain("1 条评析");
    expect(notice).toContain("5 处已选作答");
    // 必须告诉用户怎么找回，否则「隐藏」被读成「丢了」。
    expect(notice).toContain("切回做题或解析模式可见");
  });

  it("计数为 0 的类别不出现（全 0 时整体为 null）", () => {
    const notice = hiddenTraceNotice("pure", { marks: 0, annotations: 0, assessments: 0, picked: 0 });
    expect(notice).toBeNull();
    const onlyMarks = hiddenTraceNotice("pure", { marks: 2, annotations: 0, assessments: 0, picked: 0 });
    expect(onlyMarks).toContain("2 处高亮");
    expect(onlyMarks).not.toContain("注记");
    expect(onlyMarks).not.toContain("评析");
    expect(onlyMarks).not.toContain("0 处");
  });

  it("负数计数按 0 处理（不渲染「-1 处」；判定权交给调用方，此处只保不出现脏值）", () => {
    const notice = hiddenTraceNotice("pure", { marks: -1, annotations: 1, assessments: 0, picked: 0 });
    expect(notice).not.toContain("-1");
    expect(notice).toContain("1 条注记");
  });

  describe("读失败 ⇒ 数不出（2026-09-27）", () => {
    it("unknown 的类别必须被点名，且不编数字", () => {
      const notice = hiddenTraceNotice("pure", {
        marks: 2, annotations: 0, assessments: 0, picked: 1,
        unknown: ["annotations", "assessments"],
      });
      expect(notice).toContain("2 处高亮");
      // 关键：说「未能读取」而不是把两类当 0 咽下去 —— 用户此刻正看不到那些内容
      expect(notice).toContain("原文分析");
      expect(notice).toContain("评析");
      expect(notice).toContain("未能读取");
      expect(notice).toContain("未计入其中");
      expect(notice).not.toContain("0 条注记");
      expect(notice).not.toContain("0 条评析");
    });

    it("全 0 但有 unknown 时仍出声明（否则「数不出」就被读成「没有」）", () => {
      const notice = hiddenTraceNotice("pure", {
        marks: 0, annotations: 0, assessments: 0, picked: 0, unknown: ["assessments"],
      });
      expect(notice).not.toBeNull();
      expect(notice).toContain("评析");
    });

    it("unknown 为空数组等同未给（不留空尾巴）", () => {
      const notice = hiddenTraceNotice("pure", {
        marks: 1, annotations: 0, assessments: 0, picked: 0, unknown: [],
      });
      expect(notice).toContain("1 处高亮");
      expect(notice).not.toContain("未能读取");
    });

    it("非纯净档即使有 unknown 也不出声明（做题/解析档没隐藏任何东西）", () => {
      expect(hiddenTraceNotice("practice", {
        marks: 0, annotations: 0, assessments: 0, picked: 0, unknown: ["assessments"],
      })).toBeNull();
    });
  });
});
