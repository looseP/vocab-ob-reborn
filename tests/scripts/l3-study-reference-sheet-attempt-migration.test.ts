/**
 * N2 第三条垂直链（sheet + attempt 引用）迁移契约测试 —— TDD 红测先行。
 *
 * 为什么是静态契约而不是「跑一遍迁移」：chain01 已在真实 PostgreSQL 上复现过
 * 「drizzle 把复合外键排到它依赖的 UNIQUE 之前 → no unique constraint」的红
 * （0040/0041 拆分的原因）。本链 attempt 目标同样缺 `(id,user_id)` 唯一键，
 * 因此**顺序**就是合同：0043 只建唯一键，0044 才建引用它的复合外键。
 * 这里的断言先于实现落地，实现未到位时整组应为红。
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const releaseDir = `${repoRoot}drizzle-release/`;

interface Migration {
  index: string;
  tag: string;
  sql: string;
  normalized: string;
}

function loadMigrations(): Migration[] {
  return readdirSync(releaseDir)
    .filter((file) => /^\d{4}_.+\.sql$/.test(file))
    .sort()
    .map((file) => {
      const sql = readFileSync(`${releaseDir}${file}`, "utf8");
      return {
        index: file.slice(0, 4),
        tag: file.replace(/\.sql$/, ""),
        sql,
        normalized: sql.replace(/\s+/g, " ").trim(),
      };
    });
}

const migrations = loadMigrations();
const journalTags = (
  JSON.parse(readFileSync(`${releaseDir}meta/_journal.json`, "utf8")) as { entries: { tag: string }[] }
).entries.map((entry) => entry.tag);
const schemaTs = readFileSync(`${repoRoot}src/db/schema.ts`, "utf8");

function migration(index: string): Migration | undefined {
  return migrations.find((entry) => entry.index === index);
}

/**
 * 只留可执行 DDL：剥掉 `--` 行注释。
 *
 * 为什么必须剥：本迁移的注释里**刻意**讨论了 `l3_grading_results` 与
 * 「无 version 列」，直接对整份 SQL 做 `not.toMatch(/version/i)` 会把自己
 * 的设计说明判成违规 —— 断言必须看语句，不是看文档。
 */
