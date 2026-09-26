/**
 * L3ErrorBookRepository —— 错题库的**统一读侧投影**（2026-09-26）。
 *
 * 为什么存在：错题此前只消费 `l3_practice_attempts`（句级），而题级错题的真源是
 * `l3_grading_results.verdict`（ADR-0035），全库没有任何 `verdict='wrong'` 的查询
 * ——题做完、判完、错了，却进不了错题库。两套 attempt 共享一个词、不共享真源。
 *
 * 纪律（红线）：
 *  - **不建表**。错题库永远是派生视图（ADR-0019 §1「错题库 = 派生，不建表」）。
 *  - **不新增真源**。本仓储只读；句级真源仍是 l3_practice_attempts，题级真源仍是
 *    l3_grading_results（attempt 永不带判定，ADR-0034 §2）。合并发生在读侧。
 *  - **零 FSRS**。不触碰 user_word_progress / user_word_l2_progress / review_logs
 *    （ADR-0004 §6：L3 永不调度）。
 *  - **不删不改**。软删的题级 attempt 仍以 `cleared` 形态出现（成绩被抹 ≠ 这题
 *    没做错），口径与「已录 N 条作答（含 M 条已清理）」一致。
 *
 * 口径：
 *  - 句级错 = l3_practice_attempts.outcome = 'wrong'
 *  - 题级错 = l3_grading_results.verdict IN ('wrong','partial')（partial 也算错：
 *    「部分对」在错题库里就是没拿下；correct 不进）
 *  - 两条腿各自按 (子空间 / 方向) 过滤、合并后统一按最近出错时间倒序，分页在
 *    **合并之后**（offset 口径；cursor 口径在两腿间不成立，故不提供）。
 */

import { BaseRepository } from "./base";
import type {
  L3ErrorBookKind,
  L3ErrorBookPage,
  L3UnifiedErrorBookItem,
} from "../domain";
import type { L3ErrorBookLookup, IL3ErrorBookRepository } from "./interfaces";

/** 单行 SQL 结果（两腿字段并集，缺列补 null）。 */
interface ErrorBookSqlRow {
  kind: L3ErrorBookKind;
  record_id: string;
  target_id: string;
  target_label: string | null;
  target_secondary: string | null;
  source_id: string | null;
  source_title: string | null;
  question_type: string | null;
  space: string | null;
  direction: string | null;
  sheet_id: string | null;
  practice_type: string | null;
  wrong_count: number;
  latest_outcome: string;
  latest_at: string;
  created_at: string;
}

function decodeNumber(value: unknown): number {
  return typeof value === "number" ? value : Number(value ?? 0);
}

function mapRow(row: ErrorBookSqlRow): L3UnifiedErrorBookItem {
  return {
    kind: row.kind,
    id: row.record_id,
    target_id: row.target_id,
    target_label: row.target_label ?? "",
    target_secondary: row.target_secondary ?? null,
    source_id: row.source_id,
    source_title: row.source_title,
    question_type: row.question_type,
    space: row.space,
    direction: row.direction,
    sheet_id: row.sheet_id,
    practice_type: row.practice_type,
    wrong_count: decodeNumber(row.wrong_count),
    latest_outcome: row.latest_outcome,
    latest_at: row.latest_at,
  };
}

/** 判定的可读标签（题级 verdict 与句级 outcome 不同源，标签分开给）。 */
export const ERROR_BOOK_OUTCOME_LABELS: Record<string, string> = {
  wrong: "错",
  partial: "部分对",
  correct: "对",
  skip: "跳过",
  sound: "站得住",
  questionable: "存疑",
};

export class L3ErrorBookRepository extends BaseRepository implements IL3ErrorBookRepository {
  /**
   * 合并两腿的错题条目。`kind` 可按腿过滤（null = 两腿都要）。
   * 排序键 (latest_at, record_id) 倒序；offset 分页在合并后进行。
   */
  async listUnified(input: L3ErrorBookLookup): Promise<L3ErrorBookPage> {
    const legs: Array<{ kind: L3ErrorBookKind; sql: string }> = [];
    if (input.kind === null || input.kind === "sentence") legs.push({ kind: "sentence", sql: this.sentenceLeg(input) });
    if (input.kind === null || input.kind === "question") legs.push({ kind: "question", sql: this.questionLeg(input) });

    if (legs.length === 0) {
      return { items: [], total: 0, limit: input.limit, offset: input.offset };
    }

    // 每条腿自带序号：合并后先按腿内时间倒序取窗口，再统一排序分页。
    const union = legs
      .map((leg, index) => `SELECT * FROM (${leg.sql}) AS leg_${index}`)
      .join(" UNION ALL ");

    const countRow = await this.queryOne<{ total: string }>(
      `SELECT count(*)::bigint AS total FROM (${union}) AS merged`,
      [],
    );
    const rows = await this.query<ErrorBookSqlRow>(
      `SELECT * FROM (${union}) AS merged
       ORDER BY merged.latest_at DESC, merged.record_id DESC
       LIMIT $1 OFFSET $2`,
      [input.limit, input.offset],
    );

    return {
      items: rows.map(mapRow),
      total: decodeNumber(countRow?.total),
      limit: input.limit,
      offset: input.offset,
    };
  }

