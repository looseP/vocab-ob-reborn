import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 自用栈 / 开发栈的**隔离不变量**（2026-10-05）。
 *
 * 为什么要有这个测试：`compose.dev.yaml` + `scripts/dev-stack.ts` 的全部价值在于
 * 「开发动作碰不到自用实例与它的数据」。而这些保证全靠几个很容易被"顺手改掉"的细节：
 *
 * - 开发栈必须落在 `vocab-dev` 项目名下（容器与**命名卷**都靠这个前缀隔离）；
 * - 开发栈的端口必须是 3101 且**只有 3101**（`ports:` 不写 `!override` 会被合并成
 *   3001+3101，而 3001 已被自用栈占用 ⇒ 开发栈起不来）；
 * - 开发镜像 tag 必须是 `:dev`（写成 env 变量的话，任何人手动跑一次 build 就会覆盖
 *   自用栈正在用的 `:local`，且无任何提示）；
 * - 开发栈的备份目录必须与自用栈不同（**项目名隔离不了宿主相对路径**）；
 * - **自用栈自己的身份一个都不能变**（改 `name:` / 端口 / 卷名会孤儿化正在运行的容器）。
 *
 * 这些都属于"约束要写在机器里，而不是写在文档里"。文档见 `docs/operations/dev-stack.md`。
 *
 * 判定方式：直接渲染 Compose 配置（`docker compose config --format json`），
 * 断言最终值 —— 不解析 YAML 源码，避免"写法变了但语义没变"造成假红。
 */

const projectRoot = resolve(import.meta.dirname, "../..");
const dockerAvailable = spawnSync("docker", ["compose", "version"], { encoding: "utf8" }).status === 0;
const describeDocker = dockerAvailable ? describe : describe.skip;

/** 环境里残留这些变量会改变渲染结果（例如开发者 shell 里 export 了 APP_IMAGE）。 */
const composeEnvironmentKeys = [
  "APP_IMAGE",
  "MIGRATION_IMAGE",
  "BACKUP_IMAGE",
  "APP_ORIGIN",
  "APP_PORT",
  "DEV_APP_PORT",
  "DEV_APP_ORIGIN",
  "DEV_BACKUP_HOST_DIR",
  "BACKUP_HOST_DIR",
  "COMPOSE_FILE",
  "COMPOSE_PROJECT_NAME",
  "COMPOSE_PROFILES",
] as const;

interface RenderedService {
  image?: string;
  profiles?: string[];
  ports?: Array<{ host_ip?: string; published?: string; target?: number }>;
  volumes?: Array<{ type?: string; source?: string; target?: string }>;
}

interface RenderedConfig {
  name?: string;
  services: Record<string, RenderedService>;
  volumes?: Record<string, { name?: string }>;
}

function composeConfig(args: string[]): RenderedConfig {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of composeEnvironmentKeys) delete env[key];
  const result = spawnSync(
    "docker",
    ["compose", ...args, "config", "--format", "json"],
    { cwd: projectRoot, encoding: "utf8", env },
  );
  expect(result.status, result.stderr?.toString()).toBe(0);
  return JSON.parse(result.stdout?.toString() ?? "") as RenderedConfig;
}

const devConfig = (profiles: string[] = []): RenderedConfig =>
  composeConfig(["-p", "vocab-dev", "-f", "compose.yaml", "-f", "compose.dev.yaml", ...profiles.flatMap((p) => ["--profile", p])]);
const useConfig = (): RenderedConfig => composeConfig(["-f", "compose.yaml"]);

describeDocker("开发栈隔离不变量", () => {
  it("落在 vocab-dev 项目名下 —— 容器与命名卷都靠这个前缀与自用栈隔离", () => {
    const config = devConfig();
    expect(config.name).toBe("vocab-dev");
    expect(config.volumes?.["postgres-data"]?.name).toBe("vocab-dev_postgres-data");
  });

  it("web 只发布 3101，且没有被合并出 3001（3001 属于自用栈）", () => {
    const ports = devConfig().services.web?.ports ?? [];
    const published = ports.map((p) => p.published);
    expect(published).toEqual(["3101"]);
    expect(ports[0]?.host_ip).toBe("127.0.0.1");
    expect(ports[0]?.target).toBe(3001);
  });

  it("镜像 tag 全是 :dev —— 开发构建不会覆盖自用栈正在跑的 :local", () => {
    const config = devConfig(["dev-backups"]);
    expect(config.services.web?.image).toBe("vocab-observatory-v2:dev");
    expect(config.services.migrate?.image).toBe("vocab-observatory-v2-migration:dev");
    expect(config.services["database-role-bootstrap"]?.image).toBe("vocab-observatory-v2-migration:dev");
    expect(config.services["database-role-converge"]?.image).toBe("vocab-observatory-v2-migration:dev");
    expect(config.services["review-outbox-worker"]?.image).toBe("vocab-observatory-v2:dev");
    expect(config.services["llm-reservation-reaper"]?.image).toBe("vocab-observatory-v2:dev");
    expect(config.services["backup-scheduler"]?.image).toBe("vocab-observatory-v2-backup:dev");
  });

  it("定时备份默认不跑（开发库是自用库的副本，不需要备份它）", () => {
    // 未启用 profile 时 Compose 不渲染该服务；启用后必须带 dev-backups profile。
    expect(devConfig().services["backup-scheduler"]).toBeUndefined();
    expect(devConfig(["dev-backups"]).services["backup-scheduler"]?.profiles).toContain("dev-backups");
  });

  it("备份目录与自用栈不同 —— 项目名隔离不了宿主相对路径", () => {
    const devBackup = devConfig(["dev-backups"]).services["backup-scheduler"]?.volumes?.[0]?.source ?? "";
    const useBackup = useConfig().services["backup-scheduler"]?.volumes?.[0]?.source ?? "";
    expect(devBackup.replaceAll("\\", "/")).toMatch(/\/\.dev\/backups$/);
    expect(useBackup).not.toBe(devBackup);
  });
});

describeDocker("自用栈身份不被本机制改动", () => {
  it("项目名、端口、卷名、镜像 tag 全部保持原样（否则会孤儿化正在运行的容器）", () => {
    const config = useConfig();
    expect(config.name).toBe("vocab-observatory");
    expect(config.volumes?.["postgres-data"]?.name).toBe("vocab-observatory_postgres-data");
    const ports = config.services.web?.ports ?? [];
    expect(ports.map((p) => p.published)).toEqual(["3001"]);
    expect(config.services.web?.image).toBe("vocab-observatory-v2:local");
    // 自用栈的备份调度必须**默认开启**（它是数据资产的唯一自动防线）。
    expect(config.services["backup-scheduler"]?.profiles ?? []).toEqual([]);
  });
});
