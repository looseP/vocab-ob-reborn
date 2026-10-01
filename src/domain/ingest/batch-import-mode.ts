/**
 * 批量导入的写入模式（`POST /words/batch` = 导入页的「JSON 粘贴」路径）。
 *
 * ## 为什么要两种模式
 *
 * 这条路径历史上只有一种行为：`ON CONFLICT (slug) DO UPDATE SET ... = EXCLUDED.*`，
 * 即**无条件覆盖**。而 `definition_md` / `body_md` 在这条路径上是从
 * `short_definition` **派生**的（见 `IWordRepository.insertMany`），所以往导入页
 * 粘一个库里已有的词，会把它的结构化释义替换成 short_definition 那一句话。
 *
 * 实测（PR #185 的起因）：`abandon` 的 definition_md 从 240 字符塌缩成 19 字符；
 * 若 `short_definition` 缺省，路由层转成 null，definition_md 会变成**空串** ——
 * 等于把词条打成 stub。
 *
 * 对照：文件导入走 `upsertFullWord`，那条有 hash 守卫
 * （`WHERE words.content_hash IS DISTINCT FROM EXCLUDED.content_hash`），
 * 所以问题只在这条路上。
 *
 * ## 两种语义
 *
 * - `fill-only`（默认）：已有非空字段永不被覆盖，空/空串字段被填补。
 *   **definition_md 与 body_md 完全不碰** —— 它们是富内容，只能由
 *   `upsertFullWord`（文件导入）写入；这条路径没有富内容可写。
 * - `overwrite`（显式声明）：恢复旧行为。调用方要明确说明「我就是要改写」。
 */
export const BATCH_IMPORT_MODES = ["fill-only", "overwrite"] as const;
export type BatchImportMode = (typeof BATCH_IMPORT_MODES)[number];

export const DEFAULT_BATCH_IMPORT_MODE: BatchImportMode = "fill-only";

export function isBatchImportMode(value: unknown): value is BatchImportMode {
  return typeof value === "string" && (BATCH_IMPORT_MODES as readonly string[]).includes(value);
}

/**
 * 冲突时（slug 已存在）的 SET 子句。
 *
 * 抽成纯函数是为了能直接断言「fill-only 绝不碰 definition_md」——
 * 这条写错的后果是静默破坏用户数据，必须能被测试挡住。
 */
export function conflictUpdateClause(mode: BatchImportMode): string {
  if (mode === "overwrite") {
    // 旧行为：全部设成 EXCLUDED 值（含派生出来的 definition_md / body_md）。
    return `title = EXCLUDED.title, lemma = EXCLUDED.lemma, pos = EXCLUDED.pos,
         cefr = EXCLUDED.cefr, ipa = EXCLUDED.ipa,
         short_definition = EXCLUDED.short_definition,
         content_hash = EXCLUDED.content_hash, source_path = EXCLUDED.source_path,
         definition_md = EXCLUDED.definition_md, body_md = EXCLUDED.body_md,
         pinyin = EXCLUDED.pinyin, pinyin_initial = EXCLUDED.pinyin_initial,
         updated_at = now()`;
  }
  // fill-only：已有非空值优先；空 / 空串 / 未设置才填。
  //
  // 关键：**definition_md 与 body_md 不出现在这里**。它们在这条路径上是从
  // short_definition 派生的，一旦写入就是把富内容冲成一句话。
  return `pos = COALESCE(words.pos, EXCLUDED.pos),
         cefr = COALESCE(words.cefr, EXCLUDED.cefr),
         ipa = COALESCE(words.ipa, EXCLUDED.ipa),
         short_definition = COALESCE(NULLIF(words.short_definition, ''), EXCLUDED.short_definition),
         pinyin = COALESCE(NULLIF(words.pinyin, ''), EXCLUDED.pinyin),
         pinyin_initial = COALESCE(NULLIF(words.pinyin_initial, ''), EXCLUDED.pinyin_initial),
         updated_at = now()`;
}

/**
 * 冲突分支的 WHERE：fill-only 下「什么都没补上」就整行不动。
 *
 * 没有它，COALESCE 全部取到旧值时仍会写一次 updated_at ——
 * 「什么都没变的批量导入」会把所有词条的更新时间刷一遍，
 * 让「最近改动」失去意义。
 */
