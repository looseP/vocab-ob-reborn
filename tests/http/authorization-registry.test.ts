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
  "submitL2TaskAnswer",
  "submitL2SelfAssessment",
  "undoL2Drill",
  // capture / imports
  "createCapture",
  "importVocabNotes",
  // L3 语料直写（权威数据）
  "createL3Source",
  "replaceL3SourceSpaces", // V0 子空间接通：来源能力域标签全量替换（语料元数据直写）
  "createL3SelectionCapture",
  "createL3Context",
  "createL3QuickContext",
  "createL3Occurrence",
  "createL3ContextLink",
  "deleteL3Occurrence",
  "deleteL3ContextLink",
  "deleteL3Source",
  "deleteL3Context",
  // 改卷（2026-09-26）仍 owner 直写：agent 只建卷，没有"改 active 卷"这件事（ADR-0037 补记一）。
  "updateL3Paper",
  "deleteL3Question",
  // ADR-0037 评审面：采纳/驳回。**全 owner-only** —— 采纳是唯一把 pending 变 active
  // 的动作（待录读面 listPendingL3Questions 是 GET，归 OWNER_READS）。
  "acceptL3Question",
  "rejectL3Question",
  "acceptL3QuestionsBatch",
  // 批次一：做题注记（原文分析）与规律标签字典——个人做题工作台数据，纯 owner。
  "createQuestionAnnotation",
  "patchQuestionAnnotation",
  "deleteQuestionAnnotation",
  "replaceAnnotationTags",
  // v2 §4.7：撤回通道（submitted→draft 重挂题纸）——owner 写端点。
  "withdrawQuestionAnnotation",
  // 批次三①：owner 处置通道（D18）——submitted→confirmed 确认（撤回改写走 withdraw）。
  "confirmL3QuestionAnnotation",
  // 批次二：题纸与作答历史（ADR-0034）——做题台面是私人数据，读也不开放给 agent。
  "openL3Sheet",
  "patchL3Sheet",
  "sealL3Sheet",
  "deleteL3Attempt",
  // L3 recommendation generate（消耗预算产出推荐集，非 proposal-only 写入）；
  // l3 imports 两个入口已按 2026-09-12 裁决归 agent（属提案包生产路径）。
  "generateL3Recommendations",
  // L3 practice / sessions
  "recordL3PracticeAttempt",
  "createL3Session",
  // 作文子空间 v1（W6）：写作任务/稿件 owner 写面（私人写作工作台；agent 开口仅
  // feedback-context 读 + feedback 写两处，见 agent 清单）。
  "createL3WritingTask",
  "patchL3WritingTask",
  "archiveL3WritingTask",
  "restoreL3WritingTask",
  "createL3WritingDraft",
  "saveL3WritingDraft",
  "submitL3WritingSheet",
  "discardL3WritingSheet",
  // 作文子空间 v1（W9）：正文清理（soft-delete attempt + 同事务删反馈；sealed 限定）。
  "clearL3WritingSheetContent",
  // 学习笔记（N1，ADR《study-notes-workspace》/ 设计 §7）：私人笔记工作台 owner 写面
  // ——全部新端点 owner-only（agent 一律 403；未认证 401；他人资源 404）。
  // previewL3ReferenceTarget 为 POST 只读（零写不持久化），但非 GET → 归写面分类。
  "createL3StudyNote",
  "saveL3StudyNote",
  "previewL3ReferenceTarget",
  "createL3StudyTopic",
  "saveL3StudyTopic",
  "moveL3StudyTopicMember",
  "removeL3StudyTopicMember",
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

  it("the only agent-writable /api/* writes are the proposal path + the assessment venue + grading + writing feedback + pending-only authoring（批次三① / W6 / ADR-0037）", () => {
    const agentWrites = idsWhere(
      (operation) => operation.path.startsWith("/api/") && operation.method !== "get" && operation.minRole === "agent",
    );
    // 提案路径 5（proposal 入口 2 + 载荷准备 1 + l3 imports 2——2026-09-12 裁决，T13a-fix）+
    // 评析区 1（putL3QuestionAssessment——增补批 ADR-0034 v2 条 10/11：agent 首个可写
    // 持久区，Amends ADR-0029，开口严格限于该区）+ 评卷提交 1（submitL3Grading——
    // 批次三① ADR-0035 §3：agent 写面第 2 开口，graded_by 服务端认定）+
    // 作文反馈 1（putL3WritingFeedback——W6《writing-workspace》§5：agent 写面第 3
    // 开口，只写指定已提交稿的 feedback，lastEditor 服务端认定）。
    expect(agentWrites).toEqual([
      "createL2ExternalPrompt",
      "createL3Paper",
      "createL3Proposal",
      "createL3Question",
      "createL3RawTextImport",
      "createL3StructuredImport",
      "proposeL2Candidate",
      "putL3QuestionAssessment",
      "putL3WritingFeedback",
      "submitL3Grading",
      // ADR-0037：录题写面第 4 组开口。**"可写"≠"可写 active"**：agent 产物一律落
      // status='pending'、created_by=agentId，由 owner 在待录面核对后采纳（错答案键
      // 一旦被作答即永久不可改，这是闸门的全部理由）。updateL3Paper 与
      // deleteL3Question 不在此列：前者只给 owner，后者是销毁（agent 只订正不销毁）。
      "updateL3Question",
    ]);
  });

  /**
   * ADR-0037 决策 3 的**语义**守卫：minRole 只回答"能不能进路由"，不回答"能写成什么"。
   * 录题面是唯一一组「agent 可写」的权威内容面，所以必须在这里钉死两条：
   *  1. 写面用 `sessionMutation` 口径（CSRF 对 session 路径生效，agent bearer 不受影响）；
   *  2. **状态闸门不靠注册表**——注册表表达不了 pending-only，靠 service 的
   *     `editableQuestionStatuses` + UPDATE 谓词（见 l3-paper.service 与 repository）。
   *     本断言的作用是：若哪天有人把闸门从 service 挪走，这三条 agent 写面会失去
   *     唯一的注册表侧标记，从而被后续改动误当"普通可写面"复制。
   */
  it("录题三面是 agent 可写的 pending-only 面，且删除/改卷仍 owner-only", () => {
    const authoringAgentWrites = ["createL3Paper", "createL3Question", "updateL3Question"];
    for (const operationId of authoringAgentWrites) {
      const operation = byId.get(operationId);
      expect(operation, operationId).toBeDefined();
      expect(operation?.minRole, operationId).toBe("agent");
      // 鉴权口径是 session（浏览器路径仍受 CSRF 保护）
      expect(operation?.auth, operationId).toBe("owner");
    }
    // 销毁与改卷不是 agent 面
    expect(byId.get("deleteL3Question")?.minRole).toBe("owner");
    expect(byId.get("updateL3Paper")?.minRole).toBe("owner");
    // 评审面（采纳/驳回/待录读面）不是 agent 面
    expect(byId.get("acceptL3Question")?.minRole).toBe("owner");
    expect(byId.get("acceptL3QuestionsBatch")?.minRole).toBe("owner");
    expect(byId.get("rejectL3Question")?.minRole).toBe("owner");
    expect(byId.get("listPendingL3Questions")?.minRole).toBe("owner");
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
  "listL3Occurrences", "listL3ContextLinks", "getL3Capabilities", "getL3SpaceSummary",
  "listL3Recommendations", "getL3Recommendation", "listL3Proposals", "getL3Proposal",
  // ADR-0030：题/卷/做题文件读面对 agent 开放（拆卷评卷取料；写入仍 owner-only）。
  "listL3Papers", "getL3Paper", "listL3PracticeFiles", "getL3PracticeFile",
  "listUpgradeWorkOrders", "listL3PracticeAttempts", "listL3PracticeErrorBook", "listL3ErrorBook", "getL3Session",
  "previewForgetting",
  // 增补批：评析区读面（agent 共建工作流需要读既有评析；写入同一端点双身份）。
  "getL3QuestionAssessment",
  // 批次三①：评卷上下文读面（agent 面；🔴 含 answerIndex 的 D8 唯一例外，仅 sealed）。
  "getL3GradingContext",
  // ADR-0038 决策 2：待评卷清单（agent 可读**发现面**）。只给身份与计数、不含题面；
  // 此前 agent 无法自行发现待评卷题纸（档案面 owner-only、error-book 只列已评判错）。
  "listPendingL3Grading",
  // 作文子空间 v1（W6）：agent 读面第 3 开口——只读指定 sealed 稿的评阅上下文
  // （feedback-context；draft 409、正文已清理 409、零写入）。
  "getL3WritingFeedbackContext",
] as const;

const OWNER_READS = [
  "getOperationMetrics", // F2：运营指标可能含敏感计数，保持 owner
  "getAuthSession", // /api/auth 豁免组内的 auth 态探针（非语料读面）
  // 批次一：做题注记与个人标签字典是做题台面私人数据，不对 agent 开放。
  "listQuestionAnnotations",
  // ADR-0037：待录核对面带**答案键**，是 owner 的核对责任面，不对 agent 开放。
  "listPendingL3Questions",
  "getAnnotationTags",
  // 批次二（ADR-0034）：题纸与作答历史——owner-only 读（个人做题台面）。
  "getL3Sheet",
  "listL3Attempts",
  "exportL3Sheet",
  // F-1 回看闭环：题纸档案列表（同上 owner-only 口径；sheetId 深链入口数据源）。
  "listL3Sheets",
  // 批次三①：解析模式读面（verdict/analysis 前端数据源；不含 answerIndex，agent 面
  // 已由 grading-context 覆盖，此处保持做题台面 owner-only 口径）。
  "getL3GradingResults",
  // 作文子空间 v1（W6）：写作台面 owner-only 读（任务列表/详情/稿次历史/稿详情/
  // 反馈读取；agent 面仅 feedback-context 一处，正文与草稿不对 agent 开放）。
  "listL3WritingTasks",
  "getL3WritingTask",
  "listL3WritingRevisions",
  "getL3WritingSheet",
  "getL3WritingFeedback",
  // 作文子空间 v1（W9）：单稿导出（owner-only；agent 无导出权限）。
  "exportL3WritingSheet",
  // A2（2026-09-19）：按题批量进度读面（owner-only；agent 无权限，零写、零创建）。
  "listL3WritingQuestionSummaries",
  // 学习笔记（N1）：笔记空间为私人数据——读面同样 owner-only（agent 无权限；
  // 引用目标搜索/反向引用亦不例外；全部 GET 零写）。
  "listL3StudyNotes",
  "getL3StudyNote",
  "searchL3ReferenceTargets",
  "listL3StudyBacklinks",
  "listL3StudyTopics",
  // N1/Task 10：笔记导出（owner-only；agent 无导出权限，与 exportL3Sheet /
  // exportL3WritingSheet 同口径——私人笔记档案不对 agent 开放）。
  "exportL3StudyNote",
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
