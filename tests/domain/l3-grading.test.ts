import { describe, expect, it } from "vitest";
import {
  GRADING_ANALYSIS_MAX,
  GRADING_SUBMIT_RESULT_LIMIT,
  GRADING_VERDICTS,
  findOutOfScopeIds,
  gradingSubmitInputSchema,
  nextAnnotationStage,
  toStoredAnnotationReview,
} from "@/domain/l3-grading";

const Q1 = "00000000-0000-4000-8000-000000000101";
const Q2 = "00000000-0000-4000-8000-000000000102";
const A1 = "00000000-0000-4000-8000-000000000701";
const A2 = "00000000-0000-4000-8000-000000000702";

/** 经 schema 解析出的合法提交骨架（逐用例覆写）。 */
function parseResults(results: unknown[]) {
  return gradingSubmitInputSchema.safeParse({ results });
}

describe("l3-grading domain contracts", () => {
  it("exposes the two-tier verdict vocabularies (题级三档 / 注记三档同形不同义)", () => {
    expect(GRADING_VERDICTS).toEqual(["correct", "partial", "wrong"]);
  });

  it("accepts a well-formed submission with nested annotation reviews", () => {
    const parsed = parseResults([
      {
        questionId: Q1,
        verdict: "wrong",
        analysisMd: "定位偏移：把举例当论点。",
        annotationReviews: [
          { annotationId: A1, verdict: "sound", correctedTags: ["例证题"], comment: "锚点准确" },
          { annotationId: A2, verdict: "questionable" },
        ],
      },
      { questionId: Q2, verdict: "partial" },
    ]);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.results).toHaveLength(2);
      expect(parsed.data.results[0]!.annotationReviews).toHaveLength(2);
    }
  });

  it("rejects an empty results array (空数组 400)", () => {
    const parsed = parseResults([]);
    expect(parsed.success).toBe(false);
  });

  it("rejects more than the 1–200 result window", () => {
    const results = Array.from({ length: GRADING_SUBMIT_RESULT_LIMIT + 1 }, (_, index) => ({
      questionId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      verdict: "correct",
    }));
    expect(parseResults(results).success).toBe(false);
  });

  it("rejects duplicate questionIds and duplicate annotationIds within one submission", () => {
    expect(parseResults([
      { questionId: Q1, verdict: "correct" },
      { questionId: Q1, verdict: "wrong" },
    ]).success).toBe(false);
    expect(parseResults([
      { questionId: Q1, verdict: "correct", annotationReviews: [{ annotationId: A1, verdict: "sound" }] },
      { questionId: Q2, verdict: "wrong", annotationReviews: [{ annotationId: A1, verdict: "wrong" }] },
    ]).success).toBe(false);
  });

  it("rejects unknown keys (strict) and unknown verdicts", () => {
    expect(parseResults([{ questionId: Q1, verdict: "correct", gradedBy: "self" }]).success).toBe(false);
    expect(parseResults([{ questionId: Q1, verdict: "sound" }]).success).toBe(false);
    expect(parseResults([
      { questionId: Q1, verdict: "correct", annotationReviews: [{ annotationId: A1, verdict: "partial" }] },
    ]).success).toBe(false);
  });

  it("bounds analysisMd and correctedTags by the contract limits", () => {
    expect(parseResults([{ questionId: Q1, verdict: "correct", analysisMd: "x".repeat(GRADING_ANALYSIS_MAX + 1) }]).success).toBe(false);
    expect(parseResults([
      { questionId: Q1, verdict: "correct", annotationReviews: [{ annotationId: A1, verdict: "sound", correctedTags: Array.from({ length: 9 }, (_, i) => `标签${i}`) }] },
    ]).success).toBe(false);
    expect(parseResults([
      { questionId: Q1, verdict: "correct", annotationReviews: [{ annotationId: A1, verdict: "sound", correctedTags: ["x".repeat(31)] }] },
    ]).success).toBe(false);
  });

  it("findOutOfScopeIds returns only the submitted ids missing from the scope", () => {
    expect(findOutOfScopeIds([Q1, Q2], [Q1])).toEqual([]);
    expect(findOutOfScopeIds([Q1], [Q1, Q2, A1])).toEqual([Q2, A1]);
    expect(findOutOfScopeIds([], [Q1])).toEqual([Q1]);
  });

  it("nextAnnotationStage auto-confirms sound on submitted and never downgrades confirmed", () => {
    expect(nextAnnotationStage("submitted", "sound")).toBe("confirmed");
    expect(nextAnnotationStage("submitted", "questionable")).toBe("submitted");
    expect(nextAnnotationStage("submitted", "wrong")).toBe("submitted");
    expect(nextAnnotationStage("confirmed", "sound")).toBe("confirmed");
    expect(nextAnnotationStage("confirmed", "questionable")).toBe("confirmed");
    expect(nextAnnotationStage("confirmed", "wrong")).toBe("confirmed");
  });

  it("toStoredAnnotationReview maps camelCase input to the 0034 review column shape", () => {
    expect(toStoredAnnotationReview({ annotationId: A1, verdict: "sound", correctedTags: ["细节题"], comment: "ok" }))
      .toEqual({ verdict: "sound", corrected_tags: ["细节题"], comment: "ok" });
    expect(toStoredAnnotationReview({ annotationId: A1, verdict: "questionable" }))
      .toEqual({ verdict: "questionable" });
  });
});
