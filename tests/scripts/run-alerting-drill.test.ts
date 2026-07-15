import { randomUUID } from "node:crypto";
import { rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runDrill, validateOptions, type DrillOptions } from "../../scripts/run-alerting-drill";

const lockFile = resolve(import.meta.dirname, `.alerting-drill-test-${process.pid}.lock`);

const releaseLock: NonNullable<DrillOptions["releaseLock"]> = async (_path, handle) => {
  await handle.truncate(0);
  await handle.close();
};

const base: DrillOptions = {
  environment: "staging",
  confirmStaging: true,
  confirmReversible: true,
  dryRun: false,
  alertmanagerUrl: "https://alerts.staging.example.test/",
  receiptUrl: "https://receipts.staging.example.test/drills",
  allowedHosts: ["alerts.staging.example.test", "receipts.staging.example.test"],
  timeoutMs: 1_000,
  pollIntervalMs: 1,
  lockFile,
  requestId: "drill-12345678",
  resolveHost: async () => [{ address: "203.0.113.10" }],
  releaseLock,
};

afterEach(async () => {
  vi.unstubAllGlobals();
  try {
    await rename(lockFile, `${lockFile}.${randomUUID()}.released`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
});

describe("alerting drill safety gates", () => {
  it.each([
    [{ ...base, environment: "dev" }, "environment=staging"],
    [{ ...base, confirmStaging: false }, "双重确认"],
    [{ ...base, confirmReversible: false }, "双重确认"],
    [{ ...base, alertmanagerUrl: "http://alerts.staging.example.test" }, "HTTPS"],
    [{ ...base, alertmanagerUrl: "https://localhost:9093" }, "localhost"],
    [{ ...base, alertmanagerUrl: "https://alerts.production.example.test" }, "production"],
    [{ ...base, alertmanagerUrl: "https://other.staging.example.test" }, "allowlist"],
    [{ ...base, alertmanagerUrl: "https://token:secret@alerts.staging.example.test" }, "凭据"],
    [{ ...base, pollIntervalMs: 0 }, "poll interval"],
    [{ ...base, pollIntervalMs: -1 }, "poll interval"],
    [{ ...base, pollIntervalMs: 1_001 }, "poll interval"],
    [{ ...base, alertmanagerUrl: "https://alerts.staging.example.test/?tenant=x" }, "query/hash"],
    [{ ...base, alertmanagerUrl: "https://alerts.staging.example.test/#fragment" }, "query/hash"],
    [{ ...base, lockFile: "relative.lock" }, "绝对 DRILL_LOCK_FILE"],
    [{ ...base, lockFile: resolve(tmpdir(), "drill.lock") }, "临时目录"],
  ] satisfies Array<[DrillOptions, string]>)("拒绝不安全配置 %#", (options, message) => {
    expect(() => validateOptions(options)).toThrow(message);
  });

  it("允许完全离线 dry-run，且明确不证明送达", async () => {
    const evidence = await runDrill({
      ...base,
      dryRun: true,
      alertmanagerUrl: undefined,
      receiptUrl: undefined,
      allowedHosts: [],
    });
    expect(evidence.deliveryProven).toBe(false);
    expect(evidence.note).toContain("不能证明");
    expect(evidence.phases.map((item) => item.phase)).toEqual(["firing", "notification_confirmed", "resolved"]);
    expect(evidence.phases.every((item) => !item.proven)).toBe(true);
  });

  it.each(["127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.1.1", "169.254.1.1", "100.64.0.1", "fc00::1", "fe80::1", "::ffff:10.0.0.1"])("拒绝 DNS 解析到私网地址 %s", async (address) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(runDrill({ ...base, resolveHost: async () => [{ address }] })).rejects.toThrow("私有/本机地址");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("所有请求显式拒绝重定向", async () => {
    const redirects: Array<RequestRedirect | undefined> = [];
    let receiptCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
      redirects.push(init?.redirect);
      if (String(input).includes("api/v2/alerts")) return new Response(null, { status: 200 });
      receiptCalls += 1;
      return Response.json(receiptCalls === 1 ? { firingNotified: true } : { resolvedNotified: true });
    }));
    await runDrill(base);
    expect(redirects.length).toBeGreaterThanOrEqual(4);
    expect(redirects.every((value) => value === "error")).toBe(true);
  });

  it("锁冲突时零请求且不覆盖残留锁", async () => {
    await writeFile(lockFile, "existing-lock", { flag: "wx" });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(runDrill(base)).rejects.toThrow("已有告警演练锁");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("ambiguous firing POST 错误仍尝试 cleanup 并释放锁", async () => {
    let releaseCalls = 0;
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error("ambiguous firing failure");
      return new Response(null, { status: 200 });
    }));
    await expect(runDrill({
      ...base,
      releaseLock: async (path, handle) => {
        releaseCalls += 1;
        await releaseLock(path, handle);
      },
    })).rejects.toThrow("ambiguous firing failure");
    expect(calls).toBe(2);
    expect(releaseCalls).toBe(1);
  });

  it("回执失败后仍以独立 signal 尝试 resolved", async () => {
    const posts: Array<{ endsAt: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
      if (String(input).includes("api/v2/alerts")) {
        const body = JSON.parse(String(init?.body)) as Array<{ endsAt: string }>;
        posts.push(body[0]);
        return new Response(null, { status: 200 });
      }
      throw new Error("receipt unavailable");
    }));

    await expect(runDrill(base)).rejects.toThrow("receipt unavailable");
    expect(posts).toHaveLength(2);
    expect(Date.parse(posts[0].endsAt)).toBeGreaterThan(Date.parse(posts[1].endsAt));
  });

  it("cleanup 失败不掩盖原始回执错误", async () => {
    let alertPosts = 0;
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
      if (String(input).includes("api/v2/alerts")) {
        alertPosts += 1;
        if (alertPosts === 2) throw new Error("cleanup secret https://hidden.example");
        return new Response(null, { status: 200 });
      }
      throw new Error("original receipt failure");
    }));

    await expect(runDrill(base)).rejects.toThrow("original receipt failure");
    expect(alertPosts).toBe(2);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("cleanup_failed"));
    const stderrOutput = stderr.mock.calls.flat().join(" ");
    expect(stderrOutput).not.toContain("cleanup secret");
    expect(stderrOutput).not.toContain("hidden.example");
    expect(stderrOutput).not.toContain(String(base.requestId));
    expect(stderrOutput).not.toContain("token");
    stderr.mockRestore();
  });

  it("验证 firing、通知回执和 resolved 完整闭环", async () => {
    const posts: Array<{ endsAt: string; requestId: string | null; labels: Record<string, string>; annotations: Record<string, string> }> = [];
    let receiptCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("api/v2/alerts")) {
        const body = JSON.parse(String(init?.body)) as Array<{ endsAt: string; labels: Record<string, string>; annotations: Record<string, string> }>;
        posts.push({ ...body[0], requestId: new Headers(init?.headers).get("x-drill-request-id") });
        return new Response(null, { status: 200 });
      }
      receiptCalls += 1;
      return Response.json(receiptCalls === 1
        ? { firingNotified: true, resolvedNotified: false }
        : { firingNotified: true, resolvedNotified: true });
    }));

    const evidence = await runDrill(base);
    expect(evidence.deliveryProven).toBe(true);
    expect(evidence.phases.map((item) => item.phase)).toEqual(["firing", "notification_confirmed", "resolved"]);
    expect(posts).toHaveLength(2);
    expect(posts.every((post) => post.requestId === base.requestId)).toBe(true);
    expect(posts.every((post) => !("drill_request_id" in post.labels))).toBe(true);
    expect(posts.every((post) => post.labels.component === "alerting-drill")).toBe(true);
    expect(posts.every((post) => post.labels.alert_family === "synthetic-drill")).toBe(true);
    expect(posts.every((post) => post.labels.team === "vocab-observatory")).toBe(true);
    expect(posts.every((post) => Object.values(post.labels).every((value) => value !== base.requestId))).toBe(true);
    expect(posts.every((post) => post.annotations.drill_request_id === base.requestId)).toBe(true);
    expect(Date.parse(posts[0].endsAt)).toBeGreaterThan(Date.parse(posts[1].endsAt));
    expect(JSON.stringify(evidence)).not.toContain("token");
  });
});
