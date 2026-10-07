/**
 * 离线回填 —— 把 `user_word_progress.l1_content_hash_snapshot` 修正到 **L1 hash 空间**。
 *
 * 用法：`npm run db:script:backfill-l1-snapshot -- --dry-run`（先看清单）
 *       `npm run db:script:backfill-l1-snapshot`（真实写入）
 *
 * ## 为什么要回填
 *
 * `saveAnswer` 曾把**全量** hash 同时写进两个快照列
 * （`content_hash_snapshot = $11` / `l1_content_hash_snapshot = $11`，
 * $11 = `words.content_hash`）。而 `deriveContentStaleness`
 * （`src/domain/content-staleness.ts`，ADR-0021）拿 `words.l1_content_hash`
 * 与 `l1_content_hash_snapshot` 配对比较（L1 专属对）——**跨两个 hash 空间比对**，
 * 恒不相等 ⇒ 每张学过的词都被标「重新核对」。
 *
 * 真库实测（2026-10-07，自用栈与 dev 快照一致）：学过词 24，L1 对 fire = 24、
 * 全量对 fire = 6、队列 22 张里 queueLabel=重新核对 = 14（即全部到期卡）。
 *
 * 代码侧已修（作答改填 L1 hash：`saveAnswer` 的 `$18`，见 M1 提交）；本脚本修**存量行**。
 *
 * ## 选择性：只修「全量对没变化」的行
 *
 * WHERE 的第 6 个谓词 `u.content_hash_snapshot = w.content_hash` 把「内容真的变过」
 * 的行排除在外 —— 那些行的「重新核对」是**合法信号**，回填会把它抹掉。
 * 它们靠用户下次作答写入新快照自然收敛（派生判据本身没错，不要动）。
 *
 * ## 幂等
 *
 * `u.l1_content_hash_snapshot <> w.l1_content_hash` 让已修正的行不再入选 ⇒
 * 第二次跑必然是 0 改动（脚本对 0 改动明确打印「无需改动」并退出）。
 *
 * ## `updated_at` 不许动
 *
 * `updated_at = u.updated_at` 是**刻意**写的：`max(updated_at)` 是「零写入对账」
 * 的监视指标（见 docs/design/葫芦背书法-修订轮-执行计划-2026-10-06.md §零写入对账），
 * 这次回填不能污染它。
 *
 * ## 🔴 角色：为什么不是 BATCH_IMPORT_DATABASE_URL
 *
 * `backfill-content-hash.ts` / `backfill-word-aliases.ts` 用
 * `BATCH_IMPORT_DATABASE_URL` 是因为迁移 0025 给 `vocab_app` 建的 UPDATE policy
 * 只放行 `words` 的 stub 行（`definition_md = ''`）—— 那是 **words 表专属**的坑。
 *
 * `user_word_progress` 是**用户数据表**，实测（2026-10-07）：
 *   - `has_table_privilege('vocab_batch_import','user_word_progress','SELECT')` = **false**
 *     （该角色全库只授了 `words` 的 SELECT/INSERT/UPDATE）
 *   - 用它连上去跑本脚本会直接 `permission denied for function uid`
 *     （RLS policy `progress_own_all` 调用 `auth.uid()`，该角色也没有 EXECUTE）
 *   - `vocab_app` 有 UPDATE，但 RLS 把每次事务限定在 `auth.uid() = user_id` 的
 *     单一行集上 —— 全局回填做不到（连「有哪些用户」都在 RLS 后面），
 *     且未设 claim 时 UPDATE 会**静默命中 0 行**，正是本仓最怕的失败模式。
 *
 * ⇒ 用**表 owner** 角色 `vocab_migration`（`MIGRATION_DATABASE_URL`）：它是唯一
 * 非管理角色中能写这张表的，且作为 owner 不受 RLS 过滤。脚本不靠「角色对不对」
 * 自证，而是用两道防线兜底：**rowCount 校验**（必须等于预演清单行数）+ **写后自检**
 * （重查同一谓词必须剩 0 行）。角色本身还有一道前置守卫，见 `assertWriteCapableRole`。
 *
 * ## 跑法（栈内；数据库不对宿主暴露，`postgres:5432` 才解析得到）
 *
 *   docker compose run --rm -e NODE_ENV=development -e DB_SSLMODE=disable \
 *     -e MIGRATION_DATABASE_URL='postgresql://vocab_migration:...@postgres:5432/vocab' \
 *     web npx tsx scripts/backfill-l1-content-hash-snapshot.ts [--dry-run]
 *
 * dev 栈要加 `-p vocab-dev -f compose.yaml -f compose.dev.yaml`。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { postgresClientConfig } from "../src/db/ssl";

/** 预演与写入共用同一组谓词 —— 两份 SQL 的 WHERE 必须逐字一致。 */
const WHERE_PREDICATES = `
   WHERE w.id = u.word_id
     AND coalesce(w.l1_content_hash, '') <> ''
     AND u.l1_content_hash_snapshot IS NOT NULL
     AND u.l1_content_hash_snapshot <> w.l1_content_hash
     AND coalesce(w.content_hash, '') <> ''
     AND u.content_hash_snapshot = w.content_hash`;

