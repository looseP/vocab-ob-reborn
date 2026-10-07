/**
 * `scripts/backfill-l1-content-hash-snapshot.ts` 的回归锁。
 *
 * ## 为什么锁这个
 *
 * 这个脚本要 UPDATE `user_word_progress`（用户数据，不是词库）—— 而本仓最容易
 * 出事的三个形状它全占了：
 *
 *   1. **静默 0 行**：受 RLS 约束的角色（非 owner）跑 UPDATE 会被静默过滤成
 *      rowCount=0 且不报错。`vocab_batch_import` 连表权限都没有（只授了 `words`），
 *      连上去直接 `permission denied for function uid`。若不挡，脚本会打印
 *      「无需改动」而实际什么都没做。
 *   2. **误抹真信号**：谓词少一条 `u.content_hash_snapshot = w.content_hash`，
 *      就会把「内容真的变过」的行也回填掉 —— 那几行的「重新核对」是合法信号。
 *   3. **污染监视指标**：忘了 `updated_at = u.updated_at`，`max(updated_at)` 会跳，
 *      破坏「零写入对账」这一既有监视口径。
 *
 * 本套件钉住这三件事，外加「预演与写入用同一组谓词」这条一致性要求。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assertWriteCapableRole, shortHash } from "../../scripts/backfill-l1-content-hash-snapshot";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

const SCRIPT = "scripts/backfill-l1-content-hash-snapshot.ts";

/** 剥掉注释与字符串字面量后查标识符（锁义不锁形）。 */
function stripLiterals(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, "``");
}

describe("backfill-l1-content-hash-snapshot：选择性谓词", () => {
  const src = read(SCRIPT);

  // 谓词本身：6 条，缺一不可。第 6 条是「只修误报、不动真变更」的关键。
  it("包含全部 6 条谓词", () => {
    const where = src.match(/const WHERE_PREDICATES = `([\s\S]*?)`/)?.[1] ?? "";
    expect(where).toContain("w.id = u.word_id");
    expect(where).toContain("coalesce(w.l1_content_hash, '') <> ''");
    expect(where).toContain("u.l1_content_hash_snapshot IS NOT NULL");
    expect(where).toContain("u.l1_content_hash_snapshot <> w.l1_content_hash");
    expect(where).toContain("coalesce(w.content_hash, '') <> ''");
    expect(where).toContain("u.content_hash_snapshot = w.content_hash");
  });

  // 第 6 条一旦被写成「不等于」，就会把真变更行也回填 —— 那是抹掉合法信号。
  it("第 6 条是「全量对相等」（= ），不是「不等」", () => {
    const where = src.match(/const WHERE_PREDICATES = `([\s\S]*?)`/)?.[1] ?? "";
    expect(where).toMatch(/u\.content_hash_snapshot\s*=\s*w\.content_hash/);
    expect(where).not.toMatch(/u\.content_hash_snapshot\s*(<>|!=)/);
  });

  // 预演与写入必须逐字同谓词，否则「预演 N 行、写入 M 行」的校验会失真。
  it("预演与写入共用同一个谓词常量", () => {
    const planUses = /PLAN_SQL[\s\S]*?\$\{WHERE_PREDICATES\}/.test(src);
    const updateUses = /UPDATE_SQL[\s\S]*?\$\{WHERE_PREDICATES\}/.test(src);
    expect(planUses, "PLAN_SQL 必须内插 WHERE_PREDICATES").toBe(true);
    expect(updateUses, "UPDATE_SQL 必须内插 WHERE_PREDICATES").toBe(true);
  });
});

describe("backfill-l1-content-hash-snapshot：updated_at 不许动", () => {
  const src = read(SCRIPT);

  // max(updated_at) 是「零写入对账」的监视指标，回填不能污染它。
  it("SET 里把 updated_at 显式写回自身", () => {
    const set = src.match(/UPDATE user_word_progress u\s*\n?\s*SET([\s\S]*?)\n\s*FROM words w/)?.[1] ?? "";
    expect(set).toContain("updated_at = u.updated_at");
  });

  it("没有把 updated_at 设成 now()/CURRENT_TIMESTAMP", () => {
    const set = src.match(/UPDATE user_word_progress u\s*\n?\s*SET([\s\S]*?)\n\s*FROM words w/)?.[1] ?? "";
    expect(set).not.toMatch(/updated_at\s*=\s*(now\(\)|CURRENT_TIMESTAMP|clock_timestamp\(\))/i);
  });
});

