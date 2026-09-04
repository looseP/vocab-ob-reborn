/**
 * DrillEngine —— L1 练习模式（cram）自测引擎（补全）。
 *
 * 对齐原项目 vocab-observatory 的 lib/review/drill.ts + prompt-mode.ts：
 * - 两种变体：cloze（完形填空，从例句挖词）/ definition（词形填空，根据释义+首尾字母写出单词）
 * - 纯前端/内存状态机：correct → 出队；wrong → 移到队尾并计错（错题回尾重试）
 * - 全程不写 review_logs / scheduler_payload —— 与 cram 无副作用边界一致
 *
 * 纯函数模块，无 DB、无副作用，便于单元测试。
 */

export const CLOZE_BLANK_TOKEN = "▢▢▢";

export type DrillMode = "cloze" | "definition";

export interface DrillCard {
  progressId: string;
  wordId: string;
  lemma: string;
  title: string;
  slug: string;
  shortDefinition: string | null;
  state: string;
  /** 例句中 lemma 被 ▢▢▢ 替换后的文本（cloze 变体用）。 */
  clozeText: string;
  /** 被遮盖 token 的原长度（作为字母数提示）。 */
  clozeLength: number;
  /** 原始例句（提交后反馈展示用）。 */
  clozeSource: string;
}

export interface DrillQueueState {
  /** 队首即当前卡。 */
  queue: DrillCard[];
  /** 会话开始时去重卡总数（不随出队缩小）。 */
  totalUnique: number;
  /** 按 progressId 记录的答错次数。 */
  attemptsByCard: Record<string, number>;
  /** 至少答对过一次的卡。 */
  passedByCard: Record<string, true>;
  phase: "playing" | "done";
}

/** 从候选卡构建初始状态；空牌组直接进入 done。 */
export function createDrillQueue(cards: ReadonlyArray<DrillCard>): DrillQueueState {
  const queue = cards.slice();
  return {
    queue,
    totalUnique: queue.length,
    attemptsByCard: {},
    passedByCard: {},
    phase: queue.length === 0 ? "done" : "playing",
  };
}

export interface DrillSubmitResult {
  correct: boolean;
  correctAnswer: string;
  next: DrillQueueState;
}

/**
 * 提交当前卡答案：
 * - 答对 → 出队并标记 passed
 * - 答错 → 计错并将卡移到队尾（错题回尾）
 * - 空队 → no-op，返回 correct:false
 */
export function submitDrillAnswer(
  state: DrillQueueState,
  answer: string,
): DrillSubmitResult {
  if (state.queue.length === 0) {
    return { correct: false, correctAnswer: "", next: state };
  }
  const current = state.queue[0];
  const expected = normalizeDrillAnswer(current.lemma);
  const received = normalizeDrillAnswer(answer);
  const correct = expected.length > 0 && received === expected;

  if (correct) {
    const remaining = state.queue.slice(1);
    return {
      correct: true,
      correctAnswer: current.lemma,
      next: {
        ...state,
        queue: remaining,
        passedByCard: { ...state.passedByCard, [current.progressId]: true },
        phase: remaining.length === 0 ? "done" : "playing",
      },
    };
  }

  const tail = [...state.queue.slice(1), current];
  const prevAttempts = state.attemptsByCard[current.progressId] ?? 0;
  return {
    correct: false,
    correctAnswer: current.lemma,
    next: {
      ...state,
      queue: tail,
      attemptsByCard: {
        ...state.attemptsByCard,
        [current.progressId]: prevAttempts + 1,
      },
    },
  };
}

/** 「晚点再看」：当前卡移到队尾，不记录尝试。 */
export function deferDrillCard(state: DrillQueueState): DrillQueueState {
  if (state.queue.length <= 1) return state;
  const [head, ...rest] = state.queue;
  return { ...state, queue: [...rest, head] };
}

export function remainingInDrill(state: DrillQueueState): number {
  return state.queue.length;
}

