/**
 * 0031 迁移契约测试（幂等 + drift 自证，ADR-0029 §7①/②）。
 *
 * 验证方式：contract 测试（对齐 tests/scripts/verify-schema-drift.test.ts 的
 * 模式）——不连 DB，直接对迁移 SQL 与 src/db/schema.ts 的权威定义做文本契约
 * 断言。幂等性由 SQL 构造自证：CREATE UNIQUE INDEX IF NOT EXISTS 与
 * DROP CONSTRAINT IF EXISTS + ADD CONSTRAINT，重复执行不报错（无自动 down）。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const migrationSql = readFileSync(`${repoRoot}drizzle-release/0031_overconfident_goliath.sql`, "utf8");
const schemaTs = readFileSync(`${repoRoot}src/db/schema.ts`, "utf8");

function normalizeSqlWhitespace(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

describe("0031 l3_proposals idempotent index + source_type convergence", () => {
  it("creates the partial unique index idempotently", () => {
    expect(migrationSql).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "idx_l3_proposals_user_input_hash" ON "l3_proposals" USING btree ("user_id","input_hash") WHERE input_hash IS NOT NULL',
    );
  });

  it("rebuilds the source_type CHECK without mcp_future, idempotently", () => {
    expect(migrationSql).toContain('DROP CONSTRAINT IF EXISTS "l3_proposals_source_type_check"');
    const addConstraint = migrationSql.match(/ALTER TABLE "l3_proposals" ADD CONSTRAINT "l3_proposals_source_type_check"[^;]+;/);
    expect(addConstraint).not.toBeNull();
    // 生效语句不含弃用枚举（ROLLBACK 注释里的旧值不算生效语句）。
    expect(addConstraint?.[0]).not.toContain("mcp_future");
    expect(addConstraint?.[0]).toContain("'manual_draft'::text, 'other'::text");
  });

  it("keeps statement breakpoints and the manual-rollback note", () => {
    expect(migrationSql).toContain("--> statement-breakpoint");
    expect(migrationSql).toContain("ROLLBACK（人工执行；无自动 down）");
  });

  it("stays in sync with src/db/schema.ts (no drift)", () => {
    // 索引定义：schema.ts 与迁移同名同形（partial 谓词一致）。
    expect(schemaTs).toContain('uniqueIndex("idx_l3_proposals_user_input_hash")');
    expect(schemaTs).toContain("input_hash IS NOT NULL");

    // CHECK 表达式：迁移 ADD CONSTRAINT 与 schema.ts check() 逐字一致（归一空白）。
    const schemaCheck = schemaTs.match(/check\("l3_proposals_source_type_check", sql`([^`]+)`\)/);
    expect(schemaCheck).not.toBeNull();
    const migrationCheck = migrationSql.match(/ADD CONSTRAINT "l3_proposals_source_type_check" CHECK \((.+)\)/);
    expect(migrationCheck).not.toBeNull();
    expect(normalizeSqlWhitespace(migrationCheck![1])).toBe(normalizeSqlWhitespace(schemaCheck![1]));
  });
});
