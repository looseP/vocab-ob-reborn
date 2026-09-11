# ADR-0026: 单机自托管可观测性（日志落盘 + 轻量 watcher，否决全家桶）

- **Status**: Accepted
- **Date**: 2026-09-12
- **References**: ADR-0022（单 owner 自托管）、`docs/operations/slo-runbook.md`、`docs/operations/secret-rotation.md`
- **上游**: 2026-09-12 后端完备性拷问会话（第一轮 Q6=B / 第二轮裁决）

## Context

实测现状：日志以 JSON 写 **stderr**（`src/observability/logger.ts:43-44`），compose **未配 logging driver** → Docker 默认 json-file 且无轮转；单机 compose 的服务清单（postgres / role-bootstrap / migrate / converge / web / worker / reaper / backup-scheduler / data-lifecycle）里**没有 Prometheus / Alertmanager**——`alertmanager-routing.md` 面向的是另一套部署形态。

但指标面其实齐备：`/healthz`（存活）、`/readyz`（DB 池）、`/metrics`（Prometheus，bearer 保护）、`/api/operations/metrics`（owner 运行时快照，含 outbox 积压 gauge），且 SLO 阈值已定义（`slo-runbook.md`）。

⇒ 缺的不是仪表盘，而是**行车记录仪与喊人的嘴**。

## Decision

1. **日志轮转 + 落盘**：Docker json-file 配 `max-size`/`max-file` 轮转，并把日志落盘到宿主目录（便于 grep，且能随备份一起带走）。
2. **告警用轻量 watcher 容器**：读 `/metrics` 或 `/api/operations/metrics`，超阈值（outbox 积压、`/readyz` 失败等）POST 到 owner 的 webhook。
3. **否决**引入 Prometheus + Grafana 全家桶，也**否决**日志双写（两份日志必然漂移）。
4. **告警疲劳控制是核心，不是附加项**：连续 k 次超阈才发（吸收尖刺）+ 同告警 N 小时去重；没有它，两周后告警就被忽略，等于没做。
5. **watcher 心跳本期不做**：宿主整体失联时本机 watcher 也发不出告警——这是单人自托管**明示接受**的残余风险；将来若需要外部心跳，另立 ADR。
6. **webhook URL 含 token**：按 `docs/operations/secret-rotation.md` 管理，不进仓库、不进日志。

## Tradeoffs

- **轻量 watcher vs 全家桶**：全家桶能力更强，但维护成本会反噬单人自托管（监控系统本身成为需要被监控的对象）。
- **告警去重 vs 及时性**：连续 k 次 + N 小时去重引入延迟；换取"告警仍然刺眼"。
- **不查心跳 vs 完整覆盖**：接受"宿主全挂无人知"，避免为极小概率事件引入外部依赖。

## Consequences

- ✅ 出问题查得到（日志落盘 + 轮转），且日志可随备份带走。
- ✅ 出事有人叫（webhook），且不会两天内被噪音淹没。
- ⚠️ 残余风险明示：宿主整体失联无外部告警；watcher 自身是被监控对象之外的单点。
- ⚠️ watcher 的阈值与 `slo-runbook.md` 必须同源（避免两处各写一套数字）。
