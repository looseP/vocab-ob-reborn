/**
 * 2025 考研英语二 L3 语境空间抽取与词次映射脚本
 *
 * 职责：
 * 1. 从 l3_sources 读取 2025 考研英语二的 6 篇正文（14,930 字）；
 * 2. 提取高质量语境句子（准确计算 position.[start, end] 锚点）；
 * 3. 扫描匹配 6767 词库（支持精确形、变体 aliases、常见屈折词干），
 *    计算准确的 start_offset / end_offset 词次；
 * 4. 批量落库至 l3_contexts 与 l3_occurrences，填补 L3 语境空间数据断层。
 *
 * 用法：
 *   在 harness 容器内跑：
 *   npx tsx scripts/mine-l3-contexts-2025.ts [--dry-run] [--clean]
 */

import { withTransaction } from "../src/db/transaction";
import { createRepositories } from "../src/repositories/factory";
import type { PoolClient } from "pg";

const OWNER_ID = "00000000-0000-4000-8000-000000000001";

// 常见英文缩写保护集（防止在点号处误断句）
const ABBREVIATIONS = new Set([
  "u.s.", "u.k.", "e.g.", "i.e.", "etc.", "vs.", "mr.", "mrs.", "ms.", "dr.", "prof.",
  "jan.", "feb.", "mar.", "apr.", "jun.", "jul.", "aug.", "sept.", "oct.", "nov.", "dec.",
  "no.", "st.", "approx.", "est.", "al.", "corp.", "inc.", "ltd.", "co."
]);

interface WordEntry {
  id: string;
  slug: string;
  lemma: string;
  short_definition: string | null;
}

interface MinedOccurrence {
  wordId: string;
  surface: string;
  lemma: string;
  startOffset: number;
  endOffset: number;
  boundSense: string | null;
}

interface MinedContext {
  sourceId: string;
  sourceTitle: string;
  text: string;
  anchorStart: number;
  anchorEnd: number;
  occurrences: MinedOccurrence[];
}

/**
 * 分句函数：返回每个句子的文本及其在原文中的精确 [start, end] 字符偏移
 */
