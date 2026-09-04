# ADR-002: 双轨 FSRS 隔离（L1 速刷 / L2 持久化）

- **Status**: Accepted
- **Date**: 2026-07-07（Phase 2A 建立）
- **Supersedes**: 早期 self-growing-knowledge-chain 决策 1（修正其矛盾部分）
- **Phase**: Phase 2A → Phase 2B

## Context

L1（认知识别）与 L2（应用辨析）是两种不同认知任务，记忆衰减规律不同。混在一个 FSRS
调度里会互相污染：L1 速刷失败不该重置 L2 辨析记忆；L2 扩展不该触发 L1 重卡；
L1 retention(0.85) ≠ L2 retention(0.90)。

## Decision

### 双轨定位

| 维度 | L1 速刷底线轨 | L2 持久化轨 |
|------|-------------|------------|
| 认知任务 | 再认——看到词想起释义 | 回忆+辨析——主动使用+区分近义 |
| desired_retention | 0.85 | 0.90 |
| 交互时长 | <5s/词 | 15-30s/词 |
| 调度表 | `user_word_progress` | `user_word_l2_progress`（新建） |
| content_hash | `l1_content_hash` | `l2_content_hash` |
| weights | per-wordbook `fsrs_weights` | per-wordbook `fsrs_l2_weights`（冷启动复用 L1） |

### L1 desired_retention=0.85 的产品依据（勿"修复"）

L1 的 0.85 是**刻意的低压力定位**，不是保守默认值，依据如下：

- **产品意图**：L1 层是廉价的眼熟漏斗（混眼熟），不给用户施压。全局调高 DR
  会线性放大每日到期队列——那是全员加压，与分层哲学相悖。
- **重复集中在难词，由 FSRS 难度自适应局部完成**：`again` 评级自动大幅缩短
  该词间隔、简单词间隔指数拉长。"重在重复"不需要全局调参来实现。
- **低 DR 反而加速 L2 晋升**：间隔效应（在更低提取概率时成功回忆 → stability
  增幅更大）意味着 0.85 下每个有效复习换来更大的 S 跳跃，更少总复习次数即
  到达 L2 准入门（S≥21d 且 ≥5 次）。
- **主动加量有专属出口**：用户想多刷走 `cram` 模式（queue API `mode=cram`），
  调度节奏不为此买单。
- **压力分层是设计而非失衡**：L1 容忍遗忘（<5s 再认，15% 遗忘成本极低）；
  L2 辨析记忆才值得高频维护，且 CHECK 锁死 `l2_desired_retention ≥ 0.900`。

后续如需差异化（如备考冲刺），方向是词书级 DR 配置
（wordbook-space spec 已预留字段），而非修改本常量。

### content_hash 分层（隔离的物理基础）

`src/db/content-hash.ts` 计算三层 hash：
- `computeL1Hash` = hash(释义 + 词根 + 记忆锚点 + 语义链路)
- `computeL2Hash` = hash(搭配 + 语料 + 同义 + 反义)
- `computeFullHash` = hash(L1 + L2)（兼容导入去重）

L1 字段变更 → 重算 l1_hash → `markL1StaleForRecheck`（L1 重卡，L2 不动）。
L2 字段变更 → 重算 l2_hash → `markL2StaleForRecheck`（L2 重卡，L1 不动）。
**两者互不波及**，这是双轨隔离的物理保证。

### L2TransitionService：L1 → L2 单向继承

当 L1 达到稳定高原时晋升出 L2 卡（不迁移，是新增）：
- 条件：`L1_stability ≥ 21d` AND `L1_review_count ≥ 5` AND `last_rating ∈ {good, easy}` AND 无已存在 L2
- 继承：`inherit_ratio = 0.5 × L1_S / (L1_S + 21)`；`L2_S = max(L1_S × ratio, 1.0)`（vuln-1 floor）
- `L2_difficulty = min(10, L1_difficulty + 2.0)`；`L2_state = 'review'`；`L2_desired_retention = 0.9`
- 幂等：先 `findByWordAndUser` 检查 + catch 只吞 23505 unique violation（vuln-2），其余 re-throw

### ReviewService 与 L2TransitionService 解耦

`ReviewService` 通过可选依赖 `checkAndTransition` 注入 L2 晋升逻辑，
不直接 import `L2TransitionService`。`createServices` 里构造一次
`L2TransitionService`，把它的 `checkAndTransition` 传给 `ReviewService`。
这使 ReviewService 可独立测试，L2 晋升逻辑可独立演进。

## Tradeoffs

- **L2 transition 是 best-effort，不回滚 L1**：`submitAnswer` 主事务先提交 L1 调度结果，
  `checkAndTransition` 在其后执行；若 L2 插入失败（非 23505），L1 已提交不回滚。
  理由：L1 是用户答题的真相，L2 是派生优化，不应因派生失败否定主答。下次 review 满足条件会再试（幂等）。
- L2 冷启动复用 L1 weights——首阶段可接受，后续 L2 有足够数据后切独立 weights。

## Consequences

- ✅ L1/L2 调度物理隔离，互不污染
- ✅ 单向继承模型清晰，幂等可重试
- ⚠️ L2 transition 失败时 L1 已落库，需靠幂等重试而非事务回滚补偿