function ddlOnly(entry: Migration): string {
  return entry.sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

describe("N2 第三条链迁移契约（0043 → 0044）", () => {
  it("0043 存在：建 l3_question_attempts(id,user_id) 唯一键，并且不含引用它的外键", () => {
    const sql = migration("0043");
    expect(sql, "missing 0043 — the unique key must land before the composite FK").toBeDefined();
    expect(sql!.normalized).toMatch(
      /ALTER TABLE "l3_question_attempts" ADD CONSTRAINT "l3_question_attempts_id_user_id_unique" UNIQUE\("id","user_id"\)/,
    );
    // 顺序合同：依赖该唯一键的外键必须晚一步，不能与本段混写。
    expect(sql!.normalized).not.toMatch(
      /REFERENCES "public"\."l3_question_attempts"\("id","user_id"\)/,
    );
  });

  it("0044 存在：加引用表的三列 target 字段", () => {
    const sql = migration("0044");
    expect(sql, "missing 0044 — sheet/attempt target columns").toBeDefined();
    expect(sql!.normalized).toContain('ALTER TABLE "l3_study_note_references" ADD COLUMN "submission_id" uuid');
    expect(sql!.normalized).toContain(
      'ALTER TABLE "l3_study_note_references" ADD COLUMN "submission_revision_no" integer',
    );
    expect(sql!.normalized).toContain('ALTER TABLE "l3_study_note_references" ADD COLUMN "attempt_id" uuid');
  });

  it("0044 建立 sheet / attempt 两个跨表属主复合外键，且删除行为为 RESTRICT", () => {
    const sql = migration("0044");
    expect(sql?.normalized).toContain(
      'FOREIGN KEY ("submission_id","user_id") REFERENCES "public"."l3_submissions"("id","user_id") ON DELETE restrict',
    );
    expect(sql?.normalized).toContain(
      'FOREIGN KEY ("attempt_id","user_id") REFERENCES "public"."l3_question_attempts"("id","user_id") ON DELETE restrict',
    );
  });

  it("kind_check 扩到 9 值（新增 sheet / attempt）", () => {
    const normalized = migration("0044")?.normalized ?? "";
    expect(normalized).toMatch(
      /CONSTRAINT "l3_study_note_references_kind_check" CHECK \(kind = ANY \(ARRAY\['source'::text, 'source_quote'::text, 'question'::text, 'stem_quote'::text, 'option_quote'::text, 'assessment'::text, 'note'::text, 'sheet'::text, 'attempt'::text\]\)\)/,
    );
  });

  it("target_check 增加 sheet / attempt 两支，且与既有 target 列互斥", () => {
    const normalized = migration("0044")?.normalized ?? "";
    const target = /CONSTRAINT "l3_study_note_references_target_check" CHECK \((.*)\);?--> statement-breakpoint/.exec(
      `${normalized}--> statement-breakpoint`,
    );
    expect(target, "target_check not rebuilt for chain03").not.toBeNull();
    const body = target ? target[1]! : "";
    // sheet 支：submission_id 非空、其余 target 列皆空。
    expect(body).toMatch(/kind = 'sheet'::text AND submission_id IS NOT NULL/);
    expect(body).toMatch(/kind = 'sheet'::text[^\n]*?source_id IS NULL/);
    expect(body).toMatch(/kind = 'sheet'::text[^\n]*?attempt_id IS NULL/);
    // attempt 支：attempt_id 非空、其余 target 列皆空。
    expect(body).toMatch(/kind = 'attempt'::text AND attempt_id IS NOT NULL/);
    expect(body).toMatch(/kind = 'attempt'::text[^\n]*?source_id IS NULL/);
    expect(body).toMatch(/kind = 'attempt'::text[^\n]*?submission_id IS NULL/);
    // 既有支行为不变：新列对各支显式 IS NULL。
    expect(body).toContain("target_note_id IS NULL");
  });

  it("quote_check 把 sheet / attempt 并入非摘录组，revision CHECK 只接受正值", () => {
    const normalized = migration("0044")?.normalized ?? "";
    expect(normalized).toMatch(
      /kind = ANY \(ARRAY\['source'::text, 'question'::text, 'assessment'::text, 'note'::text, 'sheet'::text, 'attempt'::text\]\) AND start_offset IS NULL AND end_offset IS NULL AND quote_snapshot IS NULL/,
    );
    expect(normalized).toMatch(
      /CONSTRAINT "l3_study_note_references_revision_no_check" CHECK \(submission_revision_no IS NULL OR submission_revision_no > 0\)/,
    );
  });

  it("0044 建反向引用所需两个索引", () => {
    const normalized = migration("0044")?.normalized ?? "";
    expect(normalized).toContain(
      'CREATE INDEX "idx_l3_study_note_references_user_submission" ON "l3_study_note_references" USING btree ("user_id","submission_id","note_id")',
    );
    expect(normalized).toContain(
      'CREATE INDEX "idx_l3_study_note_references_user_attempt" ON "l3_study_note_references" USING btree ("user_id","attempt_id","note_id")',
    );
  });

  it("两段迁移均不 DROP TABLE，且按 0043 → 0044 顺序登记 journal", () => {
    for (const index of ["0043", "0044"]) {
      const sql = migration(index);
      expect(sql, `missing ${index}`).toBeDefined();
      expect(sql!.sql).not.toMatch(/DROP TABLE/i);
    }
    expect(journalTags.findIndex((tag) => tag === migration("0043")!.tag)).toBeGreaterThan(-1);
    expect(journalTags.findIndex((tag) => tag === migration("0044")!.tag)).toBeGreaterThan(
      journalTags.findIndex((tag) => tag === migration("0043")!.tag),
    );
  });

  it("RLS 不退坡：两段迁移均不 DISABLE RLS、不 DROP POLICY、不建新表", () => {
    for (const index of ["0043", "0044"]) {
      const sql = migration(index);
      expect(sql, `missing ${index}`).toBeDefined();
      expect(sql!.normalized).not.toMatch(/DISABLE ROW LEVEL SECURITY/i);
      expect(sql!.normalized).not.toMatch(/DROP POLICY/i);
      expect(sql!.normalized).not.toMatch(/CREATE TABLE/i);
    }
  });

  it("schema.ts 保持权威同步（唯一键、三列、两个复合 FK、两个索引、own_all 策略未退坡）", () => {
    expect(schemaTs).toContain('unique("l3_question_attempts_id_user_id_unique")');
    expect(schemaTs).toContain('submissionId: uuid("submission_id")');
    expect(schemaTs).toContain('submissionRevisionNo: integer("submission_revision_no")');
    expect(schemaTs).toContain('attemptId: uuid("attempt_id")');
    expect(schemaTs).toContain('name: "l3_study_note_references_submission_owner_fk"');
    expect(schemaTs).toContain('name: "l3_study_note_references_attempt_owner_fk"');
    expect(schemaTs).toContain('index("idx_l3_study_note_references_user_submission")');
    expect(schemaTs).toContain('index("idx_l3_study_note_references_user_attempt")');
    expect(schemaTs).toContain('pgPolicy("l3_study_note_references_own_all"');
    expect(schemaTs).toContain('pgPolicy("l3_question_attempts_own_all"');
    expect(schemaTs).toContain('pgPolicy("l3_submissions_own_all"');
  });
});

/**
 * N2 第四条链迁移契约（0047 · 评卷 kind）。
 *
 * 这一条链**不新增列**：kind 只是 CHECK 里的一个字面量。风险因此全在
 * 「三处 CHECK 是否同步放宽」上 —— 漏改任意一处，插入 grading 引用就会被
 * 数据库拒绝，而应用层测试（含真库 rehearsal 之外的单元测试）看不出来。
 */
describe("N2 评卷引用迁移契约（0047）", () => {
  it("0047 存在且在 journal 里登记（顺序是硬合同）", () => {
    const sql = migration("0047");
    expect(sql, "missing 0047 — grading kind must be admitted by a CHECK widening").toBeDefined();
    expect(sql!.tag).toBe("0047_study_note_references_grading_kind");
    expect(journalTags).toContain("0047_study_note_references_grading_kind");
  });

  it("0047 只放宽 CHECK，不新增列、不动评卷表（决策 2：不引入版本维度）", () => {
    const ddl = ddlOnly(migration("0047")!);
    expect(ddl).not.toMatch(/ADD COLUMN/i);
    // 评卷表一个字都不动：latest-wins 写路径（ADR-0035）原样成立。
    expect(ddl).not.toMatch(/l3_grading_results/i);
    // 决策 5 的一半：改判能力来自 UNIQUE(sheet_id,question_id)，
    // 迁移不得偷偷给它加一列版本号。
    expect(ddl).not.toMatch(/version/i);
  });

  it("0047 三处 CHECK 全部含 grading 分支，且与 schema.ts 同源", () => {
    const sql = migration("0047")!;
    // kind_check / target_check / quote_check —— 少改一处就是「有的路径能写、有的不能」。
    expect(sql.normalized).toMatch(/kind_check[^;]*grading/);
    expect(sql.normalized).toMatch(/target_check[^;]*grading/);
    expect(sql.normalized).toMatch(/quote_check[^;]*grading/);
    // schema 真源必须同样承认 grading，否则 drift 检查会在下一轮把库改回去。
    expect(schemaTs).toMatch(/kind_check[^;]*grading/);
    expect(schemaTs).toMatch(/target_check[^;]*grading/);
    expect(schemaTs).toMatch(/quote_check[^;]*grading/);
  });

  it("0047 的 grading 分支钉住 {submission_id, question_id} 且稿次/作答列必须为空", () => {
    const target = /ADD CONSTRAINT "l3_study_note_references_target_check" CHECK \((.+)\);/.exec(
      ddlOnly(migration("0047")!),
    )?.[1] ?? "";
    const grading = target.split(" OR ").find((branch) => branch.includes("'grading'")) ?? "";
    // 身份 = 题纸 + 题（决策 2）。两列都必填。
    expect(grading).toContain("submission_id IS NOT NULL");
    expect(grading).toContain("question_id IS NOT NULL");
    // 稿次/作答列必须为空：否则同一条引用能同时声称「这是稿次引用」和「这是评卷引用」。
    expect(grading).toContain("submission_revision_no IS NULL");
    expect(grading).toContain("attempt_id IS NULL");
    expect(grading).toContain("source_id IS NULL");
  });
});