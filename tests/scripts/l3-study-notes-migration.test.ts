/**
 * 学习笔记（N1）迁移契约测试（Task 02）——
 * 发现式定位含 l3_study_notes 的迁移 SQL（编号由 db:generate 实际产出决定，
 * 不硬编码、不预占）；对迁移 SQL 与 src/db/schema.ts 权威定义做文本契约断言：
 * 5 张表、复合 owner FK、RESTRICT 删除保护、RLS、关键 CHECK、journal 登记。
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const releaseDir = `${repoRoot}drizzle-release/`;

const STUDY_TABLES = [
  "l3_study_notes",
  "l3_study_note_venues",
  "l3_study_topics",
  "l3_study_topic_notes",
  "l3_study_note_references",
] as const;

function listMigrationFiles(): string[] {
  return readdirSync(releaseDir)
    .filter((file) => /^\d{4}_.+\.sql$/.test(file))
    .sort();
}

const migrationFile = listMigrationFiles().find((file) =>
  readFileSync(`${releaseDir}${file}`, "utf8").includes('CREATE TABLE "l3_study_notes"'),
);
const migrationSql = migrationFile ? readFileSync(`${releaseDir}${migrationFile}`, "utf8") : "";
const schemaTs = readFileSync(`${repoRoot}src/db/schema.ts`, "utf8");

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

const normalizedMigration = normalizeSql(migrationSql);

describe("学习笔记迁移契约（0039+，实际编号见 journal）", () => {
  it("存在含本 feature 五张表的迁移文件且已登记 journal", () => {
    expect(migrationFile, "no migration creates l3_study_notes — run npm run db:generate").toBeDefined();
    const journal = JSON.parse(readFileSync(`${releaseDir}meta/_journal.json`, "utf8")) as {
      entries: { tag: string }[];
    };
    expect(journal.entries.some((entry) => `${entry.tag}.sql` === migrationFile)).toBe(true);
  });

  it("五张表均以 CREATE TABLE 建立", () => {
    for (const table of STUDY_TABLES) {
      expect(normalizedMigration).toContain(`CREATE TABLE "${table}"`);
    }
  });

  it("复合 owner FK：venue/topic_note/reference 的 note 方向为 CASCADE", () => {
    expect(normalizedMigration).toContain(
      'FOREIGN KEY ("note_id","user_id") REFERENCES "public"."l3_study_notes"("id","user_id") ON DELETE cascade',
    );
    expect(normalizedMigration).toContain(
      'FOREIGN KEY ("topic_id","user_id") REFERENCES "public"."l3_study_topics"("id","user_id") ON DELETE cascade',
    );
  });

  it("引用行的 source/question 方向为 RESTRICT（删除保护兜底）", () => {
    expect(normalizedMigration).toContain(
      'FOREIGN KEY ("source_id","user_id") REFERENCES "public"."l3_sources"("id","user_id") ON DELETE restrict',
    );
    expect(normalizedMigration).toContain(
      'FOREIGN KEY ("question_id","user_id") REFERENCES "public"."l3_questions"("id","user_id") ON DELETE restrict',
    );
  });

  it("五张表启用 RLS 并各有 own_all policy（auth.uid() = user_id）", () => {
    for (const table of STUDY_TABLES) {
      expect(normalizedMigration).toContain(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`);
      expect(normalizedMigration).toContain(
        `CREATE POLICY "${table}_own_all" ON "${table}" AS PERMISSIVE FOR ALL TO public USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));`,
      );
    }
  });

  it("引用关键约束：kind 枚举、恰一 target、quote 完整性、option_key 归属", () => {
    expect(normalizedMigration).toMatch(
      /CONSTRAINT "l3_study_note_references_kind_check" CHECK \(kind = ANY \(ARRAY\['source'::text, 'source_quote'::text, 'question'::text, 'stem_quote'::text, 'option_quote'::text\]\)\)/,
    );
    expect(normalizedMigration).toMatch(/CONSTRAINT "l3_study_note_references_target_check" CHECK \(/);
    expect(normalizedMigration).toMatch(/CONSTRAINT "l3_study_note_references_quote_check" CHECK \(/);
    expect(normalizedMigration).toMatch(/CONSTRAINT "l3_study_note_references_option_key_check" CHECK \(/);
  });

  it("笔记关键约束：status/version/标题与正文长度/幂等列", () => {
    expect(normalizedMigration).toMatch(
      /CONSTRAINT "l3_study_notes_status_check" CHECK \(status = ANY \(ARRAY\['active'::text, 'archived'::text\]\)\)/,
    );
    expect(normalizedMigration).toMatch(/CONSTRAINT "l3_study_notes_version_check" CHECK \(version >= 1\)/);
    expect(normalizedMigration).toMatch(/CONSTRAINT "l3_study_notes_title_check" CHECK \(char_length\(title\) <= 120\)/);
    expect(normalizedMigration).toMatch(/CONSTRAINT "l3_study_notes_body_check" CHECK \(char_length\(body_md\) <= 100000\)/);
    expect(normalizedMigration).toMatch(
      /CONSTRAINT "l3_study_notes_user_create_request_unique" UNIQUE\("user_id","create_request_id"\)/,
    );
  });

  it("venue 主键与题型 CHECK、topic 主键与排序索引", () => {
    expect(normalizedMigration).toMatch(
      /CONSTRAINT "l3_study_note_venues_pkey" PRIMARY KEY\("note_id","question_type"\)|CONSTRAINT "l3_study_note_venues_note_id_question_type_pk" PRIMARY KEY\("note_id","question_type"\)/,
    );
    expect(normalizedMigration).toMatch(/CONSTRAINT "l3_study_note_venues_type_check" CHECK \(/);
    expect(normalizedMigration).toMatch(/"l3_study_topic_notes" USING btree \("topic_id","position"/);
  });

  it("迁移只创建本 feature 对象（无 DROP TABLE，ALTER 目标均为 5 张新表）", () => {
    expect(migrationSql).not.toMatch(/DROP TABLE/i);
    const alterTargets = [...migrationSql.matchAll(/ALTER TABLE "([^"]+)"/g)].map((m) => m[1]!);
    for (const target of alterTargets) {
      expect(STUDY_TABLES as readonly string[]).toContain(target);
    }
  });

  it("schema.ts 保持权威同步（表对象与复合 FK 先例格式）", () => {
    for (const table of STUDY_TABLES) {
      expect(schemaTs).toContain(`pgTable("${table}"`);
    }
    expect(schemaTs).toContain('unique("l3_study_notes_id_user_id_unique")');
    expect(schemaTs).toContain('pgPolicy("l3_study_note_references_own_all"');
  });
});
