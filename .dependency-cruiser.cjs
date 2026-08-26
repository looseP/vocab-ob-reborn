/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: '循环依赖会导致模块初始化顺序不确定（v1 createRepositories 坑）',
      from: {},
      to: { circular: true },
    },
    {
      name: 'db-no-outbound-to-business',
      severity: 'error',
      comment: 'db 基础设施层不得反向依赖 repositories/services/domain — ADR-001',
      from: { path: '^src/db/' },
      to: { path: '^src/(repositories|services|domain|schemas)/' },
    },
    {
      name: 'domain-no-outbound',
      severity: 'error',
      comment: 'domain 层零出向依赖 — ADR-001',
      from: { path: '^src/domain/' },
      to: { path: '^src/(db|repositories|services|observability|errors|schemas)/' },
    },
    {
      name: 'llm-no-db',
      severity: 'error',
      comment: 'llm 层只保留 provider/parser/prompt 等纯 LLM 能力，不得直接访问 DB（持久化走 repository 边界）— Phase 2B 架构清理',
      from: { path: '^src/llm/' },
      to: { path: '^src/db/' },
    },
    {
      name: 'errors-no-outbound',
      severity: 'error',
      comment: 'errors 层零出向依赖 — ADR-001',
      from: { path: '^src/errors/' },
      to: { path: '^src/(db|repositories|services|domain|observability|schemas)/' },
    },
    {
      name: 'services-no-raw-db-access',
      severity: 'error',
      comment: 'services 只能用 withTransaction，不得直接调 sql/getPool/getDb — ADR-001',
      from: { path: '^src/services/' },
      to: { path: '^src/db/(sql|connection|client|logger|relations|schema|timezone|types)' },
    },
    {
      name: 'repositories-no-services',
      severity: 'error',
      comment: 'repositories 不得反向依赖 services — ADR-001',
      from: { path: '^src/repositories/' },
      to: { path: '^src/services/' },
    },
    {
      name: 'http-no-raw-db-access',
      severity: 'error',
      comment: 'http 层必须通过 service 访问数据，不得直连 db/repositories — ADR-001 self-growing 扩展',
      from: { path: '^src/http/' },
      to: { path: '^src/(db|repositories)/' },
    },
    {
      name: 'http-no-llm-direct',
      severity: 'error',
      comment: 'http 层不得直接调 LLM provider，必须经 service 层（llm 是业务逻辑）— self-growing 扩展',
      from: { path: '^src/http/' },
      to: { path: '^src/llm/' },
    },
    {
      name: 'l2-no-direct-l3-adapter',
      severity: 'error',
      comment: 'L2 drill 模块不得直接依赖 L3ContextSourceAdapter，必须通过 ContextSource 抽象接口（src/domain/context-source.ts）— ADR-0016 / FR-12 接线2 红线。services/index.ts 作为 DI 装配器例外',
      from: {
        path: '^src/(services/l2-|domain/l2-|repositories/l2-|http/routes/l2-|http/l2-)',
        pathNot: '^src/services/index\\.ts$',
      },
      to: { path: 'src/services/l3-context-source-adapter' },
    },
    {
      name: 'l2-no-l3-direct',
      severity: 'error',
      comment: 'L2 模块不得直接依赖 L3 repositories 或 L3 domain（l3-* / domain/l3-*），必须通过 ContextSource 抽象接口 — ADR-0016 DIP',
      from: {
        path: '^src/(services/l2-|domain/l2-|repositories/l2-|http/routes/l2-|http/l2-)',
        pathNot: '^src/services/index\\.ts$',
      },
      to: { path: '^src/(repositories/l3-|domain/l3-)' },
    },
    {
      name: 'no-orphans',
      severity: 'warn',
      comment: '孤立模块（无人引用）— 可能是死代码',
      from: {
        orphan: true,
        pathNot: [
          '^src/index\.ts$',
          '^src/server\.ts$',
          '^tests/',
          '^scripts/',
          '[.]d[.]ts$',
        ],
      },
      to: {},
    },
  ],
  options: {
    doNotFollow: {
      path: ['node_modules'],
    },
    tsPreCompilationDeps: true,
    tsConfig: {
      fileName: 'tsconfig.json',
    },
    reporterOptions: {
      text: {
        highlightFocused: true,
      },
    },
  },
};
