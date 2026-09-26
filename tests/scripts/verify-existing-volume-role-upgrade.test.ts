import { describe, expect, it, vi } from "vitest";
import {
  allocateUpgradePort,
  authoritativeMigrationCount,
  existingVolumeCleanupInvocation,
  existingVolumeEnvironment,
  existingVolumeInvocations,
  existingVolumeProjectName,
  runExistingVolumeRoleUpgrade,
} from "../../scripts/verify-existing-volume-role-upgrade";
import type { CommandInvocation } from "../../scripts/run-database-roles-acceptance";

const UUID = "01234567-89ab-cdef-0123-456789abcdef";
const PROJECT = "vocab-observatory-existing-volume-0123456789abcdef0123456789abcdef";
const PASSWORDS = [
  "upgrade-app-password-1",
  "upgrade-worker-password-2",
  "upgrade-backup-password-3",
  "upgrade-migration-password-4",
] as const;

describe("existing local volume role upgrade", () => {
  it("derives the expected migration count from the authoritative journal", () => {
    // 0017: word_l2_content.source_ref uuid→text（候选池 sourceRef 自由文本契约）
    // 0018: refresh_l2_cache / finalize_l2_content_hash 守卫放宽为已认证 actor（候选池 content-first）
    // 0019: note_entries 条目制笔记（建表 + RLS + 文档笔记迁移为条目）
    // 0020: l3_sources 素材正文捕获（content_text/content_hash + 用户内唯一索引，L3 素材空间 MVP）
    // 0021: l3_sources/l3_contexts UPDATE grant (FOR UPDATE row locks)
    // 0022: l3_occurrences.bound_sense（语境义快照，Bound sense 列）
    // 0023: words DELETE grant + RLS DELETE policy（详情页 stub 词条硬删除）
    // 0024: words UPDATE grant（仅用于 FOR UPDATE 行锁，0021 同一陷阱）
    // 0025: words stub-only UPDATE policy（RLS 下 FOR UPDATE 要求行同时通过 UPDATE policy）
    // 0026: l3_sources 书架搜索 pg_trgm GIN 索引（title + content_text，ILIKE 加速）
    // 0027: word_l2_content/l3_sources direction 方向列 + CHECK（ADR-0017；方向只作维度，无唯一约束）
    // 0028: upgrade_work_orders/l3_sessions/l3_practice_attempts 三张新表（ADR-0018/0019）
    // 0029: 兜底删除旧版 0027 的 partial UNIQUE 索引（P0 修正，2026-09-11；新库 no-op）
    // 0030: l3_source_spaces 子空间 junction 表（ADR-0019 §4 能力域轴；复合 owner FK + RLS）
    // 0031: l3_proposals (user_id, input_hash) partial unique index（ADR-0029 §7②，proposal 幂等收口）
    // 0032: l3_questions/l3_papers 题目与试卷实体（ADR-0030，payload 引用 + RLS + 题型 CHECK）
    // 0033: l3_question_annotations/l3_annotation_tags 做题注记与规律标签字典（批次一，锚点 CHECK + 四权 RLS）
    // 0034: l3_submissions/l3_question_attempts 题纸与作答历史（批次二，状态机 + scope_key 部分唯一 + 题级软删链）
    // 0035: l3_question_assessments 评析区（增补批，一题一条 upsert + last_editor 留痕）
    // 0036: l3_grading_results 评卷结果（批次三①，UNIQUE(sheet_id,question_id) 同键覆写 + graded_by 留痕）
    // 0037: l3_question_annotations.review_sheet_id 评审来源列（F-1 回看闭环，SET NULL 外键）
    // 0038: l3_writing_tasks/l3_writing_feedback + l3_submissions 四元数据与 l3_question_attempts venue 扩 writing（作文子空间 W1）
    // 0039: l3_study_notes/l3_study_note_venues/l3_study_topics/l3_study_topic_notes/l3_study_note_references 五表（N1 学习笔记：owner RLS + 复合 FK + 引用 RESTRICT 删除保护）
    // 0040: l3_question_assessments(id,user_id) 唯一（N2 评析引用的复合 FK 前置依赖）
    // 0041: l3_study_note_references.assessment_id + 评析复合 FK + 三个 CHECK（N2 评析引用）
    // 拆两步的原因：drizzle 生成的 FK 语句排在同批 UNIQUE 之前，同批内会撞
    // “no unique constraint matching given keys”（真实 PostgreSQL 已复现）。
    // 0042: l3_study_note_references.target_note_id + 笔记复合 FK + 禁自引用 CHECK
    //       + 三个 CHECK 重建（N2 第二条链·笔记互链）。前置 UNIQUE(id,user_id) 在
    //       l3_study_notes 上早已存在，故本链**单段迁移**即可，无需 0040 那种拆分。
    // 0043: l3_question_attempts(id,user_id) 唯一（N2 第三条链·attempt 引用的复合 FK 前置依赖）
    // 0044: l3_study_note_references.submission_id / submission_revision_no / attempt_id
    //       + sheet/attempt 复合属主 FK（RESTRICT）+ 三个 CHECK 重建 + 两个索引 + revision 正值 CHECK。
    //       拆两步的原因与 0040/0041 同：drizzle 生成的 FK 语句排在同批 UNIQUE 之前。
    // 0045: user_word_progress.ladder_rung smallint（ADR-0036 阶梯起步档显式列，
    //       CHECK 1..3）+ 存量幂等回填 UPDATE（f(S,rv)，二次执行零行变化）。
    expect(authoritativeMigrationCount()).toBe(46);
  });

  it("guards the disposable Compose project and cleanup", () => {
    expect(existingVolumeProjectName(UUID)).toBe(PROJECT);
    expect(() => existingVolumeProjectName("../../other")).toThrow(/unguarded/);
    expect(() => existingVolumeCleanupInvocation("vocab-existing-volume", {})).toThrow(/unguarded/);
  });

  it("allocates a loopback port from the required high range", async () => {
    const port = await allocateUpgradePort();
    expect(port).toBeGreaterThanOrEqual(49152);
    expect(port).toBeLessThanOrEqual(65535);
  });

  it("inherits occupied-port retries and exhaustion from the shared allocator", async () => {
    const candidatePort = vi.fn<() => number>()
      .mockReturnValueOnce(50001)
      .mockReturnValueOnce(50002);
    const probePort = vi.fn<(port: number) => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    await expect(allocateUpgradePort({ candidatePort, probePort, attempts: 2 })).resolves.toBe(50002);
    await expect(allocateUpgradePort({
      candidatePort: () => 50003,
      probePort: async () => false,
      attempts: 2,
    })).rejects.toThrow(/after 2 attempts/);
  });

  it("keeps the historical admin and creates four distinct governed URLs", () => {
    const env = existingVolumeEnvironment(61234, PASSWORDS);
    expect(new URL(env.DATABASE_ADMIN_URL!).username).toBe("vocab");
    expect([
      env.APP_DATABASE_URL,
      env.WORKER_DATABASE_URL,
      env.BACKUP_DATABASE_URL,
      env.MIGRATION_DATABASE_URL,
    ].map((value) => new URL(value!).username)).toEqual([
      "vocab_app",
      "vocab_worker",
      "vocab_backup",
      "vocab_migration",
    ]);
    expect(new Set([
      env.APP_DATABASE_URL,
      env.WORKER_DATABASE_URL,
      env.BACKUP_DATABASE_URL,
      env.MIGRATION_DATABASE_URL,
    ].map((value) => new URL(value!).password)).size).toBe(4);
  });

  it("freezes legacy migration, prepare, governed migration, converge, full role verification, and data verification order", () => {
    const env = existingVolumeEnvironment(61234, PASSWORDS);
    expect(existingVolumeInvocations(PROJECT, env).map(({ command, args }) => [command, args])).toEqual([
      ["docker", ["compose", "-f", "compose.database-roles-acceptance.yaml", "-p", PROJECT, "up", "-d", "--wait", "postgres"]],
      ["npm", ["exec", "--", "tsx", "scripts/verify-existing-volume-role-upgrade.ts", "legacy"]],
      ["npm", ["exec", "--", "tsx", "scripts/bootstrap-database-roles.ts", "prepare"]],
      ["npm", ["run", "db:migrate"]],
      ["npm", ["exec", "--", "tsx", "scripts/bootstrap-database-roles.ts", "converge"]],
      ["npm", ["run", "test:db-roles"]],
      ["npm", ["exec", "--", "tsx", "scripts/verify-existing-volume-role-upgrade.ts", "verify"]],
    ]);
    expect(existingVolumeCleanupInvocation(PROJECT, env).args).toEqual([
      "compose", "-f", "compose.database-roles-acceptance.yaml", "-p", PROJECT,
      "down", "--volumes", "--remove-orphans",
    ]);
  });

  it("cleans the guarded project after success", async () => {
    const calls: CommandInvocation[] = [];
    await runExistingVolumeRoleUpgrade({
      uuid: () => UUID,
      password: vi.fn<() => string>()
        .mockReturnValueOnce(PASSWORDS[0])
        .mockReturnValueOnce(PASSWORDS[1])
        .mockReturnValueOnce(PASSWORDS[2])
        .mockReturnValueOnce(PASSWORDS[3]),
      allocatePort: async () => 61234,
      run: async (invocation) => { calls.push(invocation); },
      onSignal: () => undefined,
      offSignal: () => undefined,
    });
    expect(calls).toHaveLength(8);
    expect(calls.at(-1)?.args).toContain("down");
  });

  it("does not report success when SIGINT arrives during cleanup", async () => {
    const listeners = new Map<NodeJS.Signals, () => void>();
    const calls: CommandInvocation[] = [];
    await expect(runExistingVolumeRoleUpgrade({
      uuid: () => UUID,
      password: (() => {
        let index = 0;
        return () => PASSWORDS[index++]!;
      })(),
      allocatePort: async () => 61234,
      run: async (invocation) => {
        calls.push(invocation);
        if (invocation.args.includes("down")) listeners.get("SIGINT")?.();
      },
      onSignal: (signal, listener) => { listeners.set(signal, listener); },
      offSignal: (signal) => { listeners.delete(signal); },
    })).rejects.toThrow(/interrupted by SIGINT/);
    expect(calls.at(-1)?.args).toContain("down");
    expect(listeners.size).toBe(0);
  });

  it("turns SIGTERM into a primary failure, aborts the active command, and still cleans", async () => {
    const listeners = new Map<NodeJS.Signals, () => void>();
    const calls: CommandInvocation[] = [];
    await expect(runExistingVolumeRoleUpgrade({
      uuid: () => UUID,
      password: (() => {
        let index = 0;
        return () => PASSWORDS[index++]!;
      })(),
      allocatePort: async () => 61234,
      run: async (invocation, signal) => {
        calls.push(invocation);
        if (calls.length === 1) {
          listeners.get("SIGTERM")?.();
          expect(signal?.aborted).toBe(true);
        }
      },
      onSignal: (signal, listener) => { listeners.set(signal, listener); },
      offSignal: (signal) => { listeners.delete(signal); },
    })).rejects.toThrow(/interrupted by SIGTERM/);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.args).toContain("down");
    expect(listeners.size).toBe(0);
  });
});
