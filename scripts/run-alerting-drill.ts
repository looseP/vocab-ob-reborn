import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { open, unlink, type FileHandle } from "node:fs/promises";
import { isIP } from "node:net";
import { isAbsolute, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

type DrillPhase = "firing" | "notification_confirmed" | "resolved";

export interface DrillOptions {
  environment: string;
  confirmStaging: boolean;
  confirmReversible: boolean;
  dryRun: boolean;
  alertmanagerUrl?: string;
  receiptUrl?: string;
  allowedHosts: string[];
  timeoutMs: number;
  pollIntervalMs: number;
  lockFile?: string;
  requestId?: string;
  resolveHost?: (hostname: string) => Promise<Array<{ address: string }>>;
  releaseLock?: (path: string, handle: FileHandle) => Promise<void>;
}

interface Receipt {
  firingNotified?: boolean;
  resolvedNotified?: boolean;
}

export interface DrillEvidence {
  requestId: string;
  environment: "staging";
  mode: "dry-run" | "live";
  startedAt: string;
  completedAt: string;
  phases: Array<{ phase: DrillPhase; at: string; proven: boolean }>;
  deliveryProven: boolean;
  note?: string;
}

const forbiddenTarget = /production|prod(?:\.|-|$)/i;
const localHosts = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);

function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized.startsWith("::ffff:")) return isPrivateAddress(normalized.slice(7));
  if (isIP(normalized) === 4) {
    const [a, b] = normalized.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  return normalized === "::" || normalized === "::1" || normalized.startsWith("fc")
    || normalized.startsWith("fd") || /^fe[89ab]/.test(normalized);
}

async function assertPublicHost(url: URL, resolveHost?: DrillOptions["resolveHost"]): Promise<void> {
  const results = resolveHost ? await resolveHost(url.hostname) : await lookup(url.hostname, { all: true, verbatim: true });
  if (results.length === 0 || results.some(({ address }) => isPrivateAddress(address))) {
    throw new Error("目标 DNS 解析到禁止的私有/本机地址");
  }
}

async function safeFetch(input: URL, init: RequestInit, resolveHost?: DrillOptions["resolveHost"]): Promise<Response> {
  await assertPublicHost(input, resolveHost);
  return fetch(input, { ...init, redirect: "error" });
}

export function validateOptions(options: DrillOptions): void {
  if (options.environment !== "staging") {
    throw new Error("演练仅允许显式 environment=staging");
  }
  if (!options.confirmStaging || !options.confirmReversible) {
    throw new Error("必须同时提供 staging 与可逆演练双重确认");
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error("timeout 必须为正数");
  }
  if (!Number.isFinite(options.pollIntervalMs) || options.pollIntervalMs <= 0 || options.pollIntervalMs > options.timeoutMs) {
    throw new Error("poll interval 必须为正数且不大于 timeout");
  }
  if (options.dryRun) return;
  if (!options.alertmanagerUrl || !options.receiptUrl) {
    throw new Error("live 演练必须配置 Alertmanager 和通知回执 URL");
  }
  if (options.allowedHosts.length === 0) {
    throw new Error("live 演练必须配置非空目标 host allowlist");
  }
  if (!options.lockFile || !isAbsolute(options.lockFile)) {
    throw new Error("live 演练必须配置绝对 DRILL_LOCK_FILE");
  }
  const lockPath = resolve(options.lockFile);
  const tempPath = resolve(tmpdir());
  if (lockPath === tempPath || lockPath.startsWith(`${tempPath}\\`) || lockPath.startsWith(`${tempPath}/`)) {
    throw new Error("DRILL_LOCK_FILE 禁止使用临时目录");
  }
  for (const raw of [options.alertmanagerUrl, options.receiptUrl]) {
    if (forbiddenTarget.test(raw)) throw new Error("目标禁止包含 production/prod 标识");
    const url = new URL(raw);
    if (url.search || url.hash) throw new Error("目标 URL 禁止 query/hash");
    if (url.protocol !== "https:") throw new Error("live 目标必须使用 HTTPS");
    if (localHosts.has(url.hostname.toLowerCase())) throw new Error("live 目标禁止 localhost/回环地址");
    if (!options.allowedHosts.includes(url.hostname.toLowerCase())) {
      throw new Error(`目标 host 不在 allowlist: ${url.hostname}`);
    }
    if (url.username || url.password) throw new Error("URL 禁止嵌入凭据");
  }
  for (const host of options.allowedHosts) {
    if (forbiddenTarget.test(host) || localHosts.has(host.toLowerCase())) {
      throw new Error("allowlist 禁止 production/prod 或本机目标");
    }
  }
}

function syntheticAlert(requestId: string, firing: boolean) {
  const now = new Date();
  return [{
    labels: {
      alertname: "VocabStagingSyntheticDrill",
      service: "vocab_observatory",
      severity: "warning",
      environment: "staging",
      component: "alerting-drill",
      alert_family: "synthetic-drill",
      team: "vocab-observatory",
    },
    annotations: {
      summary: "Staging synthetic alert delivery drill",
      description: "Safe, reversible notification-path validation; no service disruption.",
      drill_request_id: requestId,
    },
    startsAt: now.toISOString(),
    endsAt: firing ? new Date(now.getTime() + 10 * 60 * 1000).toISOString() : now.toISOString(),
    generatorURL: "",
  }];
}

