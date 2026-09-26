/**
 * 错题库统一投影（2026-09-26）服务层测试。
 *
 * 锁死：入参归一（枚举 fail-closed / limit 封顶 / offset 归零）、userId 必填、
 * 以及最关键的一条——**零 FSRS**：服务不 import 任何 L1/L2/FSRS 仓储
 * （由 arch:check + 下面的装配断言共同保证）。
 */
import { describe, expect, it, vi } from "vitest";
import { ValidationError } from "@/errors";
import { L3ErrorBookService } from "@/services/l3-error-book.service";
import type { L3ErrorBookPage } from "@/domain";

const USER = "00000000-0000-4000-8000-000000000001";

function emptyPage(overrides: Partial<L3ErrorBookPage> = {}): L3ErrorBookPage {
  return { items: [], total: 0, limit: 20, offset: 0, ...overrides };
}

function makeService(listUnified = vi.fn(async () => emptyPage())) {
  const list = listUnified;
  const service = new L3ErrorBookService({
    txRunner: (async (fn: (tx: unknown) => Promise<unknown>) => fn({})) as never,
    repositoryFactory: (() => ({ l3ErrorBook: { listUnified: list } })) as never,
  });
  return { service, list };
}

describe("L3ErrorBookService.list", () => {
  it("缺省 = 两腿合并（kind: null）", async () => {
    const { service, list } = makeService();
    await service.list({ userId: USER });
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ kind: null, limit: 20, offset: 0 }));
  });

  it("userId 必填（空白 → ValidationError，不静默放行）", async () => {
    const { service, list } = makeService();
    await expect(service.list({ userId: "  " })).rejects.toBeInstanceOf(ValidationError);
    expect(list).not.toHaveBeenCalled();
  });

  it("kind 非法 → ValidationError（fail-closed，不猜腿）", async () => {
    const { service, list } = makeService();
    await expect(service.list({ userId: USER, kind: "both" })).rejects.toBeInstanceOf(ValidationError);
    expect(list).not.toHaveBeenCalled();
  });

  it("space / direction 非法 → ValidationError", async () => {
    const { service } = makeService();
    await expect(service.list({ userId: USER, space: "听力" })).rejects.toBeInstanceOf(ValidationError);
    await expect(service.list({ userId: USER, direction: "四六级" })).rejects.toBeInstanceOf(ValidationError);
  });

  it("合法两轴透传", async () => {
    const { service, list } = makeService();
    await service.list({ userId: USER, space: "阅读", direction: "考研", kind: "question" });
    expect(list).toHaveBeenCalledWith(expect.objectContaining({
      userId: USER, space: "阅读", direction: "考研", kind: "question",
    }));
  });

  it("limit 归一：缺省 20 / 越界封顶 100 / 非法回落 20", async () => {
    const { service, list } = makeService();
    await service.list({ userId: USER, limit: 5000 });
    expect(list.mock.calls[0]![0]).toMatchObject({ limit: 100 });

    await service.list({ userId: USER, limit: 0 });
    expect(list.mock.calls[1]![0]).toMatchObject({ limit: 20 });

    await service.list({ userId: USER, limit: 1.5 });
    expect(list.mock.calls[2]![0]).toMatchObject({ limit: 20 });
  });

  it("offset 归一：负数/小数 → 0（不把坏输入当分页位置）", async () => {
    const { service, list } = makeService();
    await service.list({ userId: USER, offset: -5 });
    expect(list.mock.calls[0]![0]).toMatchObject({ offset: 0 });
    await service.list({ userId: USER, offset: 2.5 });
    expect(list.mock.calls[1]![0]).toMatchObject({ offset: 0 });
  });

  it("零构造可跑（组合根不注入任何仓储时走默认工厂）", () => {
    expect(() => new L3ErrorBookService()).not.toThrow();
  });
});
