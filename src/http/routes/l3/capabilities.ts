/**
 * L3 能力发现薄路由（ADR-0029 §8）：可读面 / proposal 写面 / 预算上限 / error code 词表。
 * 数字与词表全部引用单一真源（resource-budget.ts / errors/codes.ts / domain/l3-authoring.ts），
 * 本文件不复制任何字面值。独立薄路由：l3/index.ts 受棘轮冻结（l3/lists.ts 先例），直挂 server.ts。
 */
import { Hono } from "hono";
import type { AppEnv } from "../words";
import { ERROR_CODES } from "@/errors/codes";
import { L3_GRADING_AUTHORIZATION } from "@/domain/l3-sheets";
import { L3_AUTHORING_CAPABILITIES } from "@/domain/l3-authoring";
import {
  API_JSON_BODY_MAX_BYTES,
  JSON_MAX_DEPTH,
  JSON_RECORD_MAX_BYTES,
  L3_PROPOSAL_MAX_ITEMS,
  L3_PROPOSAL_PAYLOAD_MAX_BYTES,
  L3_PROPOSAL_TOTAL_PAYLOAD_MAX_BYTES,
} from "@/schemas/resource-budget";

export function l3CapabilitiesRoutes() {
  const app = new Hono<AppEnv>();

  app.get("/capabilities", (c) => {
    return c.json({
      role: c.get("role"),
      // access 保持原样：录题不是 proposal，口径单列 authoring（ADR-0037 决策 8）。
      access: { read: "all", write: "proposal_only", upgrade: "owner_only" },
      authoring: L3_AUTHORING_CAPABILITIES,
      grading: L3_GRADING_AUTHORIZATION,
      limits: {
        apiJsonBodyMaxBytes: API_JSON_BODY_MAX_BYTES,
        jsonRecordMaxBytes: JSON_RECORD_MAX_BYTES,
        jsonMaxDepth: JSON_MAX_DEPTH,
        proposalMaxItems: L3_PROPOSAL_MAX_ITEMS,
        proposalPayloadMaxBytes: L3_PROPOSAL_PAYLOAD_MAX_BYTES,
        proposalTotalPayloadMaxBytes: L3_PROPOSAL_TOTAL_PAYLOAD_MAX_BYTES,
      },
      errorCodes: Object.values(ERROR_CODES),
    });
  });

  return app;
}
