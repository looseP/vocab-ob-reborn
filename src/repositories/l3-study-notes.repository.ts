/**
 * L3StudyNoteRepository — 学习笔记持久化（N1，ADR《study-notes-workspace》）。
 *
 * 职责：笔记行的 create/get/lock（FOR UPDATE）/CAS updateIfVersion/replaceVenues
 * （整体替换）/列表（venue 过滤、q 搜索、topicId position 排序、unfiled 子查询、
 * keyset 游标、count 为过滤总数不含游标）/listTopicBlockers（移除归属的 409 详情）。
 *
 * 写路径纪律：lock/updateIfVersion/replaceVenues 必须在事务内（requireTx），
 * 由 service 的 withTransaction(actorId) 提供（RLS claim 同事务）。
 */

import type { L3QuestionType } from "../domain";
import type { StudyNoteStatus } from "../domain";
import type { StudyCursor } from "./l3-study-cursor";
import { BaseRepository } from "./base";

export interface NewL3StudyNote {
  id: string;
  user_id: string;
  title: string;
  body_md: string;
  status: StudyNoteStatus;
  pinned: boolean;
  version: number;
  create_request_id: string;
  create_input_hash: string;
}

export interface L3StudyNoteRow {
  id: string;
  user_id: string;
  title: string;
  body_md: string;
  status: StudyNoteStatus;
  pinned: boolean;
  version: number;
  create_request_id: string;
  create_input_hash: string;
  last_write_request_id: string | null;
  last_write_hash: string | null;
  created_at: string;
  updated_at: string;
}

export interface StudyNoteSavePatch {
  title: string;
  body_md: string;
  status: StudyNoteStatus;
  pinned: boolean;
  last_write_request_id: string;
  last_write_hash: string;
}

export interface ListStudyNotesInput {
  userId: string;
  /** N1 列表 venue 必填（repo 层也收口：任何调用都必须带明确题型）。 */
  venue: L3QuestionType;
  q: string | null;
  status: StudyNoteStatus | null;
  pinned: boolean | null;
  /** 专题内列表（position 升序）；与 unfiled 互斥由 service/schema 保证。 */
  topicId: string | null;
  unfiled: boolean;
  cursor: StudyCursor | null;
  /** 期望条数上限；调用方按 (items.length > limit) 判 hasMore（取 limit+1 由调用方传入）。 */
  limit: number;
}

export interface L3StudyNoteListRow extends L3StudyNoteRow {
  /** topicId 过滤时携带成员 position（position 分页游标生成需要）。 */
  position?: number;
}

export interface L3StudyNoteListResult {
  items: L3StudyNoteListRow[];
  /** 与过滤条件一致的总数（不含游标）。 */
  total: number;
}

export interface StudyTopicBlockerRow {
  topic_id: string;
  title: string;
  status: string;
}

export interface IL3StudyNoteRepository {
  create(input: NewL3StudyNote): Promise<L3StudyNoteRow>;
  /**
   * 幂等创建（F1）：仅对 (user_id, create_request_id) 执行 ON CONFLICT DO NOTHING。
   * 冲突时不抛 23505、不中止事务；返回 null 表示键已存在（调用方需以**新语句**
   * 回读既有行并比对 create_input_hash）。requireTx（与 create 同）。
   */
  createIfAbsent(input: NewL3StudyNote): Promise<L3StudyNoteRow | null>;
  get(userId: string, noteId: string): Promise<L3StudyNoteRow | null>;
  /** 创建幂等回查：同 (user_id, create_request_id)。 */
  findByCreateRequestId(userId: string, requestId: string): Promise<L3StudyNoteRow | null>;
  /** 笔记行锁（保存路径第一步）。requireTx。 */
  lock(userId: string, noteId: string): Promise<L3StudyNoteRow | null>;
  /** CAS：仅当 version=expectedVersion 才更新；不匹配返回 null（service 转 409）。requireTx。 */
  updateIfVersion(
    userId: string,
    noteId: string,
    expectedVersion: number,
    patch: StudyNoteSavePatch,
  ): Promise<L3StudyNoteRow | null>;
  /** 归属整体替换（DELETE + unnest INSERT）。requireTx。 */
  replaceVenues(userId: string, noteId: string, venues: readonly L3QuestionType[]): Promise<void>;
  /** 单笔记归属（固定枚举序排序由调用方/展示层决定，repo 只回原集合）。 */
  listVenues(userId: string, noteId: string): Promise<L3QuestionType[]>;
  /** 批量归属（列表页避免 N+1）。 */
  listVenuesForNotes(userId: string, noteIds: readonly string[]): Promise<Map<string, L3QuestionType[]>>;
  list(input: ListStudyNotesInput): Promise<L3StudyNoteListResult>;
  /** 移除题型归属前的 409 详情：note 所属且题型命中的专题（含归档——成员关系仍在）。 */
  listTopicBlockers(
    userId: string,
    noteId: string,
    questionTypes: readonly L3QuestionType[],
  ): Promise<StudyTopicBlockerRow[]>;
}

