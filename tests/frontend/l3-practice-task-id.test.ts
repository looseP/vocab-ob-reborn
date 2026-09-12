/**
 * T11 幂等键对拍：前端 Web Crypto 派生 vs T04 domain deterministicTaskId。
 *
 * domain 模块 import node:crypto（浏览器运行时不可用），前端按同算法用
 * Web Crypto 复刻；本测试在 node 环境直接跑两边实现，锁定逐字节等价——
 * 任何一侧的算法漂移都会让本文件变红。
 */
import { describe, expect, it, vi } from "vitest";
import { deterministicTaskId, l3PracticeSeed, normalizeDictationText } from "@/domain/l3-practice-task";
import {
  buildPracticeSeed,
  computePracticeTaskId,
  judgeDictation,
  normalizeDictationText as frontendNormalizeDictationText,
} from "@/frontend/viewModels/l3PracticeViewModel";

const SEEDS = [
  "run-1:ctx-1:0",
  "run-1:ctx-1:3",
  "dddddddd-dddd-4ddd-8ddd-dddddddddddd:00000000-0000-4000-8000-000000000002:7",
  "sess:ctx-with-中文-字符:2",
];

describe("l3 practice task identity (web crypto ↔ domain parity)", () => {
  it("mirrors the domain seed formula", () => {
    for (const [runId, contextId, attemptIndex] of [
      ["s", "c", 0],
      ["run-1", "ctx-1", 3],
      ["run-中文", "ctx-中文", 12],
    ] as const) {
      expect(buildPracticeSeed(runId, contextId, attemptIndex)).toBe(l3PracticeSeed(runId, contextId, attemptIndex));
    }
  });

  it("matches T04 deterministicTaskId byte-for-byte (sha256 hex first 16)", async () => {
    for (const seed of SEEDS) {
      for (const practiceType of ["essay_dictation", "context_quiz"] as const) {
        const expected = deterministicTaskId(practiceType, seed);
        await expect(computePracticeTaskId(practiceType, seed)).resolves.toBe(expected);
      }
    }
  });

  it("returns a task id in the documented shape", async () => {
    const taskId = await computePracticeTaskId("essay_dictation", SEEDS[0]);
    expect(taskId).toBe(deterministicTaskId("essay_dictation", SEEDS[0]));
    expect(taskId).toMatch(/^essay_dictation:[0-9a-f]{16}$/);
  });

  it("fails loudly when no digest implementation is available", async () => {
    vi.stubGlobal("crypto", undefined);
    try {
      await expect(computePracticeTaskId("essay_dictation", SEEDS[0])).rejects.toThrow(/crypto\.subtle/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("mirrors the domain dictation normalization and judging rules", () => {
    const samples = [
      "  The   Mind\nResists  ",
      "ＡＢＣ　１２３",
      "Rest.",
      "rest",
      "Ｈｅｌｌｏ　Ｗｏｒｌｄ",
      "plain",
    ];
    for (const sample of samples) {
      expect(frontendNormalizeDictationText(sample)).toBe(normalizeDictationText(sample));
    }
    expect(judgeDictation("  the   mind resists ", "The Mind\nResists")).toBe(true);
    expect(judgeDictation("rest", "rest.")).toBe(false);
    expect(judgeDictation("ＲＥＳＴ．", "rest.")).toBe(true);
  });
});
