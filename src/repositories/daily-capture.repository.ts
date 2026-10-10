/**
 * DailyCaptureRepository — 每日捕获持久化（2026-10-10，M1 捕获侧）。
 *
 * 边界（设计定稿 §4/§12）：
 *   - 只写 `daily_capture_entries` / `daily_capture_types` 两张新表
 *     （owner RLS own_all），**不改任何已有表**；零 FSRS 写入。
 *   - 条目是唯一真相；本层不产出 markdown —— 日文件是 (entry_date, seq)
 *     确定性投影，由 domain/daily-capture.ts 纯函数渲染（服务层组装）。
 *   - `entry_type` 对类型注册表是**软引用**：完整性由服务层校验（未知类型
 *     422），本层不做 FK 级联语义。
 *
 * 事务：两表均 owner-RLS，所有查询方法 MUST 经 withTransaction(..., { actorId })
 * 调用（池直连会因 RLS 静默返回空）。seq 由 INSERT..SELECT coalesce(max,0)+1
 * 单语句原子分配，(user_id, entry_date, seq) 唯一索引兜底并发。
 */

import {
  DEFAULT_DAILY_CAPTURE_TYPES,
  type DailyCaptureAbsorptionReceipt,
  type DailyCaptureDaySummary,
  type DailyCaptureEntryRow,
  type DailyCaptureTypeRow,
} from "../domain/daily-capture";
import type { IDailyCaptureRepository } from "./interfaces";
import { BaseRepository } from "./base";
import { formatClockInDisplayTz, todayKeyInDisplayTz } from "../db/timezone";

/** 显示时区日历日（YYYY-MM-DD）—— 服务层用于「缺省今天」。仓储层可合法 import db/timezone。 */
export function todayEntryDateKey(): string {
  return todayKeyInDisplayTz();
}

/** 显示时区墙钟（HH:MM）—— 服务层注入日文件渲染器（domain 禁 import db/*）。 */
export function formatEntryClock(iso: string): string {
  return formatClockInDisplayTz(iso);
}

export class DailyCaptureRepository extends BaseRepository implements IDailyCaptureRepository {
  /**
   * 幂等 seed 默认类型（首条追加时调用；ON CONFLICT DO NOTHING —— 用户已
   * 自定义的行不被覆盖）。单条语句，MUST be in a transaction（与后续
   * insertEntry 同事务，避免「类型校验时 seed 未落」的窗口）。
   */
  async ensureDefaultTypes(userId: string): Promise<void> {
    const values: unknown[] = [];
    const tuples = DEFAULT_DAILY_CAPTURE_TYPES.map(
      (type) =>
        `($1::uuid, $${values.push(type.typeKey)}, $${values.push(type.label)}, $${values.push(type.absorptionHint)}, $${values.push(type.sort)})`,
    );
    values.unshift(userId);
    await this.query(
      `INSERT INTO daily_capture_types (user_id, type_key, label, absorption_hint, sort)
       VALUES ${tuples.join(", ")}
       ON CONFLICT (user_id, type_key) DO NOTHING`,
      values,
    );
  }

  async listTypes(userId: string): Promise<DailyCaptureTypeRow[]> {
    return this.query<DailyCaptureTypeRow>(
      `SELECT * FROM daily_capture_types WHERE user_id = $1::uuid ORDER BY sort ASC, type_key ASC`,
      [userId],
    );
  }

  /**
   * 追加一条（seq 单语句原子分配）。meta 需 stringify（jsonb 参数）。
   * 并发撞 day_seq_unique 会抛 23505 —— 服务层重试一次（单用户场景近乎不可达）。
   */
  async insertEntry(input: {
    user_id: string;
    entry_date: string;
    entry_type: string;
    content: string;
    meta: Record<string, unknown> | null;
  }): Promise<DailyCaptureEntryRow> {
    const row = await this.queryOne<DailyCaptureEntryRow>(
      `INSERT INTO daily_capture_entries (user_id, entry_date, seq, entry_type, content, meta)
       SELECT $1::uuid, $2::date, COALESCE(MAX(seq), 0) + 1, $3, $4, $5::jsonb
         FROM daily_capture_entries WHERE user_id = $1::uuid AND entry_date = $2::date
       RETURNING *`,
      [
        input.user_id,
        input.entry_date,
        input.entry_type,
        input.content,
        input.meta === null ? null : JSON.stringify(input.meta),
      ],
    );
    if (!row) throw new Error("daily capture insert returned no row");
    return row;
  }

  /** 单条（未隐藏）；不存在/已隐藏 = null。 */
  async findEntry(userId: string, id: string): Promise<DailyCaptureEntryRow | null> {
    return this.queryOne<DailyCaptureEntryRow>(
      `SELECT * FROM daily_capture_entries WHERE user_id = $1::uuid AND id = $2::uuid AND hidden_at IS NULL`,
      [userId, id],
    );
  }

