import { describe, it, expect, vi } from "vitest";
import type { UpgradeWorkOrderRow } from "@/domain";

vi.mock("@/db/transaction", () => ({
  withTransaction: vi.fn(async (cb: any) => cb({})),
}));

import { UpgradeWorkOrderRepository } from "@/repositories/upgrade-work-order.repository";

function workOrder(overrides: Partial<UpgradeWorkOrderRow> = {}): UpgradeWorkOrderRow {
  return {
    id: "wo-1",
    user_id: "u-1",
    word_id: "w-1",
    wordbook_id: "wb-1",
    direction: "通用",
    status: "标记中",
    suggestion_snapshot: null,
    created_at: "2026-09-10T00:00:00.000Z",
    updated_at: "2026-09-10T00:00:00.000Z",
    completed_at: null,
    ...overrides,
  };
}

describe("UpgradeWorkOrderRepository", () => {
  it("insert writes the ADR-0018 work order and returns the row", async () => {
    const repo = new UpgradeWorkOrderRepository();
    vi.spyOn(repo as any, "queryOne").mockResolvedValue(workOrder());

    const snapshot = { level: "strong", capturedAt: "2026-09-10T00:00:00.000Z" };
    const result = await repo.insert({
      user_id: "u-1",
      word_id: "w-1",
      wordbook_id: "wb-1",
      direction: "考研",
      suggestion_snapshot: snapshot,
    });

    expect(result.id).toBe("wo-1");
    const [sql, params] = (repo as any).queryOne.mock.calls[0];
    expect(sql).toContain("INSERT INTO upgrade_work_orders");
    expect(sql).toContain("(user_id, word_id, wordbook_id, direction, status, suggestion_snapshot)");
    expect(sql).toContain("VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::jsonb)");
    expect(params).toEqual([
      "u-1",
      "w-1",
      "wb-1",
      "考研",
      "标记中",
      JSON.stringify(snapshot),
    ]);
  });

  it("insert defaults status to 标记中 and snapshot to NULL when omitted", async () => {
    const repo = new UpgradeWorkOrderRepository();
    vi.spyOn(repo as any, "queryOne").mockResolvedValue(workOrder());

    await repo.insert({
      user_id: "u-1",
      word_id: "w-1",
      wordbook_id: "wb-1",
      direction: "通用",
    });

    const [, params] = (repo as any).queryOne.mock.calls[0];
    expect(params[4]).toBe("标记中");
    expect(params[5]).toBeNull();
  });

  it("insert fails closed when the database returns no row", async () => {
    const repo = new UpgradeWorkOrderRepository();
    vi.spyOn(repo as any, "queryOne").mockResolvedValue(null);

    await expect(repo.insert({
      user_id: "u-1",
      word_id: "w-1",
      wordbook_id: "wb-1",
      direction: "通用",
    })).rejects.toThrow("Upgrade work order insert returned no row");
  });

  it("updateSuggestion rewrites direction + suggestion_snapshot scoped to the owner", async () => {
    const repo = new UpgradeWorkOrderRepository();
    const spy = vi.spyOn(repo as any, "queryOne").mockResolvedValue(workOrder({ direction: "雅思" }));

    const snapshot = { level: "normal" };
    const result = await repo.updateSuggestion("u-1", "wo-1", "雅思", snapshot as any);

    expect(result?.direction).toBe("雅思");
    const [sql, params] = spy.mock.calls[0];
    expect(sql).toContain("UPDATE upgrade_work_orders");
    expect(sql).toContain("direction = $3");
    expect(sql).toContain("suggestion_snapshot = $4::jsonb");
    expect(sql).toContain("WHERE id = $2::uuid AND user_id = $1::uuid");
    expect(params).toEqual(["u-1", "wo-1", "雅思", JSON.stringify(snapshot)]);
  });

  it("updateSuggestion returns null when no row matches", async () => {
    const repo = new UpgradeWorkOrderRepository();
    vi.spyOn(repo as any, "queryOne").mockResolvedValue(null);

    await expect(repo.updateSuggestion("u-1", "missing", "通用", {} as any)).resolves.toBeNull();
  });

  it("findActiveByScope selects only the two active statuses, newest first", async () => {
    const repo = new UpgradeWorkOrderRepository();
    const spy = vi.spyOn(repo as any, "queryOne").mockResolvedValue(workOrder());

    await repo.findActiveByScope("u-1", "wb-1", "w-1");

    const [sql, params] = spy.mock.calls[0];
    expect(sql).toContain("FROM upgrade_work_orders");
    expect(sql).toContain("user_id = $1::uuid");
    expect(sql).toContain("wordbook_id = $2::uuid");
    expect(sql).toContain("word_id = $3::uuid");
    expect(sql).toContain("status = ANY($4::text[])");
    expect(sql).toContain("ORDER BY created_at DESC, id");
    expect(sql).toContain("LIMIT 1");
    expect(params).toEqual(["u-1", "wb-1", "w-1", ["标记中", "升级中"]]);
  });

  it("findActiveByScope returns null when there is no active order", async () => {
    const repo = new UpgradeWorkOrderRepository();
    vi.spyOn(repo as any, "queryOne").mockResolvedValue(null);

    await expect(repo.findActiveByScope("u-1", "wb-1", "w-1")).resolves.toBeNull();
  });

  it("findByIdForUser scopes the read by owner", async () => {
    const repo = new UpgradeWorkOrderRepository();
    const spy = vi.spyOn(repo as any, "queryOne").mockResolvedValue(workOrder());

    await repo.findByIdForUser("u-1", "wo-1");

    const [sql, params] = spy.mock.calls[0];
    expect(sql).toContain("WHERE id = $2::uuid AND user_id = $1::uuid");
    expect(params).toEqual(["u-1", "wo-1"]);
  });

  it("findByIdForUser returns null for an unknown id", async () => {
    const repo = new UpgradeWorkOrderRepository();
    vi.spyOn(repo as any, "queryOne").mockResolvedValue(null);

    await expect(repo.findByIdForUser("u-1", "missing")).resolves.toBeNull();
  });

  it("listPending returns active rows with the joined word surface and a bounded limit", async () => {
    const repo = new UpgradeWorkOrderRepository();
    const spy = vi.spyOn(repo as any, "query").mockResolvedValue([workOrder(), workOrder({ id: "wo-2" })]);

    const rows = await repo.listPending("u-1", "wb-1", 25);

    expect(rows).toHaveLength(2);
    const [sql, params] = spy.mock.calls[0];
    expect(sql).toContain("FROM upgrade_work_orders o");
    // LEFT JOIN words 取词面（slug/title）——工单行本身不含词面。
    expect(sql).toContain("LEFT JOIN words w ON w.id = o.word_id");
    expect(sql).toContain("w.slug AS word_slug");
    expect(sql).toContain("w.title AS word_text");
    expect(sql).toContain("status = ANY($3::text[])");
    expect(sql).toContain("ORDER BY o.created_at DESC, o.id");
    expect(sql).toContain("LIMIT $4");
    expect(params).toEqual(["u-1", "wb-1", ["标记中", "升级中"], 25]);
  });

  it("listPending returns an empty array when nothing is pending", async () => {
    const repo = new UpgradeWorkOrderRepository();
    vi.spyOn(repo as any, "query").mockResolvedValue([]);

    await expect(repo.listPending("u-1", "wb-1", 25)).resolves.toEqual([]);
  });

  it("updateStatus stamps completed_at when completed=true", async () => {
    const repo = new UpgradeWorkOrderRepository();
    const spy = vi.spyOn(repo as any, "queryOne").mockResolvedValue(workOrder({ status: "已完成" }));

    await repo.updateStatus("u-1", "wo-1", "已完成", { completed: true });

    const [sql, params] = spy.mock.calls[0];
    expect(sql).toContain("SET status = $3");
    expect(sql).toContain("completed_at = CASE WHEN $4::boolean THEN now() ELSE completed_at END");
    expect(params).toEqual(["u-1", "wo-1", "已完成", true]);
  });

  it("updateStatus leaves completed_at untouched when completed is false or omitted", async () => {
    const repo = new UpgradeWorkOrderRepository();
    const spy = vi.spyOn(repo as any, "queryOne").mockResolvedValue(workOrder({ status: "升级中" }));

    await repo.updateStatus("u-1", "wo-1", "升级中");

    expect((spy.mock.calls[0] as [string, unknown[]])[1][3]).toBe(false);

    await repo.updateStatus("u-1", "wo-1", "已取消", { completed: false });

    expect((spy.mock.calls[1] as [string, unknown[]])[1][3]).toBe(false);
  });

  it("updateStatus returns null when no row matches", async () => {
    const repo = new UpgradeWorkOrderRepository();
    vi.spyOn(repo as any, "queryOne").mockResolvedValue(null);

    await expect(repo.updateStatus("u-1", "missing", "已取消")).resolves.toBeNull();
  });
});
