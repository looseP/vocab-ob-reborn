# 分层覆盖率门禁：diff 覆盖率的 base 选择与 fail-closed 契约

`npm run test:unit` 的最后两步是 `npm run coverage:layered`（`scripts/report-layered-coverage.ts`）
与 `npm run test:collection`。前者做两件事：

1. **分层 baseline ratchet**：domain / service / repository / http 四层的
   lines / statements / branches 不得低于 `config/coverage-baseline.json`（只允许上调）。
2. **受治理 diff 覆盖率**：`<base>...HEAD` 之间**受治理层**（`src/domain`、`src/errors`、
   `src/services`、`src/repositories`、`src/http` 下的 `.ts`）变更的可执行行必须 ≥85% 被单测覆盖。

本文只讲第 2 项的 base 选择与判定——在 2026-09-11 之前，base 解析为 HEAD 时它会静默打印
“N/A” 并通过，等于门禁失效。

## 1. 判定表（三种 N/A 场景，只有两种合法）

| # | base 与工作树 | 判定 | 报告输出 |
|---|---|---|---|
| 1 | 解析出的 base == HEAD | **错误**（exit 1） | 指引：设置 `COVERAGE_BASE_REF`（如 `origin/main`、`HEAD^`）后重跑 |
| 2 | base != HEAD，但受治理 diff 为空**且** `src` 有未提交改动 | **错误**（exit 1） | 同上（“改了但没提交”的伪装场景） |
| 3 | base != HEAD，`src` 工作树干净，`src` 有改动但**全在受治理层之外** | 允许 N/A | `N/A — changed src files exist outside governed layers: <文件列表>` |
| 4 | base != HEAD，`src` 工作树干净，`src` 完全没变 | 允许 N/A | `N/A — no src changes in <base>...HEAD` |
| — | base != HEAD，受治理层有可执行改动 | 计算 pct | `<pct>% (PASS/FAIL)`，阈值 85% |

报告头部**总是**打印：使用的 base ref、变更 src 文件数（受治理 / 受治理层之外）、
变更可执行行数（含已覆盖数）、未提交 src 文件数。

关键前提：门禁只看得见**已提交**内容。`git diff <base>...HEAD` 永远不含工作树改动，所以
“未提交 + 无输出” 必须是错误，否则就是换一种静默。

## 2. 本地怎么指定 base（自助清单）

```powershell
# 看最后一次提交改了什么（本地最常用：先提交，再运行）
$env:COVERAGE_BASE_REF='HEAD^'; npm run test:unit

# 看整条分支相对 main 加了什么
$env:COVERAGE_BASE_REF='origin/main'; npm run test:unit
```

```bash
COVERAGE_BASE_REF=HEAD^ npm run test:unit
COVERAGE_BASE_REF=origin/main npm run test:unit
```

未设置 `COVERAGE_BASE_REF` 时的回退顺序是 `origin/main` → `main` → `HEAD~1`（取第一个与
HEAD 有 merge-base 的）。**没有远端追踪引用的 clone 会选到 `main`，而 `main` 通常就是 HEAD**，
于是按设计失败并给出指引——这是有意为之，见下一节。

## 3. 常见报错与处置

| 报错 | 原因 | 处置 |
|---|---|---|
| `Resolved coverage base ref "main" is HEAD (...)` | 环境里没有 `origin/main`，回退到 `main` 且等于 HEAD | `COVERAGE_BASE_REF=HEAD^`（或 `origin/main`）后重跑 |
| `Diff coverage is unavailable (...) while src has uncommitted changes (...)` | 受治理改动还没提交 | 提交（或 stash）后重跑；报告只测已提交内容 |
| `Unable to resolve coverage base ref "..." to a commit` | base ref 不存在（拼写错误 / 未 fetch） | `git fetch origin main`，或改用 `HEAD^` |
| `N/A — changed src files exist outside governed layers: ...` | 合法 N/A（例如只改了 `src/db/schema.ts`） | 无需处置；该文件的覆盖义务由所属层承担 |

以上错误信息都包含 `COVERAGE_BASE_REF` 指引，可直接照做。

补充：同一工作树里若有**其他并行任务**尚未提交的 `src` 改动，报错会逐个列出文件。此时正确的做法是
让那些改动先提交（或让它们离开工作树），或把 base 换成一个**已包含受治理改动**的 ref（例如
`HEAD~2`）——只要 diff 里确有受治理变更，判定就是计算值，未提交文件数仍会打印在报告头部，
不会被静默吞掉。

## 4. CI 接线（不得回退）

- `.github/workflows/ci.yml` → `Engineering verification`：
  `COVERAGE_BASE_REF: ${{ github.event.pull_request.base.sha || github.event.before }}`
  （PR / push 事件的精确 base sha；checkout 为 `fetch-depth: 0`，该 sha 一定存在）。
- `.github/workflows/release.yml` → `Verify engineering gates`：`COVERAGE_BASE_REF: HEAD^`
  （发布时 `origin/main` 要么等于 HEAD、要么是 HEAD 的祖先，`origin/main...HEAD` 会量到空；
  只有发布提交相对其第一父提交的差集才是这次发布带进来的内容）。

删掉这两处 env 会让对应 job 在 base 解析为 HEAD 时失败关闭（这是有意的）。不要为了“让 CI 变绿”
而放宽判定或下调阈值。
