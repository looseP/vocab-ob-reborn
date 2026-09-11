/**
 * 授权注册表契约（T13a §A3 / §D5 / §D6 / §F1）。
 *
 * - §A3：`auth`（OpenAPI security 描述）与 `minRole`（运行时执行真源）的一致性。
 * - §A2：两个字段各自只有一个消费者——`openapi.ts` 只读 `auth`，运行时中间件只读 `minRole`。
 * - §D5：升级动作全量清单，逐条钉 owner-only。
 * - §D6「守卫的守卫」：owner-only 写端点必须全部显式登记；新增写端点会让本测试失败。
 * - §F1：全部 GET 端点的 agent-readable / owner-only 分类固化（P2 报告为人类可读版）。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { apiOperations } from "@/http/operations";

const apiOps = apiOperations.filter((operation) => operation.path.startsWith("/api/"));
const byId = new Map(apiOps.map((operation) => [operation.operationId, operation]));
const sorted = (values: Iterable<string>): string[] => [...values].sort();

function idsWhere(predicate: (operation: (typeof apiOperations)[number]) => boolean): string[] {
  return sorted(apiOps.filter(predicate).map((operation) => operation.operationId));
}

// ── §A3 auth ↔ minRole ─────────────────────────────────────────────────────
//
// 任务给的映射里 `auth:"public" ⟺ minRole:"public"` 与
// `auth:"optionalSession" ⟹ minRole:"public"` 在字面上互斥：若严格双向，
// optionalSession 端点会同时要求 minRole 为 public 且 auth 为 public。
// 唯一存在 optionalSession 端点（DELETE /api/auth/session，匿名登出必须放行）
// 使严格双向不可满足，故取最强可满足形式：
//   auth public ⟹ minRole public；minRole public ⟹ auth ∈ {public, optionalSession}。
describe("auth ↔ minRole registry consistency (A3)", () => {
  it("auth:public never demands a higher role than public", () => {
    for (const operation of apiOperations) {
      if (operation.auth !== "public") continue;
      expect(operation.minRole, operation.operationId).toBe("public");
    }
  });

  it("minRole:public is only used by anonymous-tolerant auth policies", () => {
    for (const operation of apiOperations) {
      if (operation.minRole !== "public") continue;
      expect(["public", "optionalSession"]).toContain(operation.auth);
    }
  });

  it("auth:owner implies an authenticated minRole (agent or owner)", () => {
    for (const operation of apiOperations) {
      if (operation.auth !== "owner") continue;
      expect(["agent", "owner"], operation.operationId).toContain(operation.minRole);
    }
  });

  it("auth:optionalSession implies minRole:public", () => {
    for (const operation of apiOperations) {
      if (operation.auth !== "optionalSession") continue;
      expect(operation.minRole, operation.operationId).toBe("public");
    }
  });

  it("auth:metrics stays outside /api/* (its own bearer, not this lookup table)", () => {
    const metrics = apiOperations.filter((operation) => operation.auth === "metrics");
    expect(metrics.length).toBeGreaterThan(0);
    for (const operation of metrics) {
      expect(operation.path.startsWith("/api/"), operation.path).toBe(false);
    }
  });
});

// ── §A2 one consumer per field ─────────────────────────────────────────────
describe("auth/minRole have exactly one consumer each (A2)", () => {
  const read = (relativePath: string): string =>
    readFileSync(fileURLToPath(new URL(`../../${relativePath}`, import.meta.url)), "utf8");

  it("openapi.ts consumes auth and never minRole", () => {
    expect(read("src/http/openapi.ts")).not.toMatch(/\.minRole\b/);
  });

  it("runtime authorization never reads the OpenAPI auth policy", () => {
    for (const file of ["src/http/middleware/auth.ts", "src/http/middleware/api-authorization.ts"]) {
      expect(read(file), file).not.toMatch(/\.auth\b/);
    }
  });
});

// ── §D5 升级动作全量清单 ────────────────────────────────────────────────────
const D5_UPGRADE_ACTIONS = [
  // L2 confirm
  "confirmL2Draft",
  // L2 candidates accept/reject
  "acceptL2Candidate",
  "rejectL2Candidate",
  // L3 proposal validate/confirm/reject
  "validateL3Proposal",
  "confirmL3Proposal",
  "rejectL3Proposal",
  // L3 recommendation accept/reject
  "acceptL3Recommendation",
  "rejectL3Recommendation",
  // forgetting apply/restore
  "applyForgetting",
  "restoreForgetting",
  // l3-sessions end
  "endL3Session",
  // upgrade-work-orders 全部写
  "markUpgradeWorkOrder",
  "startUpgradeWorkOrder",
  "cancelUpgradeWorkOrder",
  "completeUpgradeWorkOrder",
  // l2-rows deactivate/delete/hide/restore
  "deactivateL2ContentRow",
  "deleteL2ContentRow",
  "hideL2ContentRowItem",
  "restoreL2ContentRowItem",
] as const;

// D5 四条 l2-rows 动词未单列、但同属"不可逆权威内容变更"的保护意图。
const ADDITIONAL_DESTRUCTIVE_OWNER_WRITES = [
  "removeL2ContentRowItem", // l2-rows 条目的硬删（与 delete 同族）
  "deleteStubWord", // 词条硬删
  "promoteL2", // 直接晋升为权威 L2 内容
] as const;

// 其余 owner-only 写：个人进度 / 语料直写 / 预算动作 / 非 proposal-only 的组装与导入。
const OTHER_OWNER_WRITES = [
  // words / notes
  "batchCreateWords",
  "createWordNoteEntry",
  "updateWordNoteEntry",
  "deleteWordNoteEntry",
  "hideWordNoteEntry",
  "restoreWordNoteEntry",
  // review（个人复习进度）
  "submitReviewAnswer",
  "skipReview",
  "suspendReview",
  "undoReview",
  "clearL1WeakSignal",
  "enqueueReviewCard",
  "enqueueReviewCardsBatch",
  // L2 组装 / 导入 / 练习
  "createL2Draft",
  "createL2ExternalPrompt",
  "submitL2TaskAnswer",
  "submitL2SelfAssessment",
  "undoL2Drill",
  // capture / imports
  "createCapture",
  "importVocabNotes",
  // L3 语料直写（权威数据）
  "createL3Source",
  "createL3SelectionCapture",
  "createL3Context",
  "createL3QuickContext",
  "createL3Occurrence",
  "createL3ContextLink",
  "deleteL3Occurrence",
  "deleteL3ContextLink",
  "deleteL3Source",
  "deleteL3Context",
  // L3 import / recommendation generate（非 proposal-only 写入）
  "createL3RawTextImport",
  "createL3StructuredImport",
  "generateL3Recommendations",
  // L3 practice / sessions
  "recordL3PracticeAttempt",
  "createL3Session",
] as const;

const OWNER_WRITE_OPERATION_IDS = sorted([
  ...D5_UPGRADE_ACTIONS,
  ...ADDITIONAL_DESTRUCTIVE_OWNER_WRITES,
  ...OTHER_OWNER_WRITES,
]);

describe("owner-only write inventory (D5 + D6 guard)", () => {
  const registryOwnerWrites = idsWhere(
    (operation) => operation.path.startsWith("/api/") && operation.method !== "get" && operation.minRole === "owner",
  );

  it("every declared upgrade action is owner-only", () => {
    for (const operationId of D5_UPGRADE_ACTIONS) {
      const operation = byId.get(operationId);
      expect(operation, operationId).toBeDefined();
      expect(operation?.minRole, operationId).toBe("owner");
    }
  });

  it("the registry owner-write set equals the explicitly enumerated inventory", () => {
    // D6 守卫的守卫：新增任何 owner-only 写端点都会让这里失败，逼迫作者显式分类
    // （升级动作 → D5 列表；否则 → 带理由地登记进 OTHER/加法清单），清单不会静默过期。
    expect(registryOwnerWrites).toEqual(OWNER_WRITE_OPERATION_IDS);
  });

  it("the only agent-writable /api/* writes are the two proposal entry points", () => {
    const agentWrites = idsWhere(
      (operation) => operation.path.startsWith("/api/") && operation.method !== "get" && operation.minRole === "agent",
    );
    expect(agentWrites).toEqual(["createL3Proposal", "proposeL2Candidate"]);
  });
});

// ── §F1 GET classification ─────────────────────────────────────────────────
const AGENT_READS = [
  // corpus / reference reads
  "listWords", "suggestWords", "getWord", "getWordNoteEntries",
  "getPlazaOverview", "getPlazaCollection", "getPlazaRootsOverview", "getPlazaRootCollection", "getPlazaReviewStats",
  "listNotes", "listWordbooks", "getOrCreateDefaultWordbook",
  "getReviewQueue", "getReviewStats", "getReviewDashboardStats", "listReviewLeeches", "listReviewTimeline", "getReviewHeatmap", "getReviewDrillQueue",
  "getL2LlmStatus", "listL2Candidates", "listL2ContentRows", "getL2DrillQueue",
  "getL3Context", "getL3WordSpace", "listL3Sources", "getL3SourceSpace", "getL3Graph", "listL3WordContexts", "listL3SourceContexts",
  "listL3Recommendations", "getL3Recommendation", "listL3Proposals", "getL3Proposal",
  "listUpgradeWorkOrders", "listL3PracticeAttempts", "listL3PracticeErrorBook", "getL3Session",
  "previewForgetting",
] as const;

const OWNER_READS = [
  "getOperationMetrics", // F2：运营指标可能含敏感计数，保持 owner
  "getAuthSession", // /api/auth 豁免组内的 auth 态探针（非语料读面）
] as const;

describe("GET endpoint classification (F1)", () => {
  it("classifies every /api/* GET as agent-readable or owner-only with no gaps", () => {
    const registryGets = idsWhere((operation) => operation.path.startsWith("/api/") && operation.method === "get");
    expect(registryGets).toEqual(sorted([...AGENT_READS, ...OWNER_READS]));
  });

  it("minRole matches each GET classification", () => {
    for (const operationId of AGENT_READS) {
      expect(byId.get(operationId)?.minRole, operationId).toBe("agent");
    }
    for (const operationId of OWNER_READS) {
      expect(byId.get(operationId)?.minRole, operationId).toBe("owner");
    }
  });
});