export function extractSentences(text: string): Array<{ text: string; start: number; end: number }> {
  const sentences: Array<{ text: string; start: number; end: number }> = [];
  const len = text.length;
  let start = 0;

  let i = 0;
  while (i < len) {
    const ch = text[i];
    // 检查是否为句子结束候选符号
    if (ch === '.' || ch === '?' || ch === '!') {
      // 检查缩写：往前看最多 10 个字符
      let isAbbr = false;
      if (ch === '.') {
        // 如果前后都是数字（如 3.14），不是断句点
        if (i > 0 && i < len - 1 && /\d/.test(text[i - 1]) && /\d/.test(text[i + 1])) {
          i++;
          continue;
        }
        // 查找词首
        let wordStart = i - 1;
        while (wordStart >= 0 && /[a-zA-Z.]/.test(text[wordStart])) {
          wordStart--;
        }
        const candidateWord = text.slice(wordStart + 1, i + 1).toLowerCase();
        if (ABBREVIATIONS.has(candidateWord)) {
          isAbbr = true;
        }

        // 单字母缩写（如人名 J. 或 U.S. 的 U.）
        if (i - wordStart === 2) {
          isAbbr = true;
        }
        // 紧跟单字母+点号（如 U.S. 中间或 e.g. 中间）
        if (i < len - 2 && /^[a-zA-Z]\./.test(text.slice(i + 1, i + 3))) {
          isAbbr = true;
        }
      }

      if (!isAbbr) {
        // 包含紧随其后的闭引号或括号
        let sentenceEnd = i + 1;
        while (sentenceEnd < len && /['"”’\)]/.test(text[sentenceEnd])) {
          sentenceEnd++;
        }

        // 检查下一个非空字符是否为大写字母、段落换行或文本末尾
        let nextNonSpace = sentenceEnd;
        while (nextNonSpace < len && /\s/.test(text[nextNonSpace])) {
          nextNonSpace++;
        }

        const isParagraphEnd = text.slice(sentenceEnd, nextNonSpace).includes('\n\n') || text.slice(sentenceEnd, nextNonSpace).includes('\r\n\r\n');
        const isNextUpper = nextNonSpace < len && /[A-Z0-9"“‘]/.test(text[nextNonSpace]);
        const isEnd = nextNonSpace >= len;

        if (isParagraphEnd || isNextUpper || isEnd) {
          // 提取句子并去除两端空白，同时精确调整偏移
          const raw = text.slice(start, sentenceEnd);
          const leadingMatch = raw.match(/^\s*/);
          const trailingMatch = raw.match(/\s*$/);
          const leadingOffset = leadingMatch ? leadingMatch[0].length : 0;
          const trailingOffset = trailingMatch ? trailingMatch[0].length : 0;

          const trimmedText = raw.slice(leadingOffset, raw.length - trailingOffset);
          const actualStart = start + leadingOffset;
          const actualEnd = sentenceEnd - trailingOffset;

          if (trimmedText.length >= 20 && /[a-zA-Z]/.test(trimmedText)) {
            sentences.push({
              text: trimmedText,
              start: actualStart,
              end: actualEnd,
            });
          }

          start = nextNonSpace;
          i = nextNonSpace;
          continue;
        }
      }
    }
    i++;
  }

  // 处理末尾残留
  if (start < len) {
    const raw = text.slice(start);
    const leadingMatch = raw.match(/^\s*/);
    const trailingMatch = raw.match(/\s*$/);
    const leadingOffset = leadingMatch ? leadingMatch[0].length : 0;
    const trailingOffset = trailingMatch ? trailingMatch[0].length : 0;

    const trimmedText = raw.slice(leadingOffset, raw.length - trailingOffset);
    if (trimmedText.length >= 20 && /[a-zA-Z]/.test(trimmedText)) {
      sentences.push({
        text: trimmedText,
        start: start + leadingOffset,
        end: len - trailingOffset,
      });
    }
  }

  return sentences;
}

// 排除过频语法闭类词（虚词不作为语境圈记主要对象，避免词卡面板被 and/that/as 淹没）
const CLOSED_FUNCTION_WORDS = new Set([
  "and", "or", "but", "as", "that", "this", "these", "those",
  "for", "with", "at", "by", "from", "to", "in", "on", "it", "its", "not", "no", "so", "than", "too"
]);

export function isValidInflectionAlias(alias: string, lemma: string, slug: string): boolean {
  const a = alias.toLowerCase().trim();
  const l = lemma.toLowerCase().trim();
  const s = slug.toLowerCase().trim();

  // 1. 排除复合词拆解（如 one-shot -> one / shot, well-being -> well）
  if ((s.includes("-") || l.includes("-") || s.includes(" ") || l.includes(" ")) && !a.includes("-") && !a.includes(" ")) {
    return false;
  }
  // 2. 排除过短词根（如 personnel -> person, interpersonal -> person）
  if (a.length < Math.min(l.length, s.length) - 2) {
    return false;
  }
  // 3. 基础小词不能被其它长词作为别名认领
  const STOP_ALIASES = new Set(["a", "an", "the", "in", "on", "at", "to", "for", "of", "with", "by", "from", "up", "about", "it", "one", "person", "man", "be", "do"]);
  if (STOP_ALIASES.has(a) && a !== l && a !== s) {
    return false;
  }
  return true;
}

/**
 * 单词形态匹配：查 exactMap, aliasMap, 及基础词干回退
 */
export function resolveWord(
  token: string,
  exactMap: Map<string, WordEntry>,
  aliasMap: Map<string, WordEntry>,
): WordEntry | null {
  const lower = token.toLowerCase();

  // 忽略超高频闭类虚词
  if (CLOSED_FUNCTION_WORDS.has(lower)) {
    return null;
  }

  // 1. 精确 slug / lemma 匹配
  const exact = exactMap.get(lower);
  if (exact) return exact;

  // 2. 已登记别名匹配
  const aliased = aliasMap.get(lower);
  if (aliased) return aliased;

  // 3. 所有格回退：today's -> today
  if (lower.endsWith("'s") && lower.length > 3) {
    const base = lower.slice(0, -2);
    const hit = exactMap.get(base) || aliasMap.get(base);
    if (hit) return hit;
  }

  // 4. 复数与常见屈折回退
  if (lower.endsWith("ies") && lower.length > 4) {
    const base = lower.slice(0, -3) + "y";
    const hit = exactMap.get(base) || aliasMap.get(base);
    if (hit) return hit;
  }
  if (lower.endsWith("es") && lower.length > 3) {
    const base = lower.slice(0, -2);
    const hit = exactMap.get(base) || aliasMap.get(base);
    if (hit) return hit;
  }
  if (lower.endsWith("s") && lower.length > 2 && !lower.endsWith("ss")) {
    const base = lower.slice(0, -1);
    const hit = exactMap.get(base) || aliasMap.get(base);
    if (hit) return hit;
  }
  if (lower.endsWith("ed") && lower.length > 3) {
    const base1 = lower.slice(0, -1); // assumed -> assume
    const base2 = lower.slice(0, -2); // prompt -> prompted
    const hit = exactMap.get(base1) || exactMap.get(base2) || aliasMap.get(base1) || aliasMap.get(base2);
    if (hit) return hit;
  }
  if (lower.endsWith("ing") && lower.length > 4) {
    const base1 = lower.slice(0, -3); // growing -> grow
    const base2 = lower.slice(0, -3) + "e"; // reducing -> reduce
    const hit = exactMap.get(base1) || exactMap.get(base2) || aliasMap.get(base1) || aliasMap.get(base2);
    if (hit) return hit;
  }
  if (lower.endsWith("ly") && lower.length > 4) {
    const base1 = lower.slice(0, -2); // widely -> wide
    const base2 = lower.slice(0, -2) + "ic"; // historically -> historic
    const hit = exactMap.get(base1) || exactMap.get(base2) || aliasMap.get(base1) || aliasMap.get(base2);
    if (hit) return hit;
  }

  return null;
}

async function main(): Promise<void> {
  const isDryRun = process.argv.includes("--dry-run");
  const isClean = process.argv.includes("--clean");

  console.log(`[L3 Miner] 启动 2025 考研英语二语境挖掘 (dryRun=${isDryRun}, clean=${isClean})`);

  await withTransaction(async (tx: PoolClient) => {
    // 1. 加载 6767 词库建立内存索引
    console.log("[L3 Miner] 正在加载词库...");
    const wordsRes = await tx.query<WordEntry & { aliases: string[] }>(
      `SELECT id, slug, lemma, aliases, short_definition
       FROM words
       WHERE is_published = true AND is_deleted = false`
    );

    const exactMap = new Map<string, WordEntry>();
    const aliasMap = new Map<string, WordEntry>();

    for (const w of wordsRes.rows) {
      const entry: WordEntry = {
        id: w.id,
        slug: w.slug,
        lemma: w.lemma,
        short_definition: w.short_definition,
      };
      exactMap.set(w.slug.toLowerCase(), entry);
      exactMap.set(w.lemma.toLowerCase(), entry);

      if (Array.isArray(w.aliases)) {
        for (const alias of w.aliases) {
          if (alias && alias.trim()) {
            const aliasTrimmed = alias.trim();
            if (isValidInflectionAlias(aliasTrimmed, w.lemma, w.slug)) {
              const aliasLower = aliasTrimmed.toLowerCase();
              if (!exactMap.has(aliasLower) && !aliasMap.has(aliasLower)) {
                aliasMap.set(aliasLower, entry);
              }
            }
          }
        }
      }
    }
    console.log(`[L3 Miner] 词库加载完成：${wordsRes.rows.length} 词条，索引键：${exactMap.size} exact, ${aliasMap.size} aliases`);

    // 2. 加载 2025 英语二的 6 篇文章
    const sourcesRes = await tx.query<{
      id: string;
      title: string;
      content_text: string;
    }>(
      `SELECT id, title, content_text
       FROM l3_sources
       WHERE user_id = $1::uuid AND title LIKE '2025 英语二%'
       ORDER BY title ASC`,
      [OWNER_ID]
    );

    console.log(`[L3 Miner] 匹配到 2025 考研真题来源 ${sourcesRes.rows.length} 篇`);
    if (sourcesRes.rows.length === 0) {
      throw new Error("未找到 2025 英语二来源，请确认 l3_sources 已入库");
    }

    if (isClean && !isDryRun) {
      console.log("[L3 Miner] 正在清理已有 2025 语境与词次...");
      const sourceIds = sourcesRes.rows.map((s) => s.id);
      await tx.query(
        `DELETE FROM l3_contexts WHERE user_id = $1::uuid AND source_id = ANY($2::uuid[])`,
        [OWNER_ID, sourceIds]
      );
      console.log("[L3 Miner] 旧语境已清理");
    }

    const minedContexts: MinedContext[] = [];
    const matchedWordIds = new Set<string>();

    for (const source of sourcesRes.rows) {
      const sentences = extractSentences(source.content_text);
      console.log(`  📄 ${source.title} (${source.content_text.length} 字符) -> 切出 ${sentences.length} 句`);

      for (const sent of sentences) {
        // 校验原文切片一致性
        const slice = source.content_text.slice(sent.start, sent.end);
        if (slice !== sent.text) {
          throw new Error(`锚点切片与文本不一致！start=${sent.start}, end=${sent.end}`);
        }

        // 扫描该句子中的单词
        const occurrences: MinedOccurrence[] = [];
        const seenWordsInSentence = new Set<string>();
        const wordRegex = /\b[a-zA-Z]+(?:'[a-zA-Z]+)?\b/g;

        let match: RegExpExecArray | null;
        while ((match = wordRegex.exec(sent.text)) !== null) {
          const surface = match[0];
          const startOffset = match.index;
          const endOffset = startOffset + surface.length;

          const hit = resolveWord(surface, exactMap, aliasMap);
          if (hit) {
            // 同一句中同一单词保留首个命中
            if (!seenWordsInSentence.has(hit.id)) {
              seenWordsInSentence.add(hit.id);
              matchedWordIds.add(hit.id);
              occurrences.push({
                wordId: hit.id,
                surface,
                lemma: hit.lemma,
                startOffset,
                endOffset,
                boundSense: hit.short_definition,
              });
            }
          }
        }

        // 仅保留包含词库词汇的句子
        if (occurrences.length > 0) {
          minedContexts.push({
            sourceId: source.id,
            sourceTitle: source.title,
            text: sent.text,
            anchorStart: sent.start,
            anchorEnd: sent.end,
            occurrences,
          });
        }
      }
    }

    const totalOccurrences = minedContexts.reduce((sum, c) => sum + c.occurrences.length, 0);
    console.log("\n================ [挖掘统计] ================");
    console.log(`有效语境句子数 (l3_contexts)   : ${minedContexts.length} 句`);
    console.log(`词次圈记总数 (l3_occurrences)  : ${totalOccurrences} 次`);
    console.log(`覆盖独立词条数 (distinct words): ${matchedWordIds.size} 词`);
    console.log("============================================\n");

    // 每个来源预览 1 条样本
    console.log("--- 各篇语境样本抽样 ---");
    const seenSources = new Set<string>();
    for (const c of minedContexts) {
      if (!seenSources.has(c.sourceId)) {
        seenSources.add(c.sourceId);
        console.log(`[来源] 《${c.sourceTitle}》 锚点: [${c.anchorStart}, ${c.anchorEnd}]`);
        console.log(`  原文: "${c.text}"`);
        console.log(`  匹配词次 (${c.occurrences.length}):`);
        for (const occ of c.occurrences.slice(0, 8)) {
          console.log(`    - "${occ.surface}" (${occ.lemma}) [${occ.startOffset}:${occ.endOffset}] -> ${occ.boundSense ?? "无释义"}`);
        }
        if (c.occurrences.length > 8) {
          console.log(`    ... 其余 ${c.occurrences.length - 8} 词略`);
        }
        console.log();
      }
    }

    if (isDryRun) {
      console.log("[L3 Miner] DRY-RUN 完成，未修改数据库。");
      return;
    }

    // 3. 正式落库
    console.log("[L3 Miner] 开始批量写入 l3_contexts 与 l3_occurrences...");
    let contextInsertCount = 0;
    let occurrenceInsertCount = 0;

    for (const item of minedContexts) {
      // 写入 l3_contexts
      const ctxRes = await tx.query<{ id: string }>(
        `INSERT INTO l3_contexts
           (source_id, user_id, context_type, text, position, language, metadata)
         VALUES ($1::uuid, $2::uuid, 'sentence', $3, $4::jsonb, 'en', $5::jsonb)
         RETURNING id`,
        [
          item.sourceId,
          OWNER_ID,
          item.text,
          JSON.stringify({ start: item.anchorStart, end: item.anchorEnd }),
          JSON.stringify({ sourceTitle: item.sourceTitle, paper: "2025-kaoyan-en2", via: "kaoyan_corpus_miner" }),
        ]
      );
      const contextId = ctxRes.rows[0].id;
      contextInsertCount++;

      // 批量写入该语境对应的 l3_occurrences
      for (const occ of item.occurrences) {
        await tx.query(
          `INSERT INTO l3_occurrences
             (context_id, word_id, user_id, surface, lemma, start_offset, end_offset, confidence, evidence, bound_sense)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, 1.0000, $8::jsonb, $9)`,
          [
            contextId,
            occ.wordId,
            OWNER_ID,
            occ.surface,
            occ.lemma,
            occ.startOffset,
            occ.endOffset,
            JSON.stringify({ via: "kaoyan_corpus_miner", paper: "2025-kaoyan-en2" }),
            occ.boundSense,
          ]
        );
        occurrenceInsertCount++;
      }
    }

    console.log(`[L3 Miner] 写入完成！成功插入 ${contextInsertCount} 个 l3_contexts 和 ${occurrenceInsertCount} 个 l3_occurrences。`);
  }, { actorId: OWNER_ID });
}

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error("[L3 Miner] 失败:", err);
    process.exit(1);
  });
}
