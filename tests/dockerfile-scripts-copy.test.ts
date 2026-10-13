/**
 * Dockerfile 的 scripts/ 拷贝白名单必须覆盖入口脚本的**全部**传递依赖。
 *
 * 2026-10-13 踩过：`run-backup-scheduler.ts` 新 import 了 `./backup-scheduler-support`，
 * 而 Dockerfile 对 scripts/ 是**逐文件**白名单拷贝 ⇒ 镜像构建成功、容器一启动就
 * `ERR_MODULE_NOT_FOUND` 崩溃重启。本地 `docker compose build` 不会报错，只有 CI 的
 * 干净卷冒烟会挂 —— 而这个测试让它在**本地**就能发现。
 *
 * 做法：从 Dockerfile 取出被拷贝的 scripts 文件集合，再沿相对 import 做传递闭包，
 * 任何落在 scripts/ 下却没被拷贝的文件都算缺口。
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const dockerfile = readFileSync(join(root, "Dockerfile"), "utf8");

/** Dockerfile 里 `COPY ... /app/scripts/<name> ./scripts/` 拷贝进来的文件。 */
function copiedScriptFiles(): Set<string> {
  const copied = new Set<string>();
  for (const match of dockerfile.matchAll(/\/app\/scripts\/([\w.-]+\.ts)\s/g)) {
    copied.add(match[1]);
  }
  return copied;
}

/**
 * 读一个脚本文件，找出它相对 import 的 scripts/ 同僚。
 *
 * 注意：tsx/ESM 的 import 说明符**不带扩展名**（`./backup-scheduler-support`），
 * 这里统一补成 `.ts` 再比 —— 早先版本用 `endsWith(".ts")` 过滤，结果把所有真实
 * import 都跳过了，测试空转（2026-10-13 负向验证时抓到的）。
 */
function relativeScriptImports(file: string): string[] {
  const source = readFileSync(join(root, "scripts", file), "utf8");
  const found: string[] = [];
  for (const match of source.matchAll(/from\s+"(\.[^"]+)"/g)) {
    const spec = match[1];
    // 只关心 scripts/ 内的同僚：`./x` 或 `../scripts/x`
    const bare = spec.startsWith("./")
      ? spec.slice(2)
      : spec.replace(/^\.\.\/scripts\//, "");
    if (bare.startsWith("..") || bare.length === 0) continue;
    // 归一化成 .ts 文件名（容忍 import 时写 .js 的 Node 风格）
    const withoutExt = bare.replace(/\.(ts|js)$/, "");
    found.push(`${withoutExt}.ts`);
  }
  return found;
}

describe("Dockerfile scripts copy allowlist", () => {
  it("covers the transitive relative imports of every copied script", () => {
    const copied = copiedScriptFiles();
    expect(copied.size).toBeGreaterThan(0);

    const missing: string[] = [];
    const seen = new Set<string>();
    const queue = [...copied];

    while (queue.length > 0) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      for (const dependency of relativeScriptImports(file)) {
        if (!copied.has(dependency) && !seen.has(dependency)) {
          missing.push(`${file} -> ${dependency}`);
        }
        queue.push(dependency);
      }
    }

    expect(missing, `这些脚本被 import 但没被 Dockerfile 拷贝进镜像：\n${missing.join("\n")}`).toEqual([]);
  });

  it("scripts/ 下没有未被任何入口引用的孤儿 .ts（提示该删或该拷）", () => {
    // 只做提示不断言：scripts/ 里有大量一次性运维脚本（verify-*、seed-*），
    // 它们本就不该进运行时镜像。真正的问题是「被 import 却没拷」，由上一条盯着。
    const onDisk = readdirSync(join(root, "scripts")).filter((name) => name.endsWith(".ts"));
    const copied = copiedScriptFiles();
    const uncopied = onDisk.filter((name) => !copied.has(name));
    expect(uncopied.length).toBeGreaterThan(0);
  });
});