export function conflictGuardClause(mode: BatchImportMode): string {
  if (mode === "overwrite") return "";
  return `WHERE words.pos IS DISTINCT FROM COALESCE(words.pos, EXCLUDED.pos)
     OR words.cefr IS DISTINCT FROM COALESCE(words.cefr, EXCLUDED.cefr)
     OR words.ipa IS DISTINCT FROM COALESCE(words.ipa, EXCLUDED.ipa)
     OR words.short_definition IS DISTINCT FROM
        COALESCE(NULLIF(words.short_definition, ''), EXCLUDED.short_definition)
     OR words.pinyin IS DISTINCT FROM COALESCE(NULLIF(words.pinyin, ''), EXCLUDED.pinyin)
     OR words.pinyin_initial IS DISTINCT FROM
        COALESCE(NULLIF(words.pinyin_initial, ''), EXCLUDED.pinyin_initial)`;
}

/**
 * 一次批量导入的结果。区分「新增 / 更新 / 未变」，
 * 让调用方能告诉你这批到底改了什么 —— 尤其 fill-only 下大量条目会是 unchanged。
 */
export interface BatchImportOutcome {
  inserted: number;
  updated: number;
  /** slug 已存在且本次没有任何字段被填补。 */
  unchanged: number;
}

/**
 * 从不可信的请求体里解析写入模式。
 *
 * 兜底方向必须是 `fill-only`：`overwrite` 会让导入无条件覆盖已有字段
 * （包括由short_definition 派生的 definition_md），所以一个拼错的
 * `"OVERWRITE"` 绝不能被当成授权 —— 那等于静默破坏用户数据。
 */
export function resolveBatchImportMode(raw: unknown): BatchImportMode {
  return isBatchImportMode(raw) ? raw : DEFAULT_BATCH_IMPORT_MODE;
}

/** `/words/batch` 接受的最小词条形状。 */
export interface BatchImportWordInput {
  slug?: unknown;
  title?: unknown;
  lemma?: unknown;
  pos?: unknown;
  cefr?: unknown;
  ipa?: unknown;
  short_definition?: unknown;
}

/** 清洗后的形状：可选字段一律是 `string | null`（不用 undefined，避免下游漏判）。 */
export interface BatchImportWord {
  slug: string;
  title: string;
  lemma: string;
  pos: string | null;
  cefr: string | null;
  ipa: string | null;
  short_definition: string | null;
}

/**
 * slug 规范化：转小写，非 `[a-z0-9-]` 一律折叠成 `-`。
 *
 * 注意不 trim 也不去重折叠：`"Blue Sky!" -> "blue-sky-"`（尾部那个 `-` 是
 * 被折叠掉的 `!`）。这是既有行为，`tests/http/words.test.ts` 就在断言它 ——
 * 别"顺手修正"，那会静默改变已发布过的 slug。
 */
export function batchImportSlug(raw: unknown): string {
  return String(raw ?? "").toLowerCase().replace(/[^a-z0-9-]/g, "-");
}

const str = (v: unknown): string | null => (v ? String(v) : null);

/**
 * 把请求体里的原始词条数组清洗成 repository 能吃的形状。
 *
 * `title` / `lemma` 互相兜底（任一存在即可），`slug` 为空的行被丢弃
 * —— 那是调用方给了空 lemma 的情况，插进去会造出无名词条。
 */
export function sanitizeBatchImportWords(raw: unknown): BatchImportWord[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((w): BatchImportWord | null => {
      const item = (w ?? {}) as BatchImportWordInput;
      const lemma = String(item.lemma ?? item.title ?? "");
      const word: BatchImportWord = {
        slug: batchImportSlug(item.slug ?? item.lemma ?? ""),
        title: String(item.title ?? item.lemma ?? ""),
        lemma,
        pos: str(item.pos),
        cefr: str(item.cefr),
        ipa: str(item.ipa),
        short_definition: str(item.short_definition),
      };
      return word.slug.length > 0 ? word : null;
    })
    .filter((w): w is BatchImportWord => w !== null);
}
