/**
 * L3AnnotationRepository — 做题注记（原文分析条目）与规律标签字典持久化
 * （批次一，0033）。
 *
 * 行级隔离由 RLS own_all policy 兜底，所有查询显式带 user_id。锚点幂等
 * （同题同锚点不重复插入）由 service 调 findByAnchor 编排；标签整存必须在
 * 事务内（软删旧行 + 插新行原子完成）。
 */

import type {
  L3AnnotationOptionKey,
  L3AnnotationTagKind,
  L3AnnotationTagRow,
  L3QuestionAnnotationRow,
} from "../domain";
import type {
  IL3AnnotationRepository,
  L3QuestionAnnotationPatchDb,
  NewL3QuestionAnnotation,
} from "./interfaces";
import { BaseRepository } from "./base";

interface AnnotationDbRow {
  id: string;
  user_id: string;
  question_id: string;
  ordinal: number;
  anchor_start: number | null;
  anchor_end: number | null;
  excerpt: string | null;
  note: string;
  entry_tags: unknown;
  option_tags: unknown;
  status: "active" | "deleted";
  created_at: string;
  updated_at: string;
}

function mapAnnotationRow(row: AnnotationDbRow): L3QuestionAnnotationRow {
  return {
    ...row,
    ordinal: Number(row.ordinal),
    entry_tags: Array.isArray(row.entry_tags) ? (row.entry_tags as string[]) : [],
    option_tags:
      row.option_tags && typeof row.option_tags === "object"
        ? (row.option_tags as Partial<Record<L3AnnotationOptionKey, string[]>>)
        : {},
  };
}

interface TagDbRow {
  id: string;
  user_id: string;
  kind: L3AnnotationTagKind;
  label: string;
  ordinal: number;
  status: "active" | "deleted";
  created_at: string;
  updated_at: string;
}

function mapTagRow(row: TagDbRow): L3AnnotationTagRow {
  return { ...row, ordinal: Number(row.ordinal) };
}

/** PATCH 动态 SET 白名单：键顺序即多列提交时的占位顺序。 */
const PATCH_COLUMNS: ReadonlyArray<{ key: keyof L3QuestionAnnotationPatchDb; column: string; jsonb: boolean }> = [
  { key: "anchor_start", column: "anchor_start", jsonb: false },
  { key: "anchor_end", column: "anchor_end", jsonb: false },
  { key: "excerpt", column: "excerpt", jsonb: false },
  { key: "note", column: "note", jsonb: false },
  { key: "entry_tags", column: "entry_tags", jsonb: true },
  { key: "option_tags", column: "option_tags", jsonb: true },
];

export class L3AnnotationRepository extends BaseRepository implements IL3AnnotationRepository {
  async listForQuestions(userId: string, questionIds: readonly string[]): Promise<L3QuestionAnnotationRow[]> {
    if (questionIds.length === 0) return [];
    const rows = await this.query<AnnotationDbRow>(
      `SELECT * FROM l3_question_annotations
        WHERE user_id = $1::uuid AND status = 'active' AND id = ANY($2::uuid[])
        ORDER BY question_id, ordinal, created_at, id`,
      [userId, questionIds as string[]],
    );
    return rows.map(mapAnnotationRow);
  }

  async findByAnchor(
    userId: string,
    questionId: string,
    anchorStart: number,
    anchorEnd: number,
  ): Promise<L3QuestionAnnotationRow | null> {
    const row = await this.queryOne<AnnotationDbRow>(
      `SELECT * FROM l3_question_annotations
        WHERE user_id = $1::uuid AND question_id = $2::uuid
          AND anchor_start = $3 AND anchor_end = $4 AND status = 'active'`,
      [userId, questionId, anchorStart, anchorEnd],
    );
    return row ? mapAnnotationRow(row) : null;
  }

