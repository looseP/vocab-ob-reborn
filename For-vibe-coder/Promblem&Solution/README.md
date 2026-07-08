# 问题与解决方案汇总

本项目开发过程中遇到的所有关键问题，按类别归档。每个文档记录问题现象、根因分析、解决方案和验证方式。

## 目录

### 架构暗伤修复

| 编号 | 文件 | 问题 | 严重度 |
|---|---|---|---|
| H1 | [01-submitAnswer-transaction-failure.md](./01-submitAnswer-transaction-failure.md) | submitAnswer 事务完全失效，所有查询走各自独立池连接 | 🔴 高危 |
| H2 | [02-counterField-sql-injection.md](./02-counterField-sql-injection.md) | counterField 动态列名拼接，无白名单校验 | 🔴 高危 |
| H3 | [03-findDueCards-column-ambiguity.md](./03-findDueCards-column-ambiguity.md) | findDueCards 裸列名在 JOIN 后歧义 | 🔴 高危 |
| H4 | [04-requireTx-runtime-enforcement.md](./04-requireTx-runtime-enforcement.md) | 事务方法无运行时强制，事务外调用致锁失效 | 🔴 高危 |
| H5 | [05-missing-skip-suspend-undo.md](./05-missing-skip-suspend-undo.md) | skip/suspend/undo 等核心操作完全缺失 | 🔴 高危 |

### 第二轮审查发现

| 编号 | 文件 | 问题 | 严重度 |
|---|---|---|---|
| H-NEW-1 | [06-undo-wordbook-id-misplacement.md](./06-undo-wordbook-id-misplacement.md) | undoReviewLog 把 progress_id 当 wordbook_id 传入 | 🔴 高危 |
| H-NEW-2 | [07-note-getOrCreateDefault-outside-tx.md](./07-note-getOrCreateDefault-outside-tx.md) | NoteService.getOrCreateDefault 在事务外执行 | 🔴 高危 |

### 中危问题

| 编号 | 文件 | 问题 | 严重度 |
|---|---|---|---|
| M1 | [08-getWordBySlug-anonymous-error.md](./08-getWordBySlug-anonymous-error.md) | getWordBySlug 抛匿名类而非 AppError | 🟡 中危 |
| M2 | [09-getDb-not-reset-with-pool.md](./09-getDb-not-reset-with-pool.md) | getDb() 不随 resetPool() 重置 | 🟡 中危 |
| M3 | [10-timedQuery-dead-code.md](./10-timedQuery-dead-code.md) | timedQuery 死代码，logger 引用不存在的类 | 🟡 中危 |
| M4 | [11-note-upsert-non-atomic.md](./11-note-upsert-non-atomic.md) | NoteRepository.upsert 三语句非原子 | 🟡 中危 |
| M5 | [12-streak-timezone-mismatch.md](./12-streak-timezone-mismatch.md) | calculateStreak 用 UTC，v1 用 Asia/Shanghai | 🟡 中危 |
| M6 | [13-fsrs-adapter-optional.md](./13-fsrs-adapter-optional.md) | FSRS adapter 默认 stub 运行期才炸 | 🟡 中危 |
| M7 | [14-ReviewCard-fake-word-data.md](./14-ReviewCard-fake-word-data.md) | ReviewCard 构造时传假 word 数据 | 🟡 中危 |
| M-NEW-3 | [15-circular-dependency-createRepositories.md](./15-circular-dependency-createRepositories.md) | createRepositories 从 @/index 导入形成循环依赖 | 🟡 中危 |
| M-NEW-4 | [16-saveAnswer-missing-content-hash-snapshot.md](./16-saveAnswer-missing-content-hash-snapshot.md) | saveAnswer 漏更新 content_hash_snapshot | 🟡 中危 |

### 基础设施问题

| 编号 | 文件 | 问题 | 严重度 |
|---|---|---|---|
| I1 | [17-postgres-port-5432-occupied.md](./17-postgres-port-5432-occupied.md) | Docker PG 5432 端口被 wslrelay 占用 | 🟡 中危 |
| I2 | [18-drizzle-pull-empty-string-bug.md](./18-drizzle-pull-empty-string-bug.md) | drizzle-kit pull 生成空字符串默认值语法错误 | 🟡 中危 |
| I3 | [19-drizzle-tsvector-unsupported.md](./19-drizzle-tsvector-unsupported.md) | Drizzle 不原生支持 tsvector 类型 | 🟢 低危 |
| I4 | [20-github-push-blocked.md](./20-github-push-blocked.md) | github.com:443 不可达 + PAT 权限不足 + Windows 命令行长度限制 | 🟡 中危 |

### 测试覆盖缺口

| 编号 | 文件 | 问题 | 严重度 |
|---|---|---|---|
| T1 | [21-ReviewService-zero-coverage.md](./21-ReviewService-zero-coverage.md) | ReviewService 4 个核心方法零测试覆盖 | 🟡 中危 |
| T2 | [22-mock-tx-cannot-distinguish-pool.md](./22-mock-tx-cannot-distinguish-pool.md) | mockTx.query === pool.query 无法验证事务绑定 | 🟡 中危 |
