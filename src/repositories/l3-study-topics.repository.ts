/**
 * L3StudyTopicRepository — 平面专题持久化（N1）：create/get/lock（FOR UPDATE）/
 * CAS updateIfVersion/列表（venue+status keyset）/成员（list/insert/delete/
 * 0..n-1 批重排/计数）。
 *
 * 锁序纪律：专题成员操作由 service 先锁 topic（lock，requireTx）再触成员行；
 * 笔记保存路径只**普通读**成员（listMembers），不反向取 topic 锁——全代码维持
 * topic→note 单一方向，避免死锁。
 */

import type { L3QuestionType, StudyTopicStatus } from "../domain";
import { BaseRepository } from "./base";

export interface NewL3StudyTopic {
  id: string;
  user_id: string;
  question_type: L3QuestionType;
  title: string;
  status: StudyTopicStatus;
  version: number;
  create_request_id: string;
  create_input_hash: string;
}

export interface L3StudyTopicRow {
  id: string;
  user_id: string;
  question_type: L3QuestionType;
  title: string;
  status: StudyTopicStatus;
  version: number;
  create_request_id: string;
  create_input_hash: string;
  last_write_request_id: string | null;
  last_write_hash: string | null;
  created_at: string;
  updated_at: string;
}

export interface StudyTopicSavePatch {
  title: string;
  status: StudyTopicStatus;
  last_write_request_id: string;
  last_write_hash: string;
}

export interface ListStudyTopicsInput {
  userId: string;
  /** N1 列表 venue 必填。 */
  questionType: L3QuestionType;
  status: StudyTopicStatus | null;
  cursor: { updatedAt: string; id: string } | null;
  /** 调用方按 hasMore 语义传 limit+1。 */
  limit: number;
}

export interface L3StudyTopicListResult {
  items: L3StudyTopicRow[];
  /** 与过滤条件一致的总数（不含游标）。 */
  total: number;
}

export interface StudyTopicMemberRow {
  note_id: string;
  position: number;
}

export interface IL3StudyTopicRepository {
  create(input: NewL3StudyTopic): Promise<L3StudyTopicRow>;
  get(userId: string, topicId: string): Promise<L3StudyTopicRow | null>;
  /** 创建幂等回查：同 (user_id, create_request_id)。 */
  findByCreateRequestId(userId: string, requestId: string): Promise<L3StudyTopicRow | null>;
  /** 专题行锁（成员操作的锁序第一步）。requireTx。 */
  lock(userId: string, topicId: string): Promise<L3StudyTopicRow | null>;
  /** CAS：version 不匹配返回 null。requireTx。 */
  updateIfVersion(
    userId: string,
    topicId: string,
    expectedVersion: number,
    patch: StudyTopicSavePatch,
  ): Promise<L3StudyTopicRow | null>;
  /** 仅推进版本与幂等列（成员操作共享 topic 版本；不动 title/status）。requireTx。 */
  bumpVersion(
    userId: string,
    topicId: string,
    expectedVersion: number,
    lastWriteRequestId: string,
    lastWriteHash: string,
  ): Promise<L3StudyTopicRow | null>;
  list(input: ListStudyTopicsInput): Promise<L3StudyTopicListResult>;
  /** 成员（position ASC, note_id ASC）；保存路径允许普通读。 */
  listMembers(userId: string, topicId: string): Promise<StudyTopicMemberRow[]>;
  countMembers(userId: string, topicId: string): Promise<number>;
  /** 批量成员计数（专题列表避免 N+1）。 */
  countMembersForTopics(userId: string, topicIds: readonly string[]): Promise<Map<string, number>>;
  /** 加入成员（position 由 service 计算）。requireTx。 */
  insertMember(input: { topicId: string; noteId: string; userId: string; position: number }): Promise<void>;
  /** 移出成员，返回是否删除了行。requireTx。 */
  deleteMember(userId: string, topicId: string, noteId: string): Promise<boolean>;
  /** 按传入有序 id 列表重分配 0..n-1（service 已在锁内计算完整顺序）。requireTx。 */
  replaceMemberPositions(userId: string, topicId: string, orderedNoteIds: readonly string[]): Promise<void>;
}

export class L3StudyTopicRepository extends BaseRepository implements IL3StudyTopicRepository {
  async create(input: NewL3StudyTopic): Promise<L3StudyTopicRow> {
    const row = await this.queryOne<L3StudyTopicRow>(
      `INSERT INTO l3_study_topics
         (id, user_id, question_type, title, status, version, create_request_id, create_input_hash)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::uuid, $8)
       RETURNING *`,
      [
        input.id, input.user_id, input.question_type, input.title, input.status,
        input.version, input.create_request_id, input.create_input_hash,
      ],
    );
    return row!;
  }

  async get(userId: string, topicId: string): Promise<L3StudyTopicRow | null> {
    return this.queryOne<L3StudyTopicRow>(
      `SELECT * FROM l3_study_topics
        WHERE id = $1::uuid AND user_id = $2::uuid`,
      [topicId, userId],
    );
  }

  async findByCreateRequestId(userId: string, requestId: string): Promise<L3StudyTopicRow | null> {
    return this.queryOne<L3StudyTopicRow>(
      `SELECT * FROM l3_study_topics
        WHERE user_id = $1::uuid AND create_request_id = $2::uuid`,
      [userId, requestId],
    );
  }

