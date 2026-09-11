# ADR-0024: 公网暴露的信任边界（强制 Cloudflare Access + 设备会话管理）

- **Status**: Accepted
- **Date**: 2026-09-12
- **References**: ADR-0022（单 owner 自托管）、`docs/operations/single-host-deployment.md`、`docs/operations/security-control-plane.md`
- **上游**: 2026-09-12 后端完备性拷问会话（第一轮）

## Context

服务经 Cloudflare Tunnel 从公网可达后，现有信任边界只有**一个长期凭据**：`OWNER_API_TOKEN`（Bearer）或由其换取的 8 小时浏览器会话（`src/services/auth-session.service.ts:18,36-58`）。仓库已具备 Tunnel 覆盖层与 Caddy 配置（`compose.cloudflare-tunnel.yaml`、`Caddyfile.cloudflare-tunnel`、`scripts/verify-cloudflare-tunnel-compose.ts`），但 Cloudflare Access **只是运行手册建议**（`docs/operations/single-host-deployment.md:123`），服务端不校验 Access 身份。

⇒ token 一旦泄露（截图、日志、旧手机）等于全部数据暴露；且除"撤销某个会话 token"外没有设备级管理面。

## Decision

1. **公网入口必须经 Cloudflare Access**，且**服务端校验 Access JWT**（不把把关只交给边缘）。
2. **提供"会话/设备列表 + 撤销单个设备"**（`auth_sessions` 已支持按 token 撤销，`src/repositories/auth-session.repository.ts:42-51`；需补列出能力与界面）。
3. **不做 TOTP/自建二次验证**：Cloudflare Access 已提供强身份与策略；在应用内再造一套收益低、维护成本高。
4. **本机直连（127.0.0.1）豁免 Access，但保留 owner token**：否则本地开发会被自己的访问策略锁死。

## Tradeoffs

- **边缘把关 vs 应用内校验**：双层校验让"边缘配置错误"不再等于"直接放行"；代价是引入 Access JWT 公钥的运行时获取与缓存。
- **Cloudflare 依赖 vs 自建强身份**：接受对 Cloudflare 的依赖（Tunnel 已是依赖），换取二次验证/策略/审计的"零自研"。
- **强制 vs 建议**：强制会让"裸跑一个公开 hostname"变成实现上不可配置的缺失；代价是部署步骤增加一步 Access 应用创建。

## Consequences

- ✅ 单凭据泄露不再等于全裸；"隐藏 URL"这类伪保护被制度性排除。
- ✅ 设备级撤销有了产品面（手机丢失可踢）。
- ⚠️ Access JWT 校验引入运行时依赖：公钥获取失败/时钟漂移必须 **fail closed**，且要可观测（否则会退化成"偶发全站 401"）。
- ⚠️ 运行手册措辞需从"建议"改为"必须"，并把 Access 应用创建纳入部署验收清单。
- ⚠️ `AGENT_API_TOKENS`（agent 身份）与 Access 的关系需在实现时明确：agent 走 Bearer 时不经过浏览器 Access 流程，其信任来源仍是 token 本身。