  async appendAbsorption(
    userId: string,
    id: string,
    receipt: DailyCaptureAbsorptionReceipt,
    nextStatus: DailyCaptureEntryRow["status"],
  ): Promise<DailyCaptureEntryRow | null> {
    return this.queryOne<DailyCaptureEntryRow>(
      `UPDATE daily_capture_entries
          SET absorption = COALESCE(absorption, '[]'::jsonb) || $3::jsonb,
              status = $4
        WHERE user_id = $1::uuid AND id = $2::uuid
          AND hidden_at IS NULL
          AND status NOT IN ('absorbed', 'archived')
        RETURNING *`,
      [userId, id, JSON.stringify([receipt]), nextStatus],
    );
  }

  /** 当日条目（未隐藏、seq 升序）。 */
  async listDay(userId: string, entryDate: string): Promise<DailyCaptureEntryRow[]> {
    return this.query<DailyCaptureEntryRow>(
      `SELECT * FROM daily_capture_entries
        WHERE user_id = $1::uuid AND entry_date = $2::date AND hidden_at IS NULL
        ORDER BY seq ASC`,
      [userId, entryDate],
    );
  }

  /** 日期流聚合（未隐藏；近 N 天，按日倒序）。raw = 未回顾数（M2 徽标口径）。 */
  async listDaySummaries(userId: string, limit: number): Promise<DailyCaptureDaySummary[]> {
    return this.query<DailyCaptureDaySummary>(
      `SELECT entry_date AS date,
              COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE status = 'raw')::int AS raw,
              COUNT(*) FILTER (WHERE status = 'reviewed')::int AS reviewed,
              COUNT(*) FILTER (WHERE status = 'absorbed')::int AS absorbed
         FROM daily_capture_entries
        WHERE user_id = $1::uuid AND hidden_at IS NULL
        GROUP BY entry_date
        ORDER BY entry_date DESC
        LIMIT $2`,
      [userId, limit],
    );
  }

  /**
   * 按需更新（status / meta 整体替换）。调用方（服务层）负责流转校验与 meta
   * 合并——本层只落库。hidden 行不可触达（谓词内 hidden_at IS NULL）。
   */
  async updateEntryFields(
    userId: string,
    id: string,
    fields: { status?: DailyCaptureEntryRow["status"]; meta?: Record<string, unknown> | null },
  ): Promise<DailyCaptureEntryRow | null> {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (fields.status !== undefined) {
      params.push(fields.status);
      sets.push(`status = $${params.length}`);
    }
    if (fields.meta !== undefined) {
      params.push(fields.meta === null ? null : JSON.stringify(fields.meta));
      sets.push(`meta = $${params.length}::jsonb`);
    }
    if (sets.length === 0) return this.findEntry(userId, id);
    params.push(userId, id);
    return this.queryOne<DailyCaptureEntryRow>(
      `UPDATE daily_capture_entries SET ${sets.join(", ")}
        WHERE user_id = $${params.length - 1}::uuid AND id = $${params.length}::uuid AND hidden_at IS NULL
        RETURNING *`,
      params,
    );
  }

  async findTypeByKey(userId: string, typeKey: string): Promise<DailyCaptureTypeRow | null> {
    return this.queryOne<DailyCaptureTypeRow>(
      `SELECT * FROM daily_capture_types WHERE user_id = $1::uuid AND type_key = $2`,
      [userId, typeKey],
    );
  }

  async countVisibleTypes(userId: string): Promise<number> {
    const row = await this.queryOne<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM daily_capture_types WHERE user_id = $1::uuid AND hidden = false`,
      [userId],
    );
    return row?.n ?? 0;
  }

  async insertType(input: {
    user_id: string;
    type_key: string;
    label: string;
    absorption_hint: string | null;
    sort: number;
  }): Promise<DailyCaptureTypeRow> {
    const row = await this.queryOne<DailyCaptureTypeRow>(
      `INSERT INTO daily_capture_types (user_id, type_key, label, absorption_hint, sort)
       VALUES ($1::uuid, $2, $3, $4, $5)
       RETURNING *`,
      [input.user_id, input.type_key, input.label, input.absorption_hint, input.sort],
    );
    if (!row) throw new Error("daily capture type insert returned no row");
    return row;
  }

  /** 类型更新（label/hint/sort/hidden 任意子集；内置 key 同样走这里）。 */
  async updateType(
    userId: string,
    typeKey: string,
    fields: { label?: string; absorption_hint?: string | null; sort?: number; hidden?: boolean },
  ): Promise<DailyCaptureTypeRow | null> {
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const [column, value] of [
      ["label", fields.label],
      ["absorption_hint", fields.absorption_hint],
      ["sort", fields.sort],
      ["hidden", fields.hidden],
    ] as const) {
      if (value === undefined) continue;
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    }
    if (sets.length === 0) return this.findTypeByKey(userId, typeKey);
    params.push(userId, typeKey);
    return this.queryOne<DailyCaptureTypeRow>(
      `UPDATE daily_capture_types SET ${sets.join(", ")}
        WHERE user_id = $${params.length - 1}::uuid AND type_key = $${params.length}
        RETURNING *`,
      params,
    );
  }
}