const PLAN_SQL = `
  SELECT w.slug AS slug,
         u.l1_content_hash_snapshot AS before,
         w.l1_content_hash AS after
    FROM user_word_progress u
    JOIN words w ON w.id = u.word_id
${WHERE_PREDICATES}
   ORDER BY w.slug`;

const UPDATE_SQL = `
  UPDATE user_word_progress u
     SET l1_content_hash_snapshot = w.l1_content_hash,
         updated_at = u.updated_at
    FROM words w
${WHERE_PREDICATES}`;

/** 快照前 8 位（dry-run 打印用；空值给占位符，避免 undefined 混进日志）。 */
export function shortHash(value: string | null | undefined): string {
  if (typeof value !== "string" || value.length === 0) return "(空)";
  return value.slice(0, 8);
}

export interface PlanRow {
  slug: string;
  before: string;
  after: string;
}

interface IdentityRow {
  current_user: string;
  table_owner: string | null;
  can_update: boolean;
  is_rls_subject: boolean;
}

/**
 * 角色守卫：连接角色必须能**完整**看到并写入 `user_word_progress`。
 *
 * 为什么必须挡：若角色受 RLS 约束（非 owner、不 bypassrls），
 * 预演 SELECT 与 UPDATE 都会被静默过滤 —— 清单是 0、rowCount 也是 0，
 * 「两次一致」反而成立，脚本会一路报「无需改动」。这正是本仓
 * （backfill-content-hash.ts 头注释）反复强调的静默失败形状。
 */
export function assertWriteCapableRole(row: IdentityRow): void {
  if (!row.can_update) {
    throw new Error(
      `连接角色 ${row.current_user} 对 user_word_progress 没有 UPDATE 权限。` +
        `请用 MIGRATION_DATABASE_URL（vocab_migration 是表 owner）——` +
        `vocab_batch_import 只授了 words，用它必然 permission denied。`,
    );
  }
  if (row.is_rls_subject) {
    throw new Error(
      `连接角色 ${row.current_user} 受 RLS 约束（非表 owner ${row.table_owner} 且未 bypassrls）：` +
        `预演与 UPDATE 都会被静默过滤成 0 行，脚本会误报「无需改动」。` +
        `请改用 MIGRATION_DATABASE_URL（vocab_migration）。`,
    );
  }
}

