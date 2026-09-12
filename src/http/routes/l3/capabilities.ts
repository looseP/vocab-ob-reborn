/**
 * L3 能力发现路由（ADR-0029 §8② / T13c）。
 *
 * GET /capabilities：agent 的能力发现读面——可读面 / 可写面（仅 proposal）、
 * 升级动作不可用、预算上限、error code 词表。数字与词表全部引用单一真源
 * （schemas/resource-budget.ts / errors/codes.ts），本文件不复制任何字面值。
 *
 * 独立薄路由：l3/index.ts 受复杂度棘轮冻结（同 l3/lists.ts 先例），
 * 由 http/server.ts 直挂。
 */
import { Hono } from "hono";
import type { AppEnv } from "../words";
import { ERROR_CODES } from "@/errors/codes";
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
      access: { read: "all", write: "proposal_only", upgrade: "owner_only" },
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