async function postAlert(url: string, requestId: string, firing: boolean, signal: AbortSignal, resolveHost?: DrillOptions["resolveHost"]): Promise<void> {
  const baseUrl = new URL(url);
  baseUrl.pathname = `${baseUrl.pathname.replace(/\/$/, "")}/`;
  const response = await safeFetch(new URL("api/v2/alerts", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json", "x-drill-request-id": requestId },
    body: JSON.stringify(syntheticAlert(requestId, firing)),
    signal,
  }, resolveHost);
  if (!response.ok) throw new Error(`Alertmanager 返回 HTTP ${response.status}`);
}

async function waitForReceipt(
  url: string,
  requestId: string,
  field: keyof Receipt,
  deadline: number,
  pollIntervalMs: number,
  signal: AbortSignal,
  resolveHost?: DrillOptions["resolveHost"],
): Promise<void> {
  while (Date.now() < deadline) {
    const endpoint = new URL(url);
    endpoint.searchParams.set("requestId", requestId);
    const response = await safeFetch(endpoint, { headers: { "x-drill-request-id": requestId }, signal }, resolveHost);
    if (response.ok) {
      const receipt = await response.json() as Receipt;
      if (receipt[field] === true) return;
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  throw new Error(`等待通知回执超时: ${field}`);
}

async function acquireLock(path: string): Promise<FileHandle> {
  try {
    const handle = await open(path, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`);
    return handle;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error("已有告警演练锁；残留锁仅允许人工确认无运行中演练后清除");
    }
    throw error;
  }
}

async function releaseLock(path: string, handle: FileHandle): Promise<void> {
  await handle.close();
  await unlink(path);
}

export async function runDrill(options: DrillOptions): Promise<DrillEvidence> {
  validateOptions(options);
  const requestId = options.requestId ?? randomUUID();
  if (!/^[a-zA-Z0-9-]{8,64}$/.test(requestId)) throw new Error("request id 格式无效");
  const startedAt = new Date().toISOString();
  const phases: DrillEvidence["phases"] = [];
  const mark = (phase: DrillPhase, proven: boolean) => phases.push({ phase, at: new Date().toISOString(), proven });

  if (options.dryRun) {
    mark("firing", false);
    mark("notification_confirmed", false);
    mark("resolved", false);
    return {
      requestId, environment: "staging", mode: "dry-run", startedAt,
      completedAt: new Date().toISOString(), phases, deliveryProven: false,
      note: "离线 dry-run 仅验证合同与安全门禁，不能证明告警通知实际送达。",
    };
  }

  const lockHandle = await acquireLock(options.lockFile!);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  const deadline = Date.now() + options.timeoutMs;
  let cleanupNeeded = false;
  try {
    cleanupNeeded = true;
    await postAlert(options.alertmanagerUrl!, requestId, true, controller.signal, options.resolveHost);
    mark("firing", true);
    await waitForReceipt(options.receiptUrl!, requestId, "firingNotified", deadline, options.pollIntervalMs, controller.signal, options.resolveHost);
    mark("notification_confirmed", true);
    await postAlert(options.alertmanagerUrl!, requestId, false, controller.signal, options.resolveHost);
    cleanupNeeded = false;
    await waitForReceipt(options.receiptUrl!, requestId, "resolvedNotified", deadline, options.pollIntervalMs, controller.signal, options.resolveHost);
    mark("resolved", true);
    return {
      requestId, environment: "staging", mode: "live", startedAt,
      completedAt: new Date().toISOString(), phases, deliveryProven: true,
    };
  } catch (error) {
    if (cleanupNeeded) {
      const cleanupController = new AbortController();
      const cleanupTimer = setTimeout(() => cleanupController.abort(), Math.min(5_000, options.timeoutMs));
      try {
        await postAlert(options.alertmanagerUrl!, requestId, false, cleanupController.signal, options.resolveHost);
      } catch {
        process.stderr.write(`${JSON.stringify({ status: "cleanup_failed", action: "resolve_alert" })}\n`);
      } finally {
        clearTimeout(cleanupTimer);
      }
    }
    throw error;
  } finally {
    clearTimeout(timer);
    try {
      await (options.releaseLock ?? releaseLock)(options.lockFile!, lockHandle);
    } catch {
      process.stderr.write(`${JSON.stringify({ status: "lock_release_failed", action: "manual_lock_review" })}\n`);
    }
  }
}

function parseArgs(argv: string[]): DrillOptions {
  const value = (name: string) => argv.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
  const dryRun = argv.includes("--dry-run");
  return {
    environment: value("--environment") ?? "",
    confirmStaging: argv.includes("--confirm-staging"),
    confirmReversible: argv.includes("--confirm-reversible"),
    dryRun,
    alertmanagerUrl: process.env.DRILL_ALERTMANAGER_URL,
    receiptUrl: process.env.DRILL_RECEIPT_URL,
    allowedHosts: (process.env.DRILL_ALLOWED_HOSTS ?? "").split(",").map((host) => host.trim().toLowerCase()).filter(Boolean),
    timeoutMs: Number(value("--timeout-ms") ?? "120000"),
    pollIntervalMs: Number(value("--poll-interval-ms") ?? "2000"),
    lockFile: process.env.DRILL_LOCK_FILE,
  };
}

async function main(): Promise<void> {
  const evidence = await runDrill(parseArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    const safeMessage = error instanceof Error ? error.message.replace(/https?:\/\/\S+/g, "[REDACTED_URL]") : "未知错误";
    process.stderr.write(`${JSON.stringify({ status: "failed", error: safeMessage })}\n`);
    process.exitCode = 1;
  });
}