describe("backfill-l1-content-hash-snapshot：连接身份", () => {
  const src = read(SCRIPT);

  it("用 MIGRATION_DATABASE_URL（表 owner 角色），不用 DATABASE_URL / BATCH_IMPORT", () => {
    expect(src).toContain("MIGRATION_DATABASE_URL");
    // 应用角色受 RLS 约束；batch_import 连表权限都没有 —— 都不能用来写这张表。
    expect(stripLiterals(src)).not.toMatch(/process\.env\.DATABASE_URL\b/);
    expect(stripLiterals(src)).not.toMatch(/process\.env\.BATCH_IMPORT_DATABASE_URL\b/);
  });

  it("有角色守卫：无 UPDATE 权限或受 RLS 约束时拒绝执行", () => {
    expect(src).toMatch(/assertWriteCapableRole/);
    expect(src).toMatch(/has_table_privilege\(current_user, 'user_word_progress', 'UPDATE'\)/);
    expect(src).toMatch(/rolbypassrls/);
  });

  it("文件头写明为什么不是 BATCH_IMPORT（否则后人会照抄别的回填脚本改回去）", () => {
    expect(src).toContain("vocab_batch_import");
    expect(src).toMatch(/permission denied for function uid|没有 UPDATE 权限|只授了/);
    expect(src).toMatch(/0025/);
  });
});

describe("backfill-l1-content-hash-snapshot：两道防线", () => {
  const src = read(SCRIPT);

  it("校验 UPDATE 的 rowCount 与预演行数相等", () => {
    expect(src).toMatch(/result\.rowCount !== plan\.rows\.length/);
  });

  it("有写后自检（重查同一谓词必须剩 0 行）", () => {
    expect(src).toMatch(/写后自检/);
    expect(src).toMatch(/count\(\*\)::int AS count/);
  });

  it("零行时抛错并 exit 1，不吞错误", () => {
    expect(src).toMatch(/throw new Error/);
    expect(src).toMatch(/process\.exit\(1\)/);
  });

  it("单事务（BEGIN/COMMIT/ROLLBACK 在同一个 client 上）", () => {
    expect(src).toContain("BEGIN");
    expect(src).toContain("COMMIT");
    expect(src).toContain("ROLLBACK");
    expect(src).toMatch(/pool\.connect\(\)/);
  });

  it("有 --dry-run 且不写库", () => {
    expect(src).toContain("--dry-run");
    expect(src).toMatch(/dryRun/);
  });
});

describe("assertWriteCapableRole（纯逻辑）", () => {
  const capable = {
    current_user: "vocab_migration",
    table_owner: "vocab_migration",
    can_update: true,
    is_rls_subject: false,
  };

  it("owner 角色放行", () => {
    expect(() => assertWriteCapableRole(capable)).not.toThrow();
  });

  it("无 UPDATE 权限拒绝（batch_import 的情形）", () => {
    expect(() =>
      assertWriteCapableRole({ ...capable, current_user: "vocab_batch_import", can_update: false }),
    ).toThrow(/没有 UPDATE 权限/);
  });

  // 最关键的一条：受 RLS 约束的角色会让预演与 UPDATE 同时静默变成 0 行，
  // 「两次一致」反而成立 ⇒ 脚本会误报「无需改动」。必须挡在跑之前。
  it("受 RLS 约束拒绝（否则 0 行会被误读成「无需改动」）", () => {
    expect(() =>
      assertWriteCapableRole({ ...capable, current_user: "vocab_app", is_rls_subject: true }),
    ).toThrow(/RLS/);
  });

  it("错误信息指向 MIGRATION_DATABASE_URL", () => {
    expect(() =>
      assertWriteCapableRole({ ...capable, current_user: "vocab_app", is_rls_subject: true }),
    ).toThrow(/MIGRATION_DATABASE_URL/);
  });
});

describe("shortHash", () => {
  it("取前 8 位", () => {
    expect(shortHash("0123456789abcdef")).toBe("01234567");
  });

  it("null/undefined/空串给占位符", () => {
    expect(shortHash(null)).toBe("(空)");
    expect(shortHash(undefined)).toBe("(空)");
    expect(shortHash("")).toBe("(空)");
  });
});
