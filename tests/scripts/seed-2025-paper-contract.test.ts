/**
 * 2025 seed 数据的契约锁 —— 防止「答案可信度标记」被后续改动悄悄丢掉。
 *
 * ## 为什么锁这个
 *
 * 2026-09-30 查证：`paper.json` 里 45 道客观题的 `answer` 是**人工构造**的，
 * 不是官方答案钥匙转录（完形 20 题恰好 A5/B5/C5/D5；ordinal 0-5 呈
 * `A B B C D F` 循环）。题面 / 选项 / 解析可用，**答案不可用于自我评分**。
 *
 * 这个事实写进了 `paper.json` 的 `paper.metadata.answerTrust`，seed 会整体透传
 * 进 `l3_papers.metadata`。本套件钉住它：
 *   1. 标记必须在，且 status 明确为 unverified
 *   2. 标记必须说明「哪些能用、哪些不能用」
 *   3. 45 题客观题一条都不能少（`{choice: ...}` 形态）
 *   4. 48 题必须都有解析（解析是可用的那部分，别一起被清掉）
 *
 * 若将来拿到官方钥匙并重做了答案，把 status 改成 verified 即可 —— 本套件会红，
 * 提醒你同步改掉「45 题答案不可用」相关的断言与 README。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SEED_PATH = path.join(
  REPO_ROOT,
  "data",
  "l3-papers",
  "2025-kaoyan-en2",
  "paper.json",
);

interface SeedQuestion {
  ordinal: number;
  stem: string;
  options: Array<{ key: string; text: string }>;
  answer: Record<string, unknown>;
  explanation: string;
}

interface Seed {
  paper: { title: string; metadata: Record<string, unknown> };
  sections: Array<{ title: string; questions: SeedQuestion[] }>;
}

const seed = JSON.parse(readFileSync(SEED_PATH, "utf8")) as Seed;
const allQuestions = seed.sections.flatMap((s) => s.questions);
const objective = allQuestions.filter((q) => typeof q.answer?.choice === "string");

describe("2025 seed 的答案可信度标记", () => {
  it("paper.metadata.answerTrust 存在且标记为未校验", () => {
    const trust = seed.paper.metadata.answerTrust as Record<string, unknown> | undefined;
    expect(trust, "answerTrust 标记不见了 —— 45 题构造答案的风险会被隐藏").toBeDefined();
    expect(trust?.status).toBe("unverified-constructed");
  });

  it("标记写明了可用与不可用的范围", () => {
    const trust = seed.paper.metadata.answerTrust as Record<string, unknown>;
    expect(String(trust.usableFor)).toContain("解析");
    expect(String(trust.notUsableFor)).toContain("自我评分");
    // 重做方式必须留在文件里，否则拿到钥匙的人不知道怎么改
    expect(String(trust.remedy)).toContain("官方答案钥匙");
  });

  it("记录了判定依据（分布证据）", () => {
    const trust = seed.paper.metadata.answerTrust as Record<string, unknown>;
    expect(String(trust.finding)).toContain("A5");
    expect(String(trust.finding)).toContain("构造");
  });
});

describe("2025 seed 的题目数据完整性", () => {
  it("48 题，每题都有解析（解析属可用部分）", () => {
    expect(allQuestions).toHaveLength(48);
    const missing = allQuestions.filter((q) => !q.explanation || !q.explanation.trim());
    expect(missing.map((q) => q.ordinal)).toEqual([]);
  });

  it("45 道客观题形态一致（{choice: 单字母}）", () => {
    expect(objective).toHaveLength(45);
    for (const q of objective) {
      const c = String(q.answer.choice);
      expect(c, `ordinal ${q.ordinal} 的 answer.choice = ${c}`).toMatch(/^[A-G]$/);
    }
  });

  it("客观题的答案键都落在该题选项范围内", () => {
    for (const q of objective) {
      const keys = q.options.map((o) => o.key);
      expect(keys, `ordinal ${q.ordinal} 的 answer 不在选项里`).toContain(q.answer.choice);
    }
  });

  it("ordinal 在每个 section 内 0 基连续（不是全卷连续）", () => {
    // 约定：ordinal 是 **section 内**序号。每个 section 各自从 0 起，
    // 所以全卷 ordinal 去重后只有 0..19（完形占 0-19，其余 section 都是 0..4 / 0）。
    // 显示号由 L3ExamPaper 推导（如 Part B 用 `q.ordinal + 41` 得 41-45），
    // 不靠 ordinal 本身连续。
    for (const s of seed.sections) {
      const ords = s["questions"].map((q) => q.ordinal);
      expect(ords, `${s.title} 的 ordinal 应为 0 基连续`).toEqual(
        ords.map((_, i) => i),
      );
    }
    expect(allQuestions).toHaveLength(48);
  });

  it("Part B 小标题匹配的 5 题按 ordinal+41 推得显示号 41-45", () => {
    const partB = seed.sections.find((s) => s.title.includes("Part B · 小标题"));
    expect(partB, "找不到 Part B 小标题匹配 section").toBeDefined();
    // 与 L3ExamPaper.tsx 的显示约定一致：q.ordinal + 41
    expect(partB!.questions.map((q) => q.ordinal + 41)).toEqual([41, 42, 43, 44, 45]);
  });
});
