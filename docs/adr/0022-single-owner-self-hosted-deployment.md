# ADR-0022: 自托管单 owner 形态与首次自举

- **Status**: Accepted
- **Date**: 2026-09-12
- **References**: ADR-0004 §6（红线/哲学）、ADR-0005（L3 边界）、CONTEXT.md（Device / Server authority）、`docs/operations/single-host-deployment.md`
- **上游**: 2026-09-12 后端完备性拷问会话（第一轮）

## Context

目标形态是**个人自托管**：本机 Docker 起全栈，经 Cloudflare Tunnel 暴露，多设备（桌面/手机）访问同一份数据。数据层已经是多用户形状（`profiles` + 每表 RLS + 复合 owner FK），但**鉴权、限流、配额、审计全是单 owner 形态**：唯一身份是 `LOCAL_OWNER_ID`，浏览器只能用一个 `OWNER_API_TOKEN` 换 8 小时会话。

实测发现一个**首次部署硬缺口**：部署六阶段（`scripts/deploy-compose-release.ts:47-54`）没有任何一步创建 owner 身份行；全仓唯一写 `profiles` 的脚本都是 fixture/验收/e2e 且用硬编码 UUID（`scripts/verify-release-database.ts:94`、`scripts/verify-database-roles.ts:220`、`scripts/verify-backup-rls-acceptance.ts:600`、`e2e/global-setup.ts:16`）；部署的 smoke 阶段（`release:smoke` → `scripts/verify-deployment-smoke.ts`）不碰登录。

而外键链是硬的：`auth_sessions.user_id → profiles.id`（`src/db/schema.ts:75-79`、`drizzle-release/0004_browser_sessions.sql:15`）、`wordbooks.user_id → profiles.id`（`src/db/schema.ts:495-500`）、`profiles.id → users.id`（`src/db/schema.ts:47-52`）。

⇒ 全新机器可以**部署六阶段全绿，但登录返回 422**（FK 23503），且界面不会说明缺什么。开发机从未暴露此问题，因为 dev 库早被 e2e 播种过。

## Decision

1. **形态锁定：单 owner / 单机自托管 / 多设备**。多用户列为"不排除但不投入"——数据层将来无需重构即可支撑，但现在不为多租户投入鉴权/配额/审计。
2. **owner 身份行由显式幂等自举步骤创建**：新增 `bootstrap-owner`（读 `LOCAL_OWNER_ID` + 可选 email，幂等 upsert `users` + `profiles`），纳入部署的 `prepare` 阶段并写入单机运行手册。**不在迁移里 seed**：UUID 来自环境，迁移无法知道。
3. **部署 smoke 必须断言"能登录"**（不只探 `/healthz`、`/readyz`）：否则"部署成功但用户进不去"会再次静默通过。

## Tradeoffs

- **显式自举 vs 迁移 seed**：seed 需要固定 UUID，与"UUID 来自 `.env`"冲突，且把环境相关数据写进 schema 历史。
- **自动化自举 vs 运行手册手工步骤**：手工步骤是个人自托管最常见的"部署当天卡死"，且无法被 CI/契约测试守护。
- **单 owner vs 多租户**：单 owner 让鉴权/限流/配额保持极简；代价是将来上多用户要补这一整层（数据层已就绪，应用层要新做）。

## Consequences

- ✅ 首次部署"能不能用"变成可被门禁验证的事实，而不是运气。
- ✅ 多设备共享同一 owner 身份得到正式承认（无 per-device 分区），消除"要不要做设备隔离"的反复摇摆。
- ⚠️ smoke 断言登录需要 owner 凭据进入 smoke 环境——密钥不得进日志/证据文件（沿用现有脱敏约定）。
- ⚠️ 单 owner 形态下无 per-tenant 配额与审计；登录限流在多设备/无代理时退化为单一桶（`src/http/routes/auth.ts:28-35`），该弱点保留但已知。
