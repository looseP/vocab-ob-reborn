/**
 * dev-stack —— 自用栈 / 开发栈的双栈运维入口（2026-10-05，自用周基础设施）。
 *
 * 背景：本仓的「运行实例」长期就是「开发实例」—— 镜像从工作区构建（连未提交改动一起）、
 * 全栈共用一个数据卷 `vocab-observatory_postgres-data`。于是开发动作（重建容器、跑迁移、
 * 误写数据）会直接作用在每天用来复习的那个实例与其**不可重建的数据**上
 * （FSRS 调度 + 118 条手工圈记语境）。
 *
 * 本脚本把两条栈的边界封成命令，避免手敲 `-p` / `-f` / 镜像 tag 时的口误：
 *
 * | 命令 | 作用 |
 * |---|---|
 * | `status` | 两条栈的容器 / 端口 / 镜像 / 数据卷对照（只读） |
 * | `up` | 构建并启动**开发栈**（端口 3101，独立数据卷） |
 * | `down` | 停开发栈（**保留**数据卷） |
 * | `refresh-db` | 用自用库快照刷新开发库（`pg_dump` 只读自用，只写开发） |
 * | `promote` | 把当前 main 干净树构建成自用栈镜像并打 `use-<日期>` tag，然后重建自用栈 |
 *
 * ⚠️ 安全边界（写死在代码里，不依赖操作者记忆）：
 * - 只有 `promote` 会碰自用栈，且**要求工作区干净 + 在 main 上**；
 * - `refresh-db` 对自用库只读（`pg_dump`），写操作全部落在 `vocab-dev-*`；
 * - 任何命令都不会 `docker compose down` 自用栈。
 *
 * 零新依赖（ADR-0004）：只用 node 内置模块 + docker / git CLI。
 */
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── 常量：两条栈的身份 ────────────────────────────────────────────────────────
/** 自用栈 = compose.yaml 里的 `name:`（**不要改**，改了会孤儿化正在运行的容器）。 */
const USE_PROJECT = "vocab-observatory";
/** 开发栈 = `-p vocab-dev`，容器/卷自动带该前缀。 */
const DEV_PROJECT = "vocab-dev";
const USE_WEB_PORT = 3001;
const DEV_WEB_PORT = 3101;
const DEV_COMPOSE_FILES = ["-f", "compose.yaml", "-f", "compose.dev.yaml"];
const USE_COMPOSE_FILES = ["-f", "compose.yaml"];
/** 开发栈的镜像 tag 后缀（见 compose.dev.yaml 的隔离说明）。 */
const DEV_IMAGE_SUFFIX = ":dev";
const APP_IMAGES = ["vocab-observatory-v2", "vocab-observatory-v2-migration", "vocab-observatory-v2-backup"] as const;