export class L3StudyNoteRepository extends BaseRepository implements IL3StudyNoteRepository {
  async create(input: NewL3StudyNote): Promise<L3StudyNoteRow> {
    const row = await this.queryOne<L3StudyNoteRow>(
      `INSERT INTO l3_study_notes
         (id, user_id, title, body_md, status, pinned, version, create_request_id, create_input_hash)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8::uuid, $9)
       RETURNING *`,
      [
        input.id, input.user_id, input.title, input.body_md, input.status, input.pinned,
        input.version, input.create_request_id, input.create_input_hash,
      ],
    );
    return row!;
  }

  async get(userId: string, noteId: string): Promise<L3StudyNoteRow | null> {
    return this.queryOne<L3StudyNoteRow>(
      `SELECT * FROM l3_study_notes
        WHERE id = $1::uuid AND user_id = $2::uuid`,
      [noteId, userId],
    );
  }

  async createIfAbsent(input: NewL3StudyNote): Promise<L3StudyNoteRow | null> {
    return this.queryOne<L3StudyNoteRow>(
      `INSERT INTO l3_study_notes
         (id, user_id, title, body_md, status, pinned, version, create_request_id, create_input_hash)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8::uuid, $9)
       ON CONFLICT (user_id, create_request_id) DO NOTHING
       RETURNING *`,
      [
        input.id, input.user_id, input.title, input.body_md, input.status, input.pinned,
        input.version, input.create_request_id, input.create_input_hash,
      ],
    );
  }

  async findByCreateRequestId(userId: string, requestId: string): Promise<L3StudyNoteRow | null> {
    return this.queryOne<L3StudyNoteRow>(
      `SELECT * FROM l3_study_notes
        WHERE user_id = $1::uuid AND create_request_id = $2::uuid`,
      [userId, requestId],
    );
  }

  async lock(userId: string, noteId: string): Promise<L3StudyNoteRow | null> {
    this.requireTx();
    return this.queryOne<L3StudyNoteRow>(
      `SELECT * FROM l3_study_notes
        WHERE id = $1::uuid AND user_id = $2::uuid
        FOR UPDATE`,
      [noteId, userId],
    );
  }

  async updateIfVersion(
    userId: string,
    noteId: string,
    expectedVersion: number,
    patch: StudyNoteSavePatch,
  ): Promise<L3StudyNoteRow | null> {
    this.requireTx();
    return this.queryOne<L3StudyNoteRow>(
      `UPDATE l3_study_notes
          SET title = $4, body_md = $5, status = $6, pinned = $7,
              version = version + 1,
              last_write_request_id = $8::uuid, last_write_hash = $9,
              updated_at = now()
        WHERE id = $1::uuid AND user_id = $2::uuid AND version = $3::integer
        RETURNING *`,
      [
        noteId, userId, expectedVersion, patch.title, patch.body_md, patch.status,
        patch.pinned, patch.last_write_request_id, patch.last_write_hash,
      ],
    );
  }

  async replaceVenues(userId: string, noteId: string, venues: readonly L3QuestionType[]): Promise<void> {
    this.requireTx();
    await this.query(
      `DELETE FROM l3_study_note_venues WHERE note_id = $1::uuid AND user_id = $2::uuid`,
      [noteId, userId],
    );
    if (venues.length === 0) return;
    await this.query(
      `INSERT INTO l3_study_note_venues (note_id, user_id, question_type)
       SELECT $1::uuid, $2::uuid, unnest($3::text[])`,
      [noteId, userId, [...venues]],
    );
  }

  async listVenues(userId: string, noteId: string): Promise<L3QuestionType[]> {
    const rows = await this.query<{ question_type: L3QuestionType }>(
      `SELECT question_type FROM l3_study_note_venues
        WHERE note_id = $1::uuid AND user_id = $2::uuid`,
      [noteId, userId],
    );
    return rows.map((row) => row.question_type);
  }

