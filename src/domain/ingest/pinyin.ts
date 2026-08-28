import { pinyin } from "pinyin-pro";

/**
 * CJK 字符范围：用于从释义文本中提取汉字，避免英文/标点进入拼音列。
 */
const CJK = /[\u4e00-\u9fff]/g;

export interface PinyinFields {
  /** 全拼（无空格、小写），如 "yongqidanliang"。无汉字时为 null。 */
  pinyin: string | null;
  /** 首字母（小写），如 "yqd"。无汉字时为 null。 */
  pinyinInitial: string | null;
}

/**
 * 从中文释义文本生成搜索用拼音。
 *
 * - 仅提取汉字（pinyin-pro 对英文/标点会原样透传，必须先过滤），
 *   因此纯英文词条返回 null（避免拼音列与 lemma 重复）。
 * - 汉字按首现顺序去重：short_definition 与 definition_md 常重复同一批汉字，
 *   不去重会导致拼音翻倍（"加速"+"1. 加速" → jiasujiasu）。
 * - 全拼与首字母均去空格小写，供 ILIKE 子串 + trigram 索引检索。
 */
export function computePinyinFromCjk(...texts: Array<string | null | undefined>): PinyinFields {
  const cjk = Array.from(
    new Set(texts.flatMap((t) => (t ?? "").match(CJK) ?? [])),
  ).join("");
  if (!cjk) return { pinyin: null, pinyinInitial: null };

  const full = pinyin(cjk, { toneType: "none", type: "array" }).join("").toLowerCase();
  const initial = pinyin(cjk, {
    toneType: "none",
    type: "array",
    pattern: "first",
  })
    .join("")
    .toLowerCase();

  return { pinyin: full, pinyinInitial: initial };
}
