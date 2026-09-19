/**
 * Writing E2E 报告校验器（fail-closed）——`.github/workflows/writing-e2e.yml` 实际调用的
 * 单一真源（无内联复制）。
 *
 * 判定项（任一不满足即失败，退出码 1）：
 *  ① PW_EXIT（playwright 进程退出码，经环境变量传入）必须存在、为合法整数、且为 0；
 *  ② 报告的全局 errors 必须为空（webServer 启动失败 / teardown 失败等非用例故障）；
 *  ③ 收集数恰为 EXPECTED_WRITING_E2E_SPECS（测试文件被删/改名或 gating 环境缺失 → 红灯，
 *     防「绿而未跑」）；
 *  ④ 跳过数为 0（E2E_WRITING_SMOKE 未生效等一律红灯）；
 *  ⑤ 失败数为 0 且 stats.unexpected 为 0。
 *
 * 「四项通过但进程非零退出」与「四项通过但存在全局错误」同样判失败——2026-09-18 CI 首跑
 * （collected=0，webServer 端口冲突）教训：只看用例计数会漏掉进程级/全局级故障信号。
 *
 * 用法（CI）：PW_EXIT=$? npx tsx scripts/verify-writing-e2e-report.ts /tmp/pw-writing.json
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const EXPECTED_WRITING_E2E_SPECS = 7;

export interface WritingE2EValidation {
  ok: boolean;
  /** 计数行（无论成败都产出，满足「报告收集数、执行数、跳过数及原因」）。 */
  line: string;
  errors: string[];
}

interface PlaywrightNode {
  suites?: PlaywrightNode[];
  specs?: PlaywrightNode[];
  tests?: Array<{ status?: string }>;
}

interface ReportShape extends PlaywrightNode {
  errors?: unknown[];
  stats?: { unexpected?: number } | undefined;
}

function isIntegerText(text: string): boolean {
  return /^-?\d+$/.test(text.trim());
}

export function validateWritingE2EReport(
  report: unknown,
  pwExitRaw: string | undefined,
): WritingE2EValidation {
  const errors: string[] = [];

  // ① PW_EXIT：缺失 / 非法 / 非 0 一律失败。
  const pwExitText = pwExitRaw === undefined || pwExitRaw.trim() === "" ? "<missing>" : pwExitRaw;
  if (pwExitRaw === undefined || pwExitRaw.trim() === "") {
    errors.push("PW_EXIT 缺失：必须提供 playwright 进程退出码（env PW_EXIT）");
  } else if (!isIntegerText(pwExitRaw)) {
    errors.push(`PW_EXIT 非法：期望整数退出码，收到 ${JSON.stringify(pwExitRaw)}`);
  } else if (Number(pwExitRaw.trim()) !== 0) {
    errors.push(`PW_EXIT 非 0（${pwExitRaw.trim()}）：playwright 进程级故障（即便用例计数看似通过）`);
  }

  const root = (report ?? {}) as ReportShape;

  // ② 全局 errors 非空一律失败。
  const globalErrors = Array.isArray(root.errors) ? root.errors : [];
  for (const entry of globalErrors) {
    const message = entry !== null && typeof entry === "object" && "message" in entry
      ? String((entry as { message?: unknown }).message)
      : JSON.stringify(entry);
    errors.push(`playwright 全局错误：${message}`);
  }

  // ③-⑤ 用例计数（递归收集，收集/跳过/失败三查）。
  const specs: PlaywrightNode[] = [];
  const collect = (suite: PlaywrightNode): void => {
    for (const nested of suite.suites ?? []) collect(nested);
    for (const spec of suite.specs ?? []) specs.push(spec);
  };
  for (const suite of root.suites ?? []) collect(suite);

  const total = specs.length;
  const skipped = specs.filter((spec) => (spec.tests ?? []).some((test) => test.status === "skipped")).length;
  const failed = specs.filter((spec) =>
    (spec.tests ?? []).some((test) => test.status !== "expected" && test.status !== "skipped"),
  ).length;
  const unexpected = root.stats?.unexpected ?? 0;

  if (total !== EXPECTED_WRITING_E2E_SPECS) {
    errors.push(`收集数不符：期望恰 ${EXPECTED_WRITING_E2E_SPECS} 个用例，实际 collected=${total}`);
  }
  if (skipped !== 0) {
    errors.push(`存在被静默跳过的用例（skipped=${skipped}）：gating/配置/环境缺失`);
  }
  if (failed !== 0 || unexpected !== 0) {
    errors.push(`存在失败用例（failed=${failed}, stats.unexpected=${unexpected}）`);
  }

  const line = `collected=${total} executed=${total - skipped} skipped=${skipped} failed=${failed} passed=${total - skipped - failed} (pw_exit=${pwExitText})`;
  return { ok: errors.length === 0, line, errors };
}

export function main(argv: string[] = process.argv, env: NodeJS.ProcessEnv = process.env): number {
  const reportPath = argv[2] ?? "/tmp/pw-writing.json";
  let report: unknown;
  try {
    report = JSON.parse(readFileSync(reportPath, "utf8"));
  } catch (error) {
    console.error(`writing E2E 报告不可读：${reportPath}：${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  const result = validateWritingE2EReport(report, env.PW_EXIT);
  console.log(result.line);
  for (const message of result.errors) console.error(`FAIL: ${message}`);
  return result.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