/** 首次尝试即答对的卡数（错题次数为 0）。 */
export function countFirstTryPasses(state: DrillQueueState): number {
  let count = 0;
  for (const progressId of Object.keys(state.passedByCard)) {
    if ((state.attemptsByCard[progressId] ?? 0) === 0) count += 1;
  }
  return count;
}

/**
 * definition 变体的词形遮盖：长度 ≤3 全显；长度 4 首尾+中间一个 ▢；
 * 长度 ≥5 首尾+中间全 ▢。▢ 与 cloze 变体同字符，视觉一致。
 */
export function maskLemma(lemma: string): string {
  if (lemma.length <= 3) return lemma;
  const first = lemma[0];
  const last = lemma[lemma.length - 1];
  const blanks = CLOZE_BLANK_TOKEN.repeat(Math.max(1, lemma.length - 2));
  return `${first}${blanks}${last}`;
}

/** 答案归一化：小写 + 去首尾空白 + 折叠内部空白 + 去尾部标点。 */
export function normalizeDrillAnswer(s: string): string {
  if (!s) return "";
  return s
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[.,!?:;)\]}"']+$/u, "");
}

/**
 * 尝试把例句中的 lemma（含基本形态变体）替换为 ▢▢▢。
 * 策略：去简单 markdown 强调 → 整词精确匹配 → 常见后缀变体
 * （含去尾-e 规则 love→loved）→ 子串兜底。
 */
export function redactLemmaInSentence(
  sentence: string,
  lemma: string,
): { text: string; matchedLength: number } | null {
  if (!sentence || !lemma) return null;
  const stripped = stripSimpleMarkdown(sentence);
  if (!stripped) return null;

  const lemmaLc = lemma.toLowerCase();
  const escaped = escapeRegExp(lemmaLc);

  const exactRegex = new RegExp(`\\b${escaped}\\b`, "i");
  const exactMatch = stripped.match(exactRegex);
  if (exactMatch) {
    return {
      text: stripped.replace(exactMatch[0], CLOZE_BLANK_TOKEN),
      matchedLength: exactMatch[0].length,
    };
  }

  const suffixes = ["es", "ed", "ied", "ing", "er", "est", "s"];
  for (const suffix of suffixes) {
    const variant = new RegExp(`\\b${escaped}${suffix}\\b`, "i");
    const m = stripped.match(variant);
    if (m) {
      return {
        text: stripped.replace(m[0], CLOZE_BLANK_TOKEN),
        matchedLength: m[0].length,
      };
    }

    if (
      lemmaLc.endsWith("e") &&
      (suffix === "ed" || suffix === "ing" || suffix === "es")
    ) {
      const base = lemmaLc.slice(0, -1);
      const variantNoE = new RegExp(`\\b${escapeRegExp(base)}${suffix}\\b`, "i");
      const m2 = stripped.match(variantNoE);
      if (m2) {
        return {
          text: stripped.replace(m2[0], CLOZE_BLANK_TOKEN),
          matchedLength: m2[0].length,
        };
      }
    }
  }

  const lcSentence = stripped.toLowerCase();
  const idx = lcSentence.indexOf(lemmaLc);
  if (idx >= 0) {
    return {
      text:
        stripped.slice(0, idx) +
        CLOZE_BLANK_TOKEN +
        stripped.slice(idx + lemma.length),
      matchedLength: lemma.length,
    };
  }

  return null;
}

/**
 * 从例句列表中挑选第一条可挖词的句子（确定性：取第一条成功的）。
 */
export function findClozeFromExamples(
  examples: Array<{ text?: string | null }> | null | undefined,
  lemma: string,
): { text: string; matchedLength: number; source: string } | null {
  if (!examples || examples.length === 0) return null;
  for (const ex of examples) {
    if (!ex?.text) continue;
    const redacted = redactLemmaInSentence(ex.text, lemma);
    if (redacted) {
      return {
        text: redacted.text,
        matchedLength: redacted.matchedLength,
        source: ex.text,
      };
    }
  }
  return null;
}

function stripSimpleMarkdown(input: string): string {
  return input
    .replace(/\*+([^*]+)\*+/g, "$1")
    .replace(/_+([^_]+)_+/g, "$1")
    .trim();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
