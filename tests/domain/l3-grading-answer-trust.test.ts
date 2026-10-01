/**
 * 答案可信度守卫的纯函数测试（PR #184）。
 *
 * ## 为什么这个守卫存在
 *
 * 2025 考研英语二那份卷的 `l3_papers.metadata.answerTrust.status` 是
 * `unverified-constructed`：45 道客观题的答案是**人工构造**的（完形 20 题恰好
 * A5/B5/C5/D5；整体 A11/B11/C11/D10/F1/G1；ordinal 0-5 呈 A B B C D F / A B C C C D 循环）。
 *
 * 拿它当标准答案判分，会得出与真实水平无关甚至**相反**的分数。所以必须 fail-closed。
 *
 * 实测基线（不是推测）：当前 46 道 choice 型客观题里 45 道来自 2025；
 * `l3_practice_attempts` 0 条；唯一题纸指向 USA TODAY 而非 2025 ——
 * 也就是说判卷链**目前碰不到**这份答案。守卫是预防性的。
 */
import { describe, expect, it } from "vitest";
import {
  ANSWER_TRUST_STATUSES,
  gradeability,
  isAnswerTrusted,
  ungradableCode,
} from "@/domain/l3-grading";

const UNVERIFIED = "unverified-constructed";

describe("isAnswerTrusted", () => {
  it("只有 verified 可信", () => {
    expect(isAnswerTrusted("verified")).toBe(true);
  });

  // fail-closed：未标注、拼错、null、对象都要被拒 —— 不能因为「不认识」就放行。
  it.each([UNVERIFIED, "unknown", "unverified", "", null, undefined, 0, {}, []])(
    "非verified 一律不可信：%p",
    (value) => {
      expect(isAnswerTrusted(value)).toBe(false);
    },
  );

  it("可信度取值表与 DB 里的枚举对齐", () => {
    expect(ANSWER_TRUST_STATUSES).toContain("verified");
    expect(ANSWER_TRUST_STATUSES).toContain(UNVERIFIED);
  });
});

describe("gradeability", () => {
  const SRC = "src-2025";
  const trusted = new Map<string, unknown>();
  const untrusted = new Map<string, unknown>([[SRC, UNVERIFIED]]);
  // 标注了 answerTrust 却没写 status —— 最容易被写坏的形状
  const blankStatus = new Map<string, unknown>([[SRC, undefined]]);

  it("答案不可信 → 不可评（即使有作答）", () => {
    const g = gradeability({
      answerTrustBySource: untrusted,
      sourceId: SRC,
      hasAttempt: true,
    });
    expect(g.gradable).toBe(false);
    expect(g.reason).toBe("answer-unverified");
  });

  // 优先级是刻意的：答案不可信时，即使没作答，报的也是答案问题 ——
  // 否则 agent 会以为「等他作答就好了」，而作答后评分仍然是错的。
  it("答案不可信优先于「未作答」", () => {
    const g = gradeability({
      answerTrustBySource: untrusted,
      sourceId: SRC,
      hasAttempt: false,
    });
    expect(g.reason).toBe("answer-unverified");
    expect(g.gradable).toBe(false);
  });

  it("答案不可信 + 未作答也要报 answer-unverified", () => {
    const g = gradeability({
      answerTrustBySource: blankStatus,
      sourceId: SRC,
      hasAttempt: true,
    });
    expect(g.reason).toBe("answer-unverified");
  });

  it("无标注（缺键）= 可信，走原有「有无作答」判定", () => {
    expect(
      gradeability({ answerTrustBySource: trusted, sourceId: SRC, hasAttempt: true }),
    ).toEqual({ gradable: true, reason: null });

    const noAttempt = gradeability({
      answerTrustBySource: trusted,
      sourceId: SRC,
      hasAttempt: false,
    });
    expect(noAttempt.gradable).toBe(false);
    expect(noAttempt.reason).toBe("no-attempt");
  });

  // 没有答案来源的题（source_id 为 null）不能被守卫误伤。
  it("sourceId 为 null 时不受守卫影响", () => {
    expect(
      gradeability({ answerTrustBySource: untrusted, sourceId: null, hasAttempt: true }),
    ).toEqual({ gradable: true, reason: null });
  });

  it("verified 的 source 可评", () => {
    const verified = new Map<string, unknown>([[SRC, "verified"]]);
    expect(
      gradeability({ answerTrustBySource: verified, sourceId: SRC, hasAttempt: true }),
    ).toEqual({ gradable: true, reason: null });
  });

  it("只影响标注过的 source（同 Map 里的其它 source 不受影响）", () => {
    const mixed = new Map<string, unknown>([[SRC, UNVERIFIED]]);
    expect(
      gradeability({
        answerTrustBySource: mixed,
        sourceId: "src-other",
        hasAttempt: true,
      }),
    ).toEqual({ gradable: true, reason: null });
  });
});

describe("ungradableCode", () => {
  // 两个原因必须给不同 code：agent 要能区分「重试有用」与「要换答案」。
  it("区分两种不可评", () => {
    expect(ungradableCode("answer-unverified")).toBe("ANSWER_UNVERIFIED");
    expect(ungradableCode("no-attempt")).toBe("NO_ACTIVE_ATTEMPT");
  });

  it("null / 未知原因兜底为 NO_ACTIVE_ATTEMPT（不得放行成可评）", () => {
    expect(ungradableCode(null)).toBe("NO_ACTIVE_ATTEMPT");
  });
});