  async insertAnnotation(input: NewL3QuestionAnnotation): Promise<L3QuestionAnnotationRow> {
    const row = await this.queryOne<AnnotationDbRow>(
      `INSERT INTO l3_question_annotations
         (user_id, question_id, ordinal, anchor_start, anchor_end, excerpt,
          note, entry_tags, option_tags)
       VALUES ($1::uuid, $2::uuid,
         COALESCE($3,
           (SELECT COALESCE(MAX(ordinal) + 1, 0) AS max_ordinal
              FROM l3_question_annotations
             WHERE question_id = $2::uuid AND user_id = $1::uuid AND status = 'active')),
         $4, $5, $6, $7, $8::jsonb, $9::jsonb)
       RETURNING *`,
      [
        input.user_id,
        input.question_id,
        input.ordinal ?? null,
        input.anchor_start,
        input.anchor_end,
        input.excerpt,
        input.note,
        JSON.stringify(input.entry_tags),
        JSON.stringify(input.option_tags),
      ],
    );
    if (!row) throw new Error("annotation insert returned no row");
    return mapAnnotationRow(row);
  }

  async updateAnnotation(
    userId: string,
    id: string,
    patch: L3QuestionAnnotationPatchDb,
  ): Promise<L3QuestionAnnotationRow | null> {
    const sets: string[] = [];
    const params: unknown[] = [userId, id];
    for (const { key, column, jsonb } of PATCH_COLUMNS) {
      const value = patch[key];
      if (value === undefined) continue;
      params.push(jsonb ? JSON.stringify(value) : value);
      sets.push(`${column} = $${params.length}${jsonb ? "::jsonb" : ""}`);
    }
    if (sets.length === 0) {
      const current = await this.queryOne<AnnotationDbRow>(
        `SELECT * FROM l3_question_annotations
          WHERE id = $2::uuid AND user_id = $1::uuid AND status = 'active'`,
        params,
      );
      return current ? mapAnnotationRow(current) : null;
    }
    sets.push("updated_at = now()");
    const row = await this.queryOne<AnnotationDbRow>(
      `UPDATE l3_question_annotations
          SET ${sets.join(", ")}
        WHERE id = $2::uuid AND user_id = $1::uuid AND status = 'active'
        RETURNING *`,
      params,
    );
    return row ? mapAnnotationRow(row) : null;
  }

  async softDeleteAnnotation(userId: string, id: string): Promise<boolean> {
    const row = await this.queryOne<{ id: string }>(
      `UPDATE l3_question_annotations
          SET status = 'deleted', updated_at = now()
        WHERE user_id = $1::uuid AND id = $2::uuid AND status = 'active'
        RETURNING id`,
      [userId, id],
    );
    return Boolean(row);
  }

  async listTags(userId: string): Promise<L3AnnotationTagRow[]> {
    const rows = await this.query<TagDbRow>(
      `SELECT * FROM l3_annotation_tags
        WHERE user_id = $1::uuid AND status = 'active'
        ORDER BY kind, ordinal, created_at, id`,
      [userId],
    );
    return rows.map(mapTagRow);
  }

  async replaceTags(
    userId: string,
    dict: { entry: readonly string[]; option: readonly string[] },
  ): Promise<L3AnnotationTagRow[]> {
    this.requireTx();
    await this.query(
      `UPDATE l3_annotation_tags SET status = 'deleted', updated_at = now()
        WHERE user_id = $1::uuid AND status = 'active'`,
      [userId],
    );
    const triples: Array<[L3AnnotationTagKind, string, number]> = [
      ...dict.entry.map((label, index): [L3AnnotationTagKind, string, number] => ["entry", label, index]),
      ...dict.option.map((label, index): [L3AnnotationTagKind, string, number] => ["option", label, index]),
    ];
    if (triples.length === 0) return [];
    const values = triples
      .map((_, index) => {
        const base = index * 4;
        return `($${base + 1}::uuid, $${base + 2}, $${base + 3}, $${base + 4})`;
      })
      .join(", ");
    const params: unknown[] = triples.flatMap(([kind, label, ordinal]) => [userId, kind, label, ordinal]);
    const rows = await this.query<TagDbRow>(
      `INSERT INTO l3_annotation_tags (user_id, kind, label, ordinal)
       VALUES ${values}
       RETURNING *`,
      params,
    );
    return rows.map(mapTagRow);
  }
}
