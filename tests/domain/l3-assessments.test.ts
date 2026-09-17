import { describe, expect, it } from "vitest";
import {
  ASSESSMENT_CONTENT_MAX,
  ASSESSMENT_EDITORS,
  assessmentUpsertInputSchema,
} from "@/domain/l3-assessments";

describe("assessmentUpsertInputSchema（评析区契约，ADR-0034 v2 条 10/11）", () => {
  it("accepts non-empty content and trims", () => {
    const parsed = assessmentUpsertInputSchema.parse({ contentMd: "  评析正文  " });
    expect(parsed.contentMd).toBe("评析正文");
  });

  it("rejects empty or whitespace-only content（空文不作清除语义）", () => {
    expect(assessmentUpsertInputSchema.safeParse({ contentMd: "" }).success).toBe(false);
    expect(assessmentUpsertInputSchema.safeParse({ contentMd: "   " }).success).toBe(false);
  });

  it("caps content at 20k and rejects unknown keys (strict)", () => {
    expect(assessmentUpsertInputSchema.safeParse({ contentMd: "x".repeat(ASSESSMENT_CONTENT_MAX + 1) }).success).toBe(false);
    expect(assessmentUpsertInputSchema.safeParse({ contentMd: "x".repeat(ASSESSMENT_CONTENT_MAX) }).success).toBe(true);
    expect(assessmentUpsertInputSchema.safeParse({ contentMd: "x", extra: 1 }).success).toBe(false);
  });

  it("exposes the owner/agent editor vocabulary", () => {
    expect([...ASSESSMENT_EDITORS]).toEqual(["owner", "agent"]);
    expect(ASSESSMENT_CONTENT_MAX).toBe(20_000);
  });
});