  /**
   * 句级腿：`l3_practice_attempts` 的 wrong 记录，语境级聚合。
   * 子空间走 `l3_source_spaces` EXISTS（与既有句级错题口径逐字一致），方向取
   * `l3_sources.direction`。无来源的语境在轴过滤下自然落选（LEFT JOIN + 谓词）。
   */
  private sentenceLeg(input: L3ErrorBookLookup): string {
    const params: unknown[] = [input.userId];
    const filters: string[] = [];
    if (input.space) {
      params.push(input.space);
      filters.push(`EXISTS (SELECT 1 FROM l3_source_spaces sp
                             WHERE sp.source_id = s.id AND sp.user_id = s.user_id AND sp.space = $${params.length})`);
    }
    if (input.direction) {
      params.push(input.direction);
      filters.push(`s.direction = $${params.length}`);
    }
    const where = filters.length > 0 ? `AND ${filters.join(" AND ")}` : "";

    return `
      SELECT 'sentence'::text AS kind,
             a.id AS record_id,
             a.context_id AS target_id,
             c.text AS target_label,
             NULL::text AS target_secondary,
             c.source_id AS source_id,
             s.title AS source_title,
             NULL::text AS question_type,
             (SELECT sp2.space FROM l3_source_spaces sp2
               WHERE sp2.source_id = s.id AND sp2.user_id = s.user_id
               ORDER BY sp2.space LIMIT 1) AS space,
             s.direction AS direction,
             a.session_id AS sheet_id,
             a.practice_type AS practice_type,
             agg.wrong_count,
             agg.latest_outcome,
             agg.latest_at,
             a.created_at
      FROM l3_practice_attempts a
      JOIN l3_contexts c ON c.id = a.context_id AND c.user_id = a.user_id
      LEFT JOIN l3_sources s ON s.id = c.source_id AND s.user_id = a.user_id
      JOIN LATERAL (
        SELECT count(*) FILTER (WHERE w.outcome = 'wrong')::int AS wrong_count,
               (array_agg(w.outcome    ORDER BY w.created_at DESC, w.id DESC))[1] AS latest_outcome,
               (array_agg(w.created_at ORDER BY w.created_at DESC, w.id DESC))[1] AS latest_at
        FROM l3_practice_attempts w
        WHERE w.user_id = a.user_id AND w.context_id = a.context_id
      ) agg ON true
      WHERE a.user_id = $1::uuid AND a.outcome = 'wrong' ${where}
    `;
  }

  /**
   * 题级腿：`l3_grading_results` 判错/部分对的题，按 question 聚合。
   * 聚合口径与句级腿对齐（一条错题 = 一个 target 一行，wrongCount + 最近判定）。
   * 子空间取 `l3_questions.space`（录题时由题型自动落标，ADR-0030 §3）——与句级腿
   * 的 `l3_source_spaces` 是两套来源，但对**题**而言前者才是权威（题自带能力域）。
   */
  private questionLeg(input: L3ErrorBookLookup): string {
    const params: unknown[] = [input.userId];
    const filters: string[] = [];
    if (input.space) {
      params.push(input.space);
      filters.push(`q.space = $${params.length}`);
    }
    if (input.direction) {
      params.push(input.direction);
      filters.push(`s.direction = $${params.length}`);
    }
    const where = filters.length > 0 ? `AND ${filters.join(" AND ")}` : "";

    return `
      SELECT 'question'::text AS kind,
             g.id AS record_id,
             q.id AS target_id,
             left(q.stem, 120) AS target_label,
             q.question_type::text AS target_secondary,
             q.source_id AS source_id,
             s.title AS source_title,
             q.question_type::text AS question_type,
             q.space AS space,
             s.direction AS direction,
             g.sheet_id AS sheet_id,
             NULL::text AS practice_type,
             agg.wrong_count,
             agg.latest_outcome,
             agg.latest_at,
             g.graded_at AS created_at
      FROM l3_grading_results g
      JOIN l3_questions q ON q.id = g.question_id AND q.user_id = g.user_id
      LEFT JOIN l3_sources s ON s.id = q.source_id AND s.user_id = q.user_id
      JOIN LATERAL (
        SELECT count(*)::int AS wrong_count,
               (array_agg(gr.verdict  ORDER BY gr.graded_at DESC, gr.id DESC))[1] AS latest_outcome,
               (array_agg(gr.graded_at ORDER BY gr.graded_at DESC, gr.id DESC))[1] AS latest_at
        FROM l3_grading_results gr
        WHERE gr.user_id = g.user_id AND gr.question_id = g.question_id
          AND gr.verdict IN ('wrong', 'partial')
      ) agg ON true
      WHERE g.user_id = $1::uuid AND g.verdict IN ('wrong', 'partial') ${where}
    `;
  }
}