// ── 进程助手 ─────────────────────────────────────────────────────────────────
function run(binary: string, args: string[], options: { capture?: boolean } = {}): SpawnSyncReturns<string> {
  const result = spawnSync(binary, args, {
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.error) throw result.error;
  if (!options.capture && result.status !== 0) {
    throw new Error(`${binary} ${args.join(" ")} 失败（exit ${result.status ?? "?"}）`);
  }
  return result;
}

function capture(binary: string, args: string[]): string {
  return run(binary, args, { capture: true }).stdout?.trim() ?? "";
}

function compose(project: string, files: string[], args: string[]): void {
  run("docker", ["compose", "-p", project, ...files, ...args]);
}

/** 容器名 = `<project>-<service>-1`（Compose 默认命名）。 */
function container(project: string, service: string): string {
  return `${project}-${service}-1`;
}

function isRunning(name: string): boolean {
  const out = capture("docker", ["ps", "--filter", `name=^${name}$`, "--format", "{{.State}}"]);
  return out === "running";
}

function requireRunning(name: string, hint: string): void {
  if (!isRunning(name)) {
    throw new Error(`容器 ${name} 未在运行。${hint}`);
  }
}

function today(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

// ── 子命令 ───────────────────────────────────────────────────────────────────

/** status：两条栈对照（只读，随时可跑）。 */
function status(): void {
  const rows: Array<[string, string, number, string]> = [
    ["自用栈", USE_PROJECT, USE_WEB_PORT, "vocab-observatory-v2:local"],
    ["开发栈", DEV_PROJECT, DEV_WEB_PORT, "vocab-observatory-v2:dev"],
  ];
  console.log("栈       项目名                  web 端口   期望镜像");
  for (const [label, project, port, image] of rows) {
    console.log(`${label}   ${project.padEnd(22)} ${String(port).padEnd(10)} ${image}`);
  }
  console.log("\n容器状态：");
  for (const [label, project] of rows) {
    const names = ["web", "postgres", "migrate", "review-outbox-worker", "llm-reservation-reaper", "backup-scheduler"];
    const parts = names.map((service) => {
      const name = container(project, service);
      if (isRunning(name)) return `${service}=up`;
      const exists = capture("docker", ["ps", "-a", "--filter", `name=^${name}$`, "--format", "{{.State}}"]);
      return `${service}=${exists || "absent"}`;
    });
    console.log(`  ${label}（${project}）: ${parts.join("  ")}`);
  }
  console.log("\nweb 正在跑的镜像：");
  for (const [label, project] of rows) {
    const name = container(project, "web");
    if (!isRunning(name)) {
      console.log(`  ${label}: （未运行）`);
      continue;
    }
    console.log(`  ${label}: ${capture("docker", ["inspect", name, "--format", "{{.Config.Image}}"])}`);
  }
  console.log("\n数据卷（自用库是**不可重建资产**，开发库是它的快照副本）：");
  for (const [label, project] of rows) {
    console.log(`  ${label}: ${project}_postgres-data`);
  }
}

/** up：构建 + 启动开发栈。 */
function up(): void {
  console.log("[dev-stack] 构建开发栈镜像（tag 后缀 :dev，不会碰自用栈的 :local）…");
  compose(DEV_PROJECT, DEV_COMPOSE_FILES, ["build"]);
  console.log("[dev-stack] 启动开发栈（web 仅绑定 127.0.0.1:3101）…");
  compose(DEV_PROJECT, DEV_COMPOSE_FILES, ["up", "-d", "--wait", "--wait-timeout", "180"]);
  console.log(`[dev-stack] 就绪：http://127.0.0.1:${DEV_WEB_PORT}`);
  console.log("[dev-stack] 提示：开发库是独立卷。要灌入自用库的数据请跑 refresh-db。");
}

/** down：停开发栈（保留卷）。 */
function down(): void {
  compose(DEV_PROJECT, DEV_COMPOSE_FILES, ["down"]);
  console.log("[dev-stack] 开发栈已停（数据卷保留；要清空数据请显式 docker volume rm）。");
  console.log("[dev-stack] 自用栈未受影响。");
}

/**
 * refresh-db：用自用库快照刷新开发库。
 *
 * 三步，写操作全部落在开发栈：
 * 1. `pg_dump` **只读**自用库 → 宿主临时文件；
 * 2. 停开发栈（保留卷）→ 只起 dev postgres；
 * 3. `pg_restore --clean --if-exists` 覆盖开发库 → 重跑角色收敛 → 起全栈 → 自检行数。
 */
function refreshDb(): void {
  const usePg = container(USE_PROJECT, "postgres");
  const devPg = container(DEV_PROJECT, "postgres");
  requireRunning(usePg, "自用栈没在跑？先 `docker compose -f compose.yaml up -d`。");

  const dir = mkdtempSync(join(tmpdir(), "vocab-dev-snapshot-"));
  const dumpPath = join(dir, "use-snapshot.dump");
  try {
    console.log(`[dev-stack] 1/5 从自用库取快照（pg_dump 只读，${usePg}，不动数据）…`);
    const dump = spawnSync("docker", ["exec", usePg, "pg_dump", "-U", "vocab", "-d", "vocab", "-Fc"], {
      encoding: "buffer",
      maxBuffer: 512 * 1024 * 1024,
    });
    if (dump.status !== 0) {
      throw new Error(`pg_dump 失败：${dump.stderr?.toString().slice(0, 400) ?? ""}`);
    }
    writeFileSync(dumpPath, dump.stdout as Buffer);
    console.log(`      快照 ${(Number(dump.stdout?.length ?? 0) / 1024 / 1024).toFixed(1)} MB`);

    console.log("[dev-stack] 2/5 停开发栈（保留数据卷）…");
    compose(DEV_PROJECT, DEV_COMPOSE_FILES, ["down"]);
    compose(DEV_PROJECT, DEV_COMPOSE_FILES, ["up", "-d", "--wait", "--wait-timeout", "120", "postgres"]);
    requireRunning(devPg, "开发栈 postgres 没起来。");

    console.log("[dev-stack] 3/5 拷入并覆盖开发库（--clean --if-exists）…");
    run("docker", ["cp", dumpPath, `${devPg}:/tmp/use-snapshot.dump`]);
    const restore = spawnSync(
      "docker",
      ["exec", devPg, "pg_restore", "-U", "vocab", "-d", "vocab", "--clean", "--if-exists", "--no-owner", "/tmp/use-snapshot.dump"],
      { encoding: "utf8" },
    );
    // pg_restore 在"部分对象不存在"时会返回 1 但已完成主要工作；靠下一步的行数自检定性。
    if (restore.status !== 0) {
      const noise = (restore.stderr ?? "").split("\n").filter((l) => l.trim() && !/does not exist|不存在/.test(l));
      console.log(`      pg_restore 返回 ${restore.status}（部分对象已不存在属正常），非预期输出 ${noise.length} 行`);
      if (noise.length > 0) console.log("      " + noise.slice(0, 5).join("\n      "));
    }
    run("docker", ["exec", devPg, "rm", "-f", "/tmp/use-snapshot.dump"]);

    console.log("[dev-stack] 4/5 重跑角色收敛（恢复 RLS policy / 授权）…");
    compose(DEV_PROJECT, DEV_COMPOSE_FILES, ["run", "--rm", "--no-deps", "database-role-converge"]);

    console.log("[dev-stack] 5/5 起全栈并自检…");
    compose(DEV_PROJECT, DEV_COMPOSE_FILES, ["up", "-d", "--wait", "--wait-timeout", "180"]);
    const count = (pg: string) =>
      capture("docker", ["exec", pg, "psql", "-U", "vocab", "-d", "vocab", "-t", "-A", "-c", "select count(*) from words"]);
    const useWords = count(usePg);
    const devWords = count(devPg);
    console.log(`      自用库 words=${useWords} / 开发库 words=${devWords} ${useWords === devWords ? "✅ 一致" : "⚠️ 不一致，请检查"}`);
    console.log(`[dev-stack] 完成：http://127.0.0.1:${DEV_WEB_PORT}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * promote：把当前 main 干净树做成自用栈版本。
 *
 * **这是唯一会动自用栈的命令**，且有两道闸：
 * - 工作区必须干净（`git status --porcelain` 为空）——构建用的是**工作区内容**，
 *   脏树会把半成品直接推进自用实例；
 * - 必须在 `main` 上（已合并的代码）。
 *
 * 做法：用统一 tag 构建 → 打 `use-<日期>` 标签（回滚锚点）→ 重建自用栈。
 */
function promote(): void {
  const branch = capture("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch !== "main") throw new Error(`promote 只允许在 main 上执行（当前 ${branch}）——先合并再 promote。`);
  const dirty = capture("git", ["status", "--porcelain"]);
  if (dirty.length > 0) {
    throw new Error(`工作区不干净，拒绝 promote（会把未完成改动推进自用实例）：\n${dirty}`);
  }
  const head = capture("git", ["rev-parse", "--short", "HEAD"]);
  const tag = `use-${today()}`;

  console.log(`[dev-stack] promote：main@${head} → 自用栈版本 ${tag}`);
  compose(USE_PROJECT, USE_COMPOSE_FILES, ["build"]);
  for (const image of APP_IMAGES) {
    run("docker", ["tag", `${image}:local`, `${image}:${tag}`]);
  }
  console.log(`[dev-stack] 已打标签：${APP_IMAGES.map((i) => `${i}:${tag}`).join(", ")}`);
  compose(USE_PROJECT, USE_COMPOSE_FILES, ["up", "-d", "--force-recreate", "--wait", "--wait-timeout", "180"]);
  console.log(`[dev-stack] 自用栈已更新：http://127.0.0.1:${USE_WEB_PORT}`);
  console.log(`[dev-stack] 回滚（如需）：docker tag vocab-observatory-v2:${tag} vocab-observatory-v2:local && \\`);
  console.log("                       docker compose -f compose.yaml up -d --force-recreate web");
}

function help(): void {
  console.log(`dev-stack —— 自用栈 / 开发栈边界

  npx tsx scripts/dev-stack.ts <命令>

  status       两条栈的容器 / 端口 / 镜像 / 数据卷对照（只读）
  up           构建并启动开发栈（端口 ${DEV_WEB_PORT}，独立数据卷）
  down         停开发栈（保留数据卷；自用栈不受影响）
  refresh-db   用自用库快照刷新开发库（pg_dump 只读自用，只写开发）
  promote      把当前 main 构建成自用栈版本并打 use-<日期> tag，然后重建自用栈

  边界：
  - 只有 promote 会动自用栈，且要求工作区干净 + 在 main 上；
  - 自用栈的数据卷 ${USE_PROJECT}_postgres-data 是不可重建资产，任何命令都不会删它；
  - 自用栈更新只走 promote，**不要**对自用栈跑 docker compose build。`);
}

const command = process.argv[2] ?? "help";
try {
  switch (command) {
    case "status": status(); break;
    case "up": up(); break;
    case "down": down(); break;
    case "refresh-db": refreshDb(); break;
    case "promote": promote(); break;
    case "help":
    case "--help":
    case "-h": help(); break;
    default:
      console.error(`未知命令：${command}\n`);
      help();
      process.exitCode = 1;
  }
} catch (error) {
  console.error(`\n[dev-stack] 失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
