/**
 * L3 提案域路由：proposal CRUD + validate/confirm/reject 升级路径。
 * 自 2026-09-08 起 l3.ts 按资源域拆分（499/500 复杂度门禁触顶），路径与语义不变。
 */
import { Hono } from "hono";
import type { Services } from "@/services";
import type { AppEnv } from "../words";
import {
  l3ProposalCreateSchema,
  l3ProposalListQuerySchema,
  l3ProposalRejectSchema,
} from "@/schemas/http";
import { validationError } from "../../error-response";
import { asJson } from "./shared";

export function proposalsRoutes(services: Services) {
  const app = new Hono<AppEnv>();

  app.post("/proposals", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = l3ProposalCreateSchema.safeParse(body);
    if (!parsed.success) {
      return validationError(c, parsed.error.flatten());
    }
    const result = await services.l3Proposal.createProposal({
      userId: c.get("userId"),
      ...parsed.data,
      wordbookId: parsed.data.wordbookId ?? null,
      title: parsed.data.title ?? null,
      summary: parsed.data.summary ?? null,
      inputHash: parsed.data.inputHash ?? null,
      proposedBy: parsed.data.proposedBy ?? null,
      provenance: asJson(parsed.data.provenance ?? {}),
      items: parsed.data.items.map((item) => ({
        itemType: item.itemType,
        clientRef: item.clientRef ?? null,
        payload: asJson(item.payload),
      })),
    });
    return c.json(result, 201);
  });

  app.get("/proposals", async (c) => {
    const parsed = l3ProposalListQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return validationError(c, parsed.error.flatten());
    }
    const result = await services.l3Proposal.listProposals({
      userId: c.get("userId"),
      status: parsed.data.status,
      limit: parsed.data.limit,
      cursor: parsed.data.cursor ?? null,
    });
    return c.json(result);
  });

  app.get("/proposals/:id", async (c) => {
    const result = await services.l3Proposal.getProposal({
      userId: c.get("userId"),
      proposalId: c.req.param("id"),
    });
    return c.json(result);
  });

  app.post("/proposals/:id/validate", async (c) => {
    const result = await services.l3Proposal.validateProposal({
      userId: c.get("userId"),
      proposalId: c.req.param("id"),
    });
    return c.json(result);
  });

  app.post("/proposals/:id/confirm", async (c) => {
    const result = await services.l3Proposal.confirmProposal({
      userId: c.get("userId"),
      proposalId: c.req.param("id"),
    });
    return c.json(result);
  });

  app.post("/proposals/:id/reject", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = l3ProposalRejectSchema.safeParse(body);
    if (!parsed.success) {
      return validationError(c, parsed.error.flatten());
    }
    const result = await services.l3Proposal.rejectProposal({
      userId: c.get("userId"),
      proposalId: c.req.param("id"),
      reviewNote: parsed.data.reviewNote ?? null,
    });
    return c.json(result);
  });

  return app;
}
