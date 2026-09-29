/**
 * L1 词卡 exam 扩展的**数据契约与解析**（2026-09-29）。
 *
 * 背景：`words.examples[].exam` 一直存在且随复习队列 / 词条详情 API 完整下发
 * （实测 6731 条 exam，`reading.split` / `split_roles` / `translation.key_points` /
 * `writing.pattern` 全覆盖），但前端**零处渲染**——`buildHintSteps` 的 H1 只取
 * `examples[].text` + `.translation`，整个 exam 对象被丢弃。
 *
 * 为什么要单独建契约层（而不是组件里直接读 JSON）：
 * 1. `examples` 是 `jsonb`，**形状不受类型系统保护**。实测 `reading.structure`
 *    有 95/6731 缺失，其余字段虽全覆盖，但历史数据与未来 L1 产线回填都可能再变。
 *    组件里裸读 `exam.reading.split` 会在某条脏数据上直接白屏。
 * 2. 复习卡（`ReviewCardView`）与词条详情页（`WordDetailPage`）都要用同一份解析，
 *    契约必须是单一真源。
 * 3. 解析必须是**纯函数**——可单测、可在浏览器与容器复用，不引 React 依赖。
 *
 * 实测形状（`words.examples[]` 库内全量统计，2026-09-29）：
 * - `exam` 键：`reading` / `translation` / `writing`（另有 `checked` / `assertions_avoided`，
 *   与展示无关，本契约不收）
 * - `reading.split`: string[]，`reading.split_roles`: `[角色名, 类别][]`
 *   —— **6731/6731 与 split 等长**（最多 6 块），类别实测取值 `main` / `mod`
 * - `reading.structure`: string —— **仅 6636/6731 有，缺 95 条**，故为可选
 * - `translation.key_points`: `{tag, text, translation, note}` + 可选 `kind`
 *   （`kind` 仅 76 条有），最多 4 个；`translation.model`: 参考译文
 * - `writing.pattern`: string；`writing.imitating_example`: string（仿写例句）
 */

export interface WordExamSplitBlock {
  /** 例句切分出的第 i 块原文。 */
  readonly text: string;
  /** 该块语法角色名（如「系表 · 表语」）。`split_roles` 缺失或长度不符时为 null。 */
  readonly role: string | null;
  /** 该块角色类别：`main` 主干 / `mod` 修饰。未知类别归 `null`，不猜。 */
  readonly roleKind: "main" | "mod" | null;
}

export interface WordExamKeyPoint {
  /** 解析标签（如「平行结构」「固定搭配」）。 */
  readonly tag: string;
  /** 对应原文片段。 */
  readonly text: string;
  /** 该片段译文。 */
  readonly translation: string;
  /** 解析说明（如「三项并列不可并成一个」）。 */
  readonly note: string | null;
  /** 可选细分标记（实测仅 76 条有，如 `strategy`）。 */
  readonly kind: string | null;
}

export interface WordExam {
  /** 精读：例句逐块切分 + 语法角色 + 整句结构概述。 */
  readonly reading: {
    readonly blocks: readonly WordExamSplitBlock[];
    /** 整句结构概述。实测 95/6731 缺失，故可能为 null。 */
    readonly structure: string | null;
  } | null;
  /** 译解：参考译文 + 逐块带标签解析。 */
  readonly translation: {
    readonly model: string | null;
    readonly keyPoints: readonly WordExamKeyPoint[];
  } | null;
  /** 仿写：可套用句式 + 仿写例句。 */
  readonly writing: {
    readonly pattern: string | null;
    readonly usage: string | null;
    readonly functionLabel: string | null;
    readonly imitatingExample: string | null;
  } | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** 只接受非空字符串；空串/非串一律归 null（不渲染空白块）。 */
const str = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
};

const strArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(str).filter((s): s is string => s !== null) : [];

/**
 * 解析 `reading.split` + `reading.split_roles` 为逐块结构。
 *
 * **长度不符时按位对齐、不补不改**：`split` 是内容主线（缺失则整层降级），
 * `split_roles` 只是注释。实测两者 100% 等长，但对不齐的脏数据不能让注释错位到
 * 别的句块上——那比没有角色标注更有害。
 */
function parseBlocks(examReading: Record<string, unknown>): WordExam["reading"] {
  const texts = strArray(examReading.split);
  if (texts.length === 0) return null;
  const rawRoles = Array.isArray(examReading.split_roles) ? examReading.split_roles : [];
  const blocks: WordExamSplitBlock[] = texts.map((text, i) => {
    const pair = rawRoles[i];
    if (!Array.isArray(pair)) return { text, role: null, roleKind: null };
    const role = str(pair[0]);
    const kindRaw = str(pair[1]);
    // 只承认实测出现的两类，其余归 null——不按字符串猜语义。
    const roleKind = kindRaw === "main" || kindRaw === "mod" ? kindRaw : null;
    return { text, role, roleKind };
  });
  return { blocks, structure: str(examReading.structure) };
}

function parseKeyPoints(raw: unknown): WordExamKeyPoint[] {
  if (!Array.isArray(raw)) return [];
  const out: WordExamKeyPoint[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    // tag/text/translation 三者是这一条解析的最小可读单元，缺一不渲染该条
    //（实测 16470/16470 四键齐全，但生产回填的脏数据不能假设）。
    const tag = str(item.tag);
    const text = str(item.text);
    const translation = str(item.translation);
    if (tag === null || text === null || translation === null) continue;
    out.push({ tag, text, translation, note: str(item.note), kind: str(item.kind) });
  }
  return out;
}

/**
 * 从 `examples[i].exam` 解析 exam 扩展。
 *
 * 形状不符合预期、或是 `null`/非对象 → 返回 `null`（调用方据此不渲染任何东西）。
 * 三层各自独立降级：某层缺失只丢该层，不影响其它层。
 */
export function parseWordExam(raw: unknown): WordExam | null {
  if (!isRecord(raw)) return null;

  const readingRaw = raw.reading;
  const reading = isRecord(readingRaw) ? parseBlocks(readingRaw) : null;

  const translationRaw = raw.translation;
  const translation = isRecord(translationRaw)
    ? (() => {
        const keyPoints = parseKeyPoints(translationRaw.key_points);
        const model = str(translationRaw.model);
        if (keyPoints.length === 0 && model === null) return null;
        return { model, keyPoints };
      })()
    : null;

  const writingRaw = raw.writing;
  const writing = isRecord(writingRaw)
    ? (() => {
        const pattern = str(writingRaw.pattern);
        const usage = str(writingRaw.usage);
        const functionLabel = str(writingRaw.function);
        const imitatingExample = str(writingRaw.imitating_example);
        if (pattern === null && usage === null && functionLabel === null && imitatingExample === null) {
          return null;
        }
        return { pattern, usage, functionLabel, imitatingExample };
      })()
    : null;

  if (reading === null && translation === null && writing === null) return null;
  return { reading, translation, writing };
}

/** 从 `word.examples` 里取第一条带可展示 exam 的例句（词条页有多例句时取最全的一条）。 */
export function pickPrimaryExam(examples: unknown): WordExam | null {
  if (!Array.isArray(examples)) return null;
  for (const ex of examples) {
    if (!isRecord(ex)) continue;
    const exam = parseWordExam(ex.exam);
    if (exam) return exam;
  }
  return null;
}
