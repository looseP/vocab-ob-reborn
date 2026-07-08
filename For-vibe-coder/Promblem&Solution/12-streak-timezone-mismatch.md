# M5: calculateStreak 时区不一致

## 问题现象

v2 的 `calculateStreak` 用 UTC 计算日期边界，v1 用 `Asia/Shanghai`（+08:00），导致非 UTC 用户 streak 计数错位。

## 根因分析

**文件**: `src/repositories/stats.repository.ts` (修复前)

```typescript
// v2 (修复前) — 用 UTC
const rows = await this.query(
  `SELECT DISTINCT date_trunc('day', reviewed_at AT TIME ZONE 'UTC')::date::text AS review_day ...`
);
// JS 端也用 UTC
today.setUTCHours(0, 0, 0, 0);
```

**v1** — 用 `Asia/Shanghai`：
```typescript
// v1 lib/utils.ts
export function startOfTodayIso() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: DISPLAY_TIMEZONE,  // "Asia/Shanghai"
    ...
  }).formatToParts(new Date());
  return new Date(`${year}-${month}-${day}T00:00:00+08:00`).toISOString();
}
```

**回归示例**：用户在北京时间 23:30 复习：
- v1 算作"今天"（Shanghai 日期）
- v2 算作"明天"（UTC 日期，因为 23:30 CST = 15:30 UTC，UTC 日期还没变但 Shanghai 已是次日）

## 后果

- streak 计数错位，跨午夜复习的用户 streak 可能断掉或虚增
- `reviewedToday` 统计也可能错位

## 解决方案

新建 `src/db/timezone.ts` 模块，用 `Intl.DateTimeFormat` 按 `Asia/Shanghai` 取日期 key：

```typescript
export const DISPLAY_TIMEZONE = "Asia/Shanghai";

export function dayKeyInDisplayTz(iso: string | Date): string {
  const date = typeof iso === "string" ? new Date(iso) : iso;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: DISPLAY_TIMEZONE,
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function startOfTodayIsoInDisplayTz(): string {
  const key = todayKeyInDisplayTz();
  return new Date(`${key}T00:00:00+08:00`).toISOString();
}
```

`calculateStreak` 改为：SQL 返回 `reviewed_at` 原始时间戳，JS 端用 `dayKeyInDisplayTz` 转换。

## 验证方式

- 单元测试用 `setHours(12)` 构造中午时间，验证 streak 正确
- 测试验证 UTC 00:00-04:00 窗口（Shanghai 次日）的正确性

## 关联文件

- `src/db/timezone.ts` (新建)
- `src/repositories/stats.repository.ts`
- `src/repositories/session.repository.ts`