  async bumpVersion(
    userId: string,
    topicId: string,
    expectedVersion: number,
    lastWriteRequestId: string,
    lastWriteHash: string,
  ): Promise<L3StudyTopicRow | null> {
    this.requireTx();
    return this.queryOne<L3StudyTopicRow>(
      `UPDATE l3_study_topics
          SET version = version + 1,
              last_write_request_id = $4::uuid, last_write_hash = $5,
              updated_at = now()
        WHERE id = $1::uuid AND user_id = $2::uuid AND version = $3::integer
        RETURNING *`,
      [topicId, userId, expectedVersion, lastWriteRequestId, lastWriteHash],
    );
  }

  async lock(userId: string, topicId: string): Promise<L3StudyTopicRow | null> {
    this.requireTx();
    return this.queryOne<L3StudyTopicRow>(
      `SELECT * FROM l3_study_topics
        WHERE id = $1::uuid AND user_id = $2::uuid
        FOR UPDATE`,
      [topicId, userId],
    );
  }

  async updateIfVersion(
    userId: string,
    topicId: string,
    expectedVersion: number,
    patch: StudyTopicSavePatch,
  ): Promise<L3StudyTopicRow | null> {
    this.requireTx();
    return this.queryOne<L3StudyTopicRow>(
      `UPDATE l3_study_topics
          SET title = $4, status = $5,
              version = version + 1,
              last_write_request_id = $6::uuid, last_write_hash = $7,
              updated_at = now()
        WHERE id = $1::uuid AND user_id = $2::uuid AND version = $3::integer
        RETURNING *`,
      [topicId, userId, expectedVersion, patch.title, patch.status, patch.last_write_request_id, patch.last_write_hash],
    );
  }

  async list(input: ListStudyTopicsInput): Promise<L3StudyTopicListResult> {
    const params: unknown[] = [input.userId, input.questionType];
    const filters: string[] = ["t.user_id = $1::uuid", "t.question_type = $2"];
    if (input.status) {
      params.push(input.status);
      filters.push(`t.status = $${params.length}`);
    }

    const totalRow = await this.queryOne<{ total: string }>(
      `SELECT count(*) AS total FROM l3_study_topics t WHERE ${filters.join(" AND ")}`,
      params,
    );

    let keyset = "";
    if (input.cursor) {
      params.push(input.cursor.updatedAt, input.cursor.id);
      keyset = ` AND (t.updated_at, t.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
    }
    params.push(input.limit);
    const items = await this.query<L3StudyTopicRow>(
      `SELECT t.* FROM l3_study_topics t
        WHERE ${filters.join(" AND ")}${keyset}
        ORDER BY t.updated_at DESC, t.id DESC
        LIMIT $${params.length}`,
      params,
    );

    return { items, total: Number(totalRow?.total ?? 0) };
  }

  async listMembers(userId: string, topicId: string): Promise<StudyTopicMemberRow[]> {
    return this.query<StudyTopicMemberRow>(
      `SELECT note_id, position FROM l3_study_topic_notes
        WHERE topic_id = $1::uuid AND user_id = $2::uuid
        ORDER BY position ASC, note_id ASC`,
      [topicId, userId],
    );
  }

  async countMembers(userId: string, topicId: string): Promise<number> {
    const row = await this.queryOne<{ n: string }>(
      `SELECT count(*) AS n FROM l3_study_topic_notes
        WHERE topic_id = $1::uuid AND user_id = $2::uuid`,
      [topicId, userId],
    );
    return Number(row?.n ?? 0);
  }

  async countMembersForTopics(
    userId: string,
    topicIds: readonly string[],
  ): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    if (topicIds.length === 0) return map;
    const rows = await this.query<{ topic_id: string; n: string }>(
      `SELECT topic_id, count(*) AS n FROM l3_study_topic_notes
        WHERE user_id = $1::uuid AND topic_id = ANY($2::uuid[])
        GROUP BY topic_id`,
      [userId, [...topicIds]],
    );
    for (const row of rows) {
      map.set(row.topic_id, Number(row.n));
    }
    return map;
  }

  async insertMember(input: { topicId: string; noteId: string; userId: string; position: number }): Promise<void> {
    this.requireTx();
    await this.query(
      `INSERT INTO l3_study_topic_notes (topic_id, note_id, user_id, position)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4)`,
      [input.topicId, input.noteId, input.userId, input.position],
    );
  }

  async deleteMember(userId: string, topicId: string, noteId: string): Promise<boolean> {
    this.requireTx();
    const { rowCount } = await this.executor.query(
      `DELETE FROM l3_study_topic_notes
        WHERE topic_id = $1::uuid AND note_id = $2::uuid AND user_id = $3::uuid`,
      [topicId, noteId, userId],
    );
    return (rowCount ?? 0) > 0;
  }

  async replaceMemberPositions(userId: string, topicId: string, orderedNoteIds: readonly string[]): Promise<void> {
    this.requireTx();
    if (orderedNoteIds.length === 0) return;
    await this.query(
      `UPDATE l3_study_topic_notes AS tn
          SET position = o.ord - 1
         FROM unnest($3::uuid[]) WITH ORDINALITY AS o(note_id, ord)
        WHERE tn.topic_id = $1::uuid AND tn.user_id = $2::uuid
          AND tn.note_id = o.note_id`,
      [topicId, userId, [...orderedNoteIds]],
    );
  }
}