async function backfill(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) {
    throw new Error(
      "MIGRATION_DATABASE_URL is not configured（本脚本要写 user_word_progress，" +
        "必须用表 owner 角色 vocab_migration；不要用 DATABASE_URL / BATCH_IMPORT_DATABASE_URL）。",
    );
  }

  const pool = new Pool({ ...postgresClientConfig(url), max: 1 });
  try {
    // 角色守卫（见 assertWriteCapableRole 的说明）。
    const identity = await pool.query<IdentityRow>(
      `SELECT current_user,
              (SELECT r.rolname FROM pg_roles r
                WHERE r.oid = (SELECT c.relowner FROM pg_class c
                                WHERE c.relname = 'user_word_progress')) AS table_owner,
              has_table_privilege(current_user, 'user_word_progress', 'UPDATE') AS can_update,
              (current_user <> (SELECT r.rolname FROM pg_roles r
                                 WHERE r.oid = (SELECT c.relowner FROM pg_class c
                                                 WHERE c.relname = 'user_word_progress'))
               AND NOT (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user)) AS is_rls_subject`,
    );
    const who = identity.rows[0]!;
    console.log(`连接身份：${who.current_user}（表 owner：${who.table_owner}）`);
    assertWriteCapableRole(who);

    // 1. 预演：清单 + 计数（真实写入的行数必须与之相等）。
    const plan = await pool.query<PlanRow>(PLAN_SQL);
    console.log("");
    console.log(`预演：将修正 ${plan.rows.length} 行（L1 快照装的是全量 hash，且全量对未变化）`);
    for (const row of plan.rows) {
      console.log(`  ~ ${row.slug.padEnd(16)} ${shortHash(row.before)} → ${shortHash(row.after)}`);
    }

    if (dryRun) {
      console.log("");
      console.log("[dry-run] 未写入任何数据。去掉 --dry-run 即执行。");
      return;
    }

    if (plan.rows.length === 0) {
      console.log("");
      console.log("无需改动（幂等：已修正的行不再入选）。");
      return;
    }

    // 2. 单事务写入：rowCount 必须等于预演行数，否则整体回滚。
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(UPDATE_SQL);
      if (result.rowCount !== plan.rows.length) {
        await client.query("ROLLBACK");
        throw new Error(
          `UPDATE 命中 ${result.rowCount} 行，预演清单是 ${plan.rows.length} 行 —— 不一致，已回滚。` +
            `请确认连接角色是 vocab_migration（表 owner）；受 RLS 约束的角色会被静默过滤成 0 行。`,
        );
      }
      await client.query("COMMIT");
      console.log("");
      console.log(`已修正 ${result.rowCount} 行。`);
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // ROLLBACK 自身失败 —— 仍然抛原始错误
      }
      throw error;
    } finally {
      client.release();
    }

    // 3. 写后自检：同一谓词必须剩 0 行（不能只信「跑完了」）。
    const remaining = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM user_word_progress u JOIN words w ON w.id = u.word_id${WHERE_PREDICATES}`,
    );
    const left = remaining.rows[0]?.count ?? -1;
    if (left !== 0) {
      throw new Error(`写后自检失败：仍有 ${left} 行满足回填谓词。`);
    }

    // 4. 对账输出：剩下的 L1 对 fire 应当**全部**是「全量对也变了」的真变更行。
    const audit = await pool.query<{ l1_fire: number; real_drift: number }>(
      `SELECT count(*) FILTER (WHERE u.l1_content_hash_snapshot <> w.l1_content_hash)::int AS l1_fire,
              count(*) FILTER (WHERE coalesce(w.content_hash,'') <> ''
                                 AND u.content_hash_snapshot IS DISTINCT FROM w.content_hash)::int AS real_drift
         FROM user_word_progress u JOIN words w ON w.id = u.word_id
        WHERE u.l1_content_hash_snapshot IS NOT NULL`,
    );
    const auditRow = audit.rows[0]!;
    console.log(`写后自检通过：0 行残留；L1 对 fire = ${auditRow.l1_fire}，其中全量对真变更 = ${auditRow.real_drift}。`);
    if (auditRow.l1_fire !== auditRow.real_drift) {
      throw new Error(
        `L1 对 fire（${auditRow.l1_fire}）与全量对真变更（${auditRow.real_drift}）不相等 ——` +
          `说明还有非真变更的误报行没被修到，请复核谓词。`,
      );
    }
  } finally {
    await pool.end();
  }
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  backfill()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("Backfill failed:", err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
