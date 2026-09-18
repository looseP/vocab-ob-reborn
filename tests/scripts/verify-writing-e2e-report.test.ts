/**
 * validateWritingE2EReport（writing E2E fail-closed 校验器）回归测试。
 *
 * 直接导入 workflow 实际调用的同一模块（scripts/verify-writing-e2e-report.ts），
 * 不复制校验逻辑；覆盖任务书要求的六个场景：
 *   正常通过 / 零收集 / 跳过 / 用例失败 / 四项通过但进程非零退出 / 四项通过但存在全局错误，
 * 另加 PW_EXIT 缺失与非法、以及 2026-09-18 CI 首跑实况（collected=0 + 全局错误 + 非零退出）复刻。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  EXPECTED_WRITING_E2E_SPECS,
  main,
  validateWritingE2EReport,
} from "../../scripts/verify-writing-e2e-report";

type SpecStatus = "expected" | "skipped" | "unexpected" | "timedOut";

function spec(status: SpecStatus) {
  return { tests: [{ status }] };
}

/** 与 playwright --reporter=json 同形；默认 4 用例全过，且带一层嵌套套件（覆盖递归收集）。 */
function report(options: {
  statuses?: SpecStatus[];
  errors?: unknown[];
  unexpected?: number;
} = {}): Record<string, unknown> {
  const statuses = options.statuses ?? ["expected", "expected", "expected", "expected"];
  return {
    config: { version: "1.61.1" },
    suites: [{ suites: [{ specs: statuses.map((status) => spec(status)) }] }],
    errors: options.errors ?? [],
    stats: {
      expected: statuses.filter((status) => status === "expected").length,
      skipped: statuses.filter((status) => status === "skipped").length,
      unexpected: options.unexpected ?? statuses.filter((status) => status !== "expected" && status !== "skipped").length,
      flaky: 0,
    },
  };
}

function failText(result: ReturnType<typeof validateWritingE2EReport>): string {
  return result.errors.join("\n");
}

describe("validateWritingE2EReport（fail-closed 校验器）", () => {
  it("场景① 正常通过：4/4 expected + PW_EXIT=0 → ok，计数行正确", () => {
    const result = validateWritingE2EReport(report(), "0");
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.line).toBe("collected=4 executed=4 skipped=0 failed=0 passed=4 (pw_exit=0)");
    expect(EXPECTED_WRITING_E2E_SPECS).toBe(4);
  });

  it("场景② 零收集：无 specs → fail（收集数不符）", () => {
    const result = validateWritingE2EReport(report({ statuses: [] }), "0");
    expect(result.ok).toBe(false);
    expect(failText(result)).toContain("收集数不符");
    expect(failText(result)).toContain("collected=0");
    expect(result.line).toContain("collected=0");
  });

  it("场景③ 存在跳过：任一 spec skipped → fail", () => {
    const result = validateWritingE2EReport(
      report({ statuses: ["expected", "expected", "expected", "skipped"] }),
      "0",
    );
    expect(result.ok).toBe(false);
    expect(failText(result)).toContain("静默跳过");
    expect(result.line).toContain("skipped=1");
  });

  it("场景④ 用例失败：任一 spec 非 expected/skipped → fail（含 stats.unexpected 口径）", () => {
    const byStatus = validateWritingE2EReport(
      report({ statuses: ["expected", "expected", "expected", "unexpected"] }),
      "0",
    );
    expect(byStatus.ok).toBe(false);
    expect(failText(byStatus)).toContain("失败用例");

    const byStats = validateWritingE2EReport(report({ statuses: ["expected", "expected", "expected", "expected"], unexpected: 1 }), "0");
    expect(byStats.ok).toBe(false);
  });

  it("场景⑤ 四项通过但进程非零退出：PW_EXIT=1 → fail", () => {
    const result = validateWritingE2EReport(report(), "1");
    expect(result.ok).toBe(false);
    expect(failText(result)).toContain("PW_EXIT 非 0");
    expect(result.line).toContain("(pw_exit=1)");
  });

  it("场景⑥ 四项通过但存在全局错误：errors 非空 → fail（打印错误消息）", () => {
    const result = validateWritingE2EReport(
      report({ errors: [{ message: "http://127.0.0.1:3099/health is already used" }] }),
      "0",
    );
    expect(result.ok).toBe(false);
    expect(failText(result)).toContain("playwright 全局错误");
    expect(failText(result)).toContain("already used");
  });

  it("PW_EXIT 缺失 → fail；非法（非整数）→ fail", () => {
    const missing = validateWritingE2EReport(report(), undefined);
    expect(missing.ok).toBe(false);
    expect(failText(missing)).toContain("PW_EXIT 缺失");
    expect(missing.line).toContain("(pw_exit=<missing>)");

    const invalid = validateWritingE2EReport(report(), "abc");
    expect(invalid.ok).toBe(false);
    expect(failText(invalid)).toContain("PW_EXIT 非法");
  });

  it("CI 首跑实况复刻（collected=0 + 全局错误 + 非零退出）→ 三项分别命中", () => {
    const result = validateWritingE2EReport(
      report({
        statuses: [],
        errors: [{ message: "http://127.0.0.1:3099/health is already used, make sure that nothing is running on the port/url or set reuseExistingServer:true in config.webServer." }],
        unexpected: 0,
      }),
      "1",
    );
    expect(result.ok).toBe(false);
    const text = failText(result);
    expect(text).toContain("收集数不符");
    expect(text).toContain("playwright 全局错误");
    expect(text).toContain("PW_EXIT 非 0");
  });
});

describe("main（CLI 包装：文件读取 + 退出码）", () => {
  const dir = ".tmp";
  mkdirSync(dir, { recursive: true });

  it("合法报告 + PW_EXIT=0 → 退出码 0；PW_EXIT=1 → 退出码 1", () => {
    const path = `${dir}/writing-e2e-report-pass-${Date.now()}.json`;
    writeFileSync(path, JSON.stringify(report()), "utf8");
    expect(main(["node", "verify", path], { PW_EXIT: "0" })).toBe(0);
    expect(main(["node", "verify", path], { PW_EXIT: "1" })).toBe(1);
    expect(main(["node", "verify", path], {})).toBe(1);
  });

  it("报告不可读（文件缺失/损坏）→ 退出码 1", () => {
    expect(main(["node", "verify", `${dir}/definitely-missing-report.json`], { PW_EXIT: "0" })).toBe(1);

    const broken = `${dir}/writing-e2e-report-broken-${Date.now()}.json`;
    writeFileSync(broken, "{not json", "utf8");
    expect(main(["node", "verify", broken], { PW_EXIT: "0" })).toBe(1);
  });
});