  async listVenuesForNotes(
    userId: string,
    noteIds: readonly string[],
  ): Promise<Map<string, L3QuestionType[]>> {
    const map = new Map<string, L3QuestionType[]>();
    if (noteIds.length === 0) return map;
    const rows = await this.query<{ note_id: string; question_type: L3QuestionType }>(
      `SELECT note_id, question_type FROM l3_study_note_venues
        WHERE user_id = $1::uuid AND note_id = ANY($2::uuid[])`,
      [userId, [...noteIds]],
    );
    for (const row of rows) {
      const list = map.get(row.note_id) ?? [];
      list.push(row.question_type);
      map.set(row.note_id, list);
    }
    return map;
  }

  async list(input: ListStudyNotesInput): Promise<L3StudyNoteListResult> {
    const params: unknown[] = [input.userId, input.venue];
    const joins: string[] = [
      "JOIN l3_study_note_venues v ON v.note_id = n.id AND v.user_id = $1::uuid AND v.question_type = $2",
    ];
    const filters: string[] = ["n.user_id = $1::uuid"];
    if (input.status) {
      params.push(input.status);
      filters.push(`n.status = $${params.length}`);
    }
    if (input.pinned !== null) {
      params.push(input.pinned);
      filters.push(`n.pinned = $${params.length}`);
    }
    if (input.q && input.q.trim()) {
      params.push(`%${input.q.trim().replace(/[\\%_]/g, "\\$&")}%`);
      filters.push(
        `(n.title ILIKE $${params.length} ESCAPE '\\' OR n.body_md ILIKE $${params.length} ESCAPE '\\')`,
      );
    }

    // 专题内排序（position ASC）与默认时间排序（updatedAt DESC）互斥。
    let keyset = "";
    let orderBy: string;
    if (input.topicId) {
      params.push(input.topicId);
      joins.push(
        `JOIN l3_study_topic_notes tn ON tn.note_id = n.id AND tn.user_id = $1::uuid AND tn.topic_id = $${params.length}::uuid`,
      );
      orderBy = " ORDER BY tn.position ASC, n.id ASC";
    } else {
      if (input.unfiled) {
        filters.push(`NOT EXISTS (
          SELECT 1 FROM l3_study_topic_notes tnx
          JOIN l3_study_topics t ON t.id = tnx.topic_id AND t.user_id = tnx.user_id AND t.status = 'active'
          WHERE tnx.note_id = n.id AND tnx.user_id = n.user_id
        )`);
      }
      orderBy = " ORDER BY n.updated_at DESC, n.id DESC";
    }

    const fromWhere = `
        FROM l3_study_notes n
        ${joins.join("\n        ")}
       WHERE ${filters.join(" AND ")}`;

    // count 先行：过滤总数（**不含游标参数**——游标 push 必须发生在 count 之后，
    // 否则 bind 参数多于 SQL 占位符，真实 PG 直接报错）。参数浅拷贝定格，
    // 后续 keyset/limit 的 push 不影响本次已发出的查询。
    const totalRow = await this.queryOne<{ total: string }>(
      `SELECT count(*) AS total${fromWhere}`,
      [...params],
    );

    if (input.topicId) {
      if (input.cursor && input.cursor.sortKind === "position") {
        params.push(Number(input.cursor.lastSort), input.cursor.id);
        keyset = ` AND (tn.position, n.id) > ($${params.length - 1}::integer, $${params.length}::uuid)`;
      }
    } else if (input.cursor && input.cursor.sortKind === "updatedAt") {
      params.push(input.cursor.lastSort, input.cursor.id);
      keyset = ` AND (n.updated_at, n.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
    }

    params.push(input.limit);
    const items = await this.query<L3StudyNoteListRow>(
      `SELECT n.*${input.topicId ? ", tn.position" : ""}${fromWhere}${keyset}${orderBy}
       LIMIT $${params.length}`,
      params,
    );

    return { items, total: Number(totalRow?.total ?? 0) };
  }

  async listTopicBlockers(
    userId: string,
    noteId: string,
    questionTypes: readonly L3QuestionType[],
  ): Promise<StudyTopicBlockerRow[]> {
    return this.query<StudyTopicBlockerRow>(
      `SELECT t.id AS topic_id, t.title, t.status
         FROM l3_study_topic_notes tn
         JOIN l3_study_topics t ON t.id = tn.topic_id AND t.user_id = tn.user_id
        WHERE tn.user_id = $1::uuid AND tn.note_id = $2::uuid
          AND t.question_type = ANY($3::text[])
        ORDER BY t.updated_at DESC, t.id DESC`,
      [userId, noteId, [...questionTypes]],
    );
  }
}
