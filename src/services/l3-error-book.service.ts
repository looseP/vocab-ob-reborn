/**
 * L3ErrorBookService —— 错题库统一投影的应用层（2026-09-26）。
 *
 * 为什么单独一个服务而不并进 L3PracticeService：L3PracticeService 的申报边界是
 * "只写 l3_practice_attempts、只读四张表"（ADR-0019），统一投影要读
 * l3_grading_results / l3_questions / l3_submissions —— 那是另一族表、另一个
 * 生命周期。边界写在文件头是为了让它**可被审查**，混进去等于把边界注释变成谎话。
 *
 * 边界（与仓储文件头同源）：
 *  - 纯读。错题库是派生视图，不建表（ADR-0019 §1）。
 *  - 零 FSRS：不 import 任何 L1/L2/FSRS 仓库，不出现任何 FSRS 字段
 *    （ADR-0004 §6：L3 永不调度）。
 *  - 不新增真源：句级真源 = l3_practice_attempts，题级真源 = l3_grading_results。
 */

import type { PoolClient } from "pg";
import { ValidationError } from "../errors";
import { withTransaction } from "../db/transaction";
import { createRepositories } from "../repositories/factory";
import type {
  Direction,
  L3ErrorBookKind,
  L3ErrorBookPage,
  L3SubSpace,
} from "../domain";
import type { IRepositories } from "../repositories/interfaces";

type TxRunner = typeof withTransaction;
type RepositoryFactory = (tx?: PoolClient) => IRepositories;

/** 错题条目所属腿（句级练习 / 题级做题判分）。 */
export const L3_ERROR_BOOK_KINDS: readonly L3ErrorBookKind[] = ["sentence", "question"];
/** 子空间固定枚举（与既有 practice 口径同值，避免第二份枚举漂移）。 */
const SUB_SPACES: readonly L3SubSpace[] = ["语法", "阅读", "作文", "翻译", "通用"];
/** 方向固定枚举（ADR-0017）。 */
const DIRECTIONS: readonly Direction[] = ["通用", "考研", "雅思"];

export const L3_ERROR_BOOK_DEFAULT_LIMIT = 20;
export const L3_ERROR_BOOK_MAX_LIMIT = 100;

export interface L3UnifiedErrorBookInput {
  userId: string;
  /** 腿选择；缺省 = 两腿合并（错题库默认口径）。 */
  kind?: string | null;
  space?: string | null;
  direction?: string | null;
  limit?: number | null;
  offset?: number | null;
}

function requireNonEmpty(value: string | null | undefined, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ValidationError(`${field} is required`, field);
  }
  return value;
}

function resolveOptionalEnum<T extends string>(
  value: T | null | undefined,
  allowed: readonly string[],
  field: string,
): T | null {
  if (value == null) return null;
  if (!allowed.includes(value)) {
    throw new ValidationError(`Invalid ${field}: ${value}`, field);
  }
  return value;
}

function normalizeLimit(limit: number | null | undefined): number {
  if (limit == null) return L3_ERROR_BOOK_DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) return L3_ERROR_BOOK_DEFAULT_LIMIT;
  return Math.min(limit, L3_ERROR_BOOK_MAX_LIMIT);
}

function normalizeOffset(offset: number | null | undefined): number {
  if (offset == null) return 0;
  if (!Number.isInteger(offset) || offset < 0) return 0;
  return offset;
}

export interface L3ErrorBookServiceDeps {
  txRunner?: TxRunner;
  repositoryFactory?: RepositoryFactory;
}

export class L3ErrorBookService {
  private readonly txRunner: TxRunner;
  private readonly repositoryFactory: RepositoryFactory;

  constructor(deps: L3ErrorBookServiceDeps = {}) {
    this.txRunner = deps.txRunner ?? withTransaction;
    this.repositoryFactory = deps.repositoryFactory ?? createRepositories;
  }

  /**
   * 统一错题库：句级 wrong + 题级 wrong/partial 合并，按最近出错时间倒序，
   * offset 分页（cursor 在两腿间不成立，故不提供——不提供假分页）。
   */
  async list(input: L3UnifiedErrorBookInput): Promise<L3ErrorBookPage> {
    const userId = requireNonEmpty(input.userId, "userId");
    const kind = resolveOptionalEnum<string>(input.kind, L3_ERROR_BOOK_KINDS, "kind") as L3ErrorBookKind | null;
    const space = resolveOptionalEnum<string>(input.space, SUB_SPACES, "space") as L3SubSpace | null;
    const direction = resolveOptionalEnum<string>(input.direction, DIRECTIONS, "direction") as Direction | null;
    const limit = normalizeLimit(input.limit);
    const offset = normalizeOffset(input.offset);

    return this.txRunner(
      async (tx) =>
        this.repositoryFactory(tx).l3ErrorBook.listUnified({
          userId,
          kind,
          space,
          direction,
          limit,
          offset,
        }),
      { actorId: userId },
    );
  }
}
