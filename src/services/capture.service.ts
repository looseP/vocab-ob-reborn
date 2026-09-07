/**
 * CaptureService — R1 reading-capture orchestration.
 *
 * Flow: normalize headword → ensure a minimal word stub exists →
 * single transaction: wordbook membership + note read + optional L3 trio.
 *
 * Two-phase by design: INSERT INTO words is reserved to the
 * vocab_batch_import role (batch pool), so the stub is ensured through
 * WordRepository.insertMany outside the app-role transaction; membership,
 * note read and the optional L3 trio land atomically inside it.
 *
 * L3 capture-first（grill 定案 2026-09-07，推翻本文件 2026-08-22 门控合同）：
 * 无稳定性门控——任何词（含 stub）遇到真实语境即可绑定。`sentence` 存在时
 * 在同一事务内写入 l3_sources / l3_contexts / l3_occurrences 三件套；
 * 三件套写入失败为 best-effort（吞掉，主捕获不回滚），l3Status 回落 'deferred'。
 * url → source_type='web'；否则 'manual'（obsidianRef 存 metadata）。
 * context_type 按长度：≤200 = 'sentence'，否则 'paragraph'。
 */

import { withTransaction } from "../db/transaction";
import { createRepositories } from "../repositories/factory";
import type { IWordRepository } from "../repositories/interfaces";
import type { Json } from "../domain";
import { ValidationError } from "../errors";
import { buildL3TrioInputs } from "./l3-trio";

export const CAPTURE_L3_STATUS = {
  /** sentence 落库成功。 */
  captured: "captured",
  /** 未提供 sentence，或三件套写入失败（best-effort 回落）。 */
  deferred: "deferred",
} as const;

export interface CaptureInput {
  userId: string;
  wordbookId: string;
  headword: string;
  /** L3 capture-first：提供即同事务落三件套（best-effort）。 */
  sentence?: string;
  /** 可选来源 url：有值 → source_type='web'，否则 'manual'。 */
  sourceUrl?: string;
  /** 可选 obsidianRef：写入 source.metadata。 */
  obsidianRef?: string;
}

export interface CaptureResult {
  ok: true;
  /** False when this call created the word stub. */
  existed: boolean;
  word: {
    id: string;
    slug: string;
    title: string;
    lemma: string;
    shortDefinition: string | null;
  };
  noteContentMd: string | null;
  l3Status: keyof typeof CAPTURE_L3_STATUS;
  sourceId: string | null;
  contextId: string | null;
  occurrenceId: string | null;
}

export function slugifyHeadword(headword: string): string {
  return headword
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
}

export class CaptureService {
  constructor(private readonly words: IWordRepository) {}

  async capture(input: CaptureInput): Promise<CaptureResult> {
    const title = input.headword.trim();
    const slug = slugifyHeadword(title);
    if (!slug) {
      throw new ValidationError("headword must contain latin word characters", "headword");
    }

    let row = await this.words.findBySlug(slug);
    let existed = row != null;
    if (!row) {
      if (!this.words.insertMany) throw new Error("insertMany not configured");
      await this.words.insertMany([
        { slug, title, lemma: title, pos: null, cefr: null, ipa: null, short_definition: null },
      ]);
      row = await this.words.findBySlug(slug);
      if (!row) throw new Error(`capture word upsert failed for slug "${slug}"`);
      existed = false;
    }
    const wordRow = row;

    const transactionResult = await withTransaction(async (tx) => {
      const repos = createRepositories(tx);

      await repos.wordbooks.addWords(input.wordbookId, [wordRow.id]);

      // 条目制笔记(2026-09-06):可见条目按行拼接,作为既有批注上下文返回
      const noteEntriesRows = await repos.noteEntries.listVisibleByWordIds(
        input.userId,
        input.wordbookId,
        [wordRow.id],
      );

      // L3 capture-first（grill 定案 2026-09-07）：sentence 存在即同事务落三件套。
      // best-effort：三件套失败不否定主捕获（与 L2 transition 的 best-effort 同哲学）。
      let l3Status: keyof typeof CAPTURE_L3_STATUS = "deferred";
      let sourceId: string | null = null;
      let contextId: string | null = null;
      let occurrenceId: string | null = null;
      if (input.sentence && input.sentence.trim().length > 0) {
        try {
          const trio = buildL3TrioInputs({
            userId: input.userId,
            wordId: wordRow.id,
            lemma: wordRow.lemma,
            sentence: input.sentence.trim(),
            sourceUrl: input.sourceUrl,
            obsidianRef: input.obsidianRef,
          });
          const source = await repos.l3Context.createSource({
            ...trio.source,
            metadata: trio.source.metadata as Json,
          });
          const context = await repos.l3Context.createContext({
            ...trio.context,
            source_id: source.id,
            metadata: trio.context.metadata as Json,
            position: trio.context.position as Json,
          });
          const occurrence = await repos.l3Context.createOccurrence({
            ...trio.occurrence,
            context_id: context.id,
            evidence: trio.occurrence.evidence as Json,
          });
          l3Status = "captured";
          sourceId = source.id;
          contextId = context.id;
          occurrenceId = occurrence.id;
        } catch {
          // 三件套失败回落 deferred；主捕获结果不受影响。
        }
      }

      return {
        result: {
          ok: true as const,
          existed,
          word: {
            id: wordRow.id,
            slug: wordRow.slug,
            title: wordRow.title,
            lemma: wordRow.lemma,
            shortDefinition: wordRow.short_definition,
          },
          noteContentMd: noteEntriesRows.length
            ? noteEntriesRows.map((entry) => entry.content_md).join("\n")
            : null,
          l3Status,
          sourceId,
          contextId,
          occurrenceId,
        } satisfies CaptureResult,
      };
    }, { actorId: input.userId });

    return transactionResult.result;
  }
}
