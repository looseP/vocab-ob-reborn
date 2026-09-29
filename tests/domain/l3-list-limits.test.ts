/**
 * L3 列表分页契约的前后端一致性（2026-09-29）。
 *
 * 缺陷背景：`L3PapersPage.tsx` 硬编码 `/l3/sources?limit=100`，而后端
 * `l3SourceListQuerySchema` 上限是 50。两边**各自都合法**——Zod schema 通过、
 * 前端 TS 通过、`api:governance` 的 contract 测试两边都过——只在真实调用时炸：
 * 400 → 素材下拉恒空 → 粘贴建卷的 submit() 静默 return → 零请求零提示。
 *
 * 为什么单靠 contract 测试抓不到：契约测试验的是「后端 schema 接受什么」，
 * 不验「前端实际发了什么」。本文件补上缺的那一半。
 *
 * 三条护栏：
 *  - G-1 前端源码里不得出现硬编码的 `limit=` 数字（必须引用 domain 常量）；
 *  - G-2 domain 常量不得超过后端 schema 的实际上限；
 *  - G-3 变更后的常量值必须被后端 schema 接受（round-trip）。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { l3SourceListQuerySchema } from "@/schemas/http";
import { L3_SOURCE_LIST_LIMIT_MAX } from "@/domain/l3-list-limits";

const PAPERS_PAGE = join(process.cwd(), "src/frontend/components/l3/L3PapersPage.tsx");

describe("L3 素材列表分页契约", () => {
  it("G-1 前端不得硬编码 limit 数字，必须引用 domain 常量", () => {
    const src = readFileSync(PAPERS_PAGE, "utf8");
    // 只看调用点那一行，避免误伤注释与文档
    const callLine = src
      .split("\n")
      .find((line) => line.includes("/l3/sources?limit="));
    expect(callLine, "未能定位 /l3/sources?limit= 调用点").toBeDefined();
    expect(callLine).toContain("L3_SOURCE_LIST_LIMIT_MAX");
    // 不该再有裸数字（如 limit=100 / limit=50）
    expect(callLine).not.toMatch(/limit=\d/);
  });

  it("G-2 常量与后端 schema 的实际上限一致", () => {
    // max=50 的 schema 接受 50、拒绝 51
    expect(l3SourceListQuerySchema.safeParse({ limit: L3_SOURCE_LIST_LIMIT_MAX }).success).toBe(true);
    expect(l3SourceListQuerySchema.safeParse({ limit: L3_SOURCE_LIST_LIMIT_MAX + 1 }).success).toBe(false);
  });

  it("G-3 常量本身是合法正整数（防止有人把它改成 0 或负数）", () => {
    expect(Number.isInteger(L3_SOURCE_LIST_LIMIT_MAX)).toBe(true);
    expect(L3_SOURCE_LIST_LIMIT_MAX).toBeGreaterThan(0);
  });

  it("G-4 前端实际会发出的 query 能被后端 schema 接受（缺陷的直接回归）", () => {
    // 复现原缺陷：limit=100 曾导致 400
    expect(l3SourceListQuerySchema.safeParse({ limit: 100, sort: "recent" }).success).toBe(false);
    // 修好之后前端使用的值能被接受
    expect(
      l3SourceListQuerySchema.safeParse({ limit: L3_SOURCE_LIST_LIMIT_MAX, sort: "recent" }).success,
    ).toBe(true);
  });
});
