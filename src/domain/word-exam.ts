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

/**
 * 切分块内的一个片段（`reading.split[i]` 内部的嵌套结构）。
 *
 * 数据里嵌套片段有三种编码形态（真库全量统计 2026-10-03，`reading.split`）：
 * - `[片段｜定]` —— 标记在括号内，**124 词**
 * - `[片段]` —— 纯嵌套无标记，**1 词**
 * - `[片段]｜状,` —— 标记在括号外、且带尾随句读，**2 词**（`bow` / `boss`）
 *
 * 三种都必须能解析：`｜` 是**数据分隔符不是正文**，泄漏出去会在句子里显示
 * `｜定`（实测 126 词受害）。设计稿口径见 `wordcard-mock-2026-09-11.html`：
 * 嵌套片段走 `.nest`，分类走**独立的 `.nest-type` 角标**，且设计稿全部迭代备份中
 * `｜` 出现次数为 0 —— 佐证它只是编码。
 */
export interface WordExamSplitSegment {
  /** 片段原文（已剥离 `[]` 与 `｜标记`）。 */
  readonly text: string;
  /** 嵌套层数：0 = 非嵌套正文；1+ = 位于该层 `[]` 内。 */
  readonly depth: number;
  /** 嵌套片段的分类角标（如「定」「状」「同」）。无标记或非嵌套时为 null。 */
  readonly nestType: string | null;
}

export interface WordExamSplitBlock {
  /** 例句切分出的第 i 块**原文**（含 `[]` / `｜` 编码标记）。渲染请用 `segments`。 */
  readonly text: string;
  /** 该块语法角色名（如「系表 · 表语」）。`split_roles` 缺失或长度不符时为 null。 */
  readonly role: string | null;
  /** 该块角色类别：`main` 主干 / `mod` 修饰。未知类别归 `null`，不猜。 */
  readonly roleKind: "main" | "mod" | null;
  /** 已解析的片段序列（`text` 的结构化结果，供渲染直接消费）。 */
  readonly segments: readonly WordExamSplitSegment[];
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

const NEST_SEP = "｜";

/**
 * 拆开「标记 + 尾随句读」。`｜状,` 的标记是「状」，`,` 是**句子标点**要交回正文 ——
 * 吞掉它会把原句的逗号弄丢（实测 `bow` 的 `｜状,` 就是这样）。
 * 标记本身只吃非句读字符；空标记归空串（调用方据此不渲染角标）。
 */
function splitMarkerTail(marker: string): { marker: string; tail: string } {
  const m = /^([^.,;:!?，。；：！？、]+)([\s\S]*)$/.exec(marker);
  if (!m) return { marker: "", tail: marker };
  return { marker: m[1], tail: m[2] };
}

/**
 * 把 `reading.split[i]` 的原文解析为片段序列，剥离 `[]` 与 `｜标记` 两种**编码**。
 *
 * 不解析的后果是真实的：`｜定` 会被当正文渲染进例句（真库实测 126 词）。
 * 三种编码形态都要吃（见 `WordExamSplitSegment` 注释）。
 *
 * 宽容策略（脏数据不白屏、也不静默吞字）：
 * - **括号不配对**（`[` 未闭合）⇒ **整串当正文原样返回**，不做任何剥离 ——
 *   残缺编码无法判断边界，猜不如不猜（实测真库 154 个含 `[` 的片段全部配对，
 *   这条是为未来回填写的兜底）；
 * - 多余的 `]`（depth 为 0）当普通字符；
 * - 标记为空（如 `[x｜]`）时不渲染角标，但括号照常剥离；
 * - 单块内多处标记各自解析，互不影响。
 */
export function parseSplitSegments(raw: string): WordExamSplitSegment[] {
  const whole = (): WordExamSplitSegment[] => [{ text: raw, depth: 0, nestType: null }];
  if (raw.length === 0) return [];
  // 先验配对：不配对就整体退化为正文，避免把残缺编码的边界猜错。
  let balance = 0;
  for (const ch of raw) {
    if (ch === "[") balance += 1;
    else if (ch === "]") balance -= 1;
    if (balance < 0) return whole();
  }
  if (balance !== 0) return whole();

  const segments: WordExamSplitSegment[] = [];
  let buffer = "";
  let depth = 0;
  let i = 0;

  const flush = (nestType: string | null): void => {
    if (buffer.length === 0) return;
    segments.push({ text: buffer, depth, nestType });
    buffer = "";
  };

  while (i < raw.length) {
    const ch = raw[i];

    if (ch === "[") {
      flush(null);
      depth += 1;
      i += 1;
      continue;
    }

    if (ch === "]" && depth > 0) {
      // 形态①：标记在括号内 `[片段｜定]`
      let nestType: string | null = null;
      const sep = buffer.lastIndexOf(NEST_SEP);
      if (sep >= 0) {
        const parsed = splitMarkerTail(buffer.slice(sep + 1));
        nestType = parsed.marker.length > 0 ? parsed.marker : null;
        buffer = buffer.slice(0, sep) + parsed.tail; // 尾随句读回到该片段内
      }
      flush(nestType);
      depth -= 1;

      // 形态③：标记在括号外 `[片段]｜状,`
      if (raw[i + 1] === NEST_SEP) {
        let j = i + 2;
        let rawMarker = "";
        while (j < raw.length && raw[j] !== "[" && raw[j] !== "]") {
          rawMarker += raw[j];
          j += 1;
        }
        const parsed = splitMarkerTail(rawMarker);
        const last = segments[segments.length - 1];
        if (parsed.marker.length > 0 && last !== undefined) {
          segments[segments.length - 1] = { ...last, nestType: parsed.marker };
          buffer = parsed.tail; // 残余句读回正文，下一轮正常累积
          i = j;
          continue;
        }
      }

      i += 1;
      continue;
    }

    buffer += ch;
    i += 1;
  }

  flush(null);
  return segments;
}

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
    const segments = parseSplitSegments(text);
    const pair = rawRoles[i];
    if (!Array.isArray(pair)) return { text, role: null, roleKind: null, segments };
    const role = str(pair[0]);
    const kindRaw = str(pair[1]);
    // 只承认实测出现的两类，其余归 null——不按字符串猜语义。
    const roleKind = kindRaw === "main" || kindRaw === "mod" ? kindRaw : null;
    return { text, role, roleKind, segments };
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
