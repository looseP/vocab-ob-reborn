# N1 工程验收收尾 · 运行证据与根因定位（2026-09-20）

> 范围：`vitest run --coverage` 收尾挂死的证据化诊断、最小修复判定、工程门禁自然退出证据、Task 07–08 任务书校准的输入。
> 纪律：本台账**不预填通过**——超时、终止、环境差异、未闭环项分别如实记录；所有结论附命令与日志路径。
> 执行仓库（主）：`D:/Temp/vocab-ob-n1`（分支 `study-notes-n1-backend`，单执行者串行）。

## 1. 基线与工具实况（实测）

| 项 | 值 | 证据 |
|---|---|---|
| 起始 HEAD | `c31724e5a79e9b0a1df4b24f6ab825bc0abd52fe`（本地=远端） | `git log -1`、`git ls-remote origin` |
| 依赖 base | `integration/l3-reliability-writing@b7dcea4e`（PR #125 draft） | `git ls-remote` |
| 工具 | Node v22.22.2、npm 10.9.7（`.nvmrc`=22.22.2 一致） | `node --version`、`npm --version` |
| 实际安装 | vitest 4.1.10、vite 8.1.3、@vitest/coverage-v8 4.1.10、why-is-node-running 2.3.0 | `node_modules/*/package.json` |
| lockfile 一致性 | `package-lock.json` 锁定值与实际安装一致（vitest/vite/coverage-v8） | lock 读取脚本输出 |
| 启动方式 | 诊断运行 1/2 用 `node node_modules/vitest/vitest.mjs run --coverage`（直启二进制；与 `npm run test:unit` 的 `vitest run --coverage` 同源） | 运行命令记录 |
| 报告器背景 | 配置 reporters=`text,html,json,json-summary`（vitest.config.ts 未改） | `vitest.config.ts` |
| 诊断开始时间 | 2026-09-20 00:22（本地） | 会话日志 |

**声明与实际的差异核查**：`package.json` 声明 `vitest ^4.1.5`；实际安装 4.1.10（满足 range；lock 一致）。二者无不一致项。依赖升级/重装**未做**（遵守「不先升级依赖」）。

## 2. 挂死机制：证据链（三段）

### 2.1 段一 · 阶段定位（诊断运行 1）

- 命令：`node node_modules/vitest/vitest.mjs run --coverage --reporter=default --reporter=hanging-process --reporter=./tests/_diag-reporter.mjs --teardownTimeout=15000`（临时诊断 reporter，用后删除；非产品代码）
- 日志：`D:/tmp/n1c-diag1.log`
- 观测时间线（本地时间）：
  - `00:24:00` reporter init；测试执行 `Test Files 242 passed | 1 skipped (243)`、`Duration 66.74s`
  - `00:25:11` coverage 产物写盘完成（`coverage-final.json` 2.4MB、`coverage-summary.json`、html 树；mtime 实测）
  - `00:25:11` 后：**覆盖率表格完整打印**（4623 行日志尾部为表格结束分隔线）
  - `00:25:16` 起（onTestRunEnd 后 +5s）：主进程快照持续显示 `handles(0)`、`requests(1)=FSReqCallback`
  - `00:25:20` `.tmp` 目录 mtime 停止推进（删除推进中断）
  - **持续 195 秒以上无变化**（tick 采样至 +215379ms），无任何 `close timed out` / unhandled error 输出
- 现场：`coverage/.tmp/` 残留 **32 个分片文件**，编号集合 = `{0,1,10,11,12,100..126}`（= 名称字典序前 32 个；127 分片中被删 95 个）
- 终止：取证完成后 TaskStop 终止（非自然退出）

### 2.2 段二 · 挂起操作定位（诊断运行 2）

- 命令同段一（reporter v2：async_hooks 追踪 FSREQCALLBACK 创建栈 + 挂死 45s 后 why-is-node-running 全量转储）
- 日志：`D:/tmp/n1c-diag2.log`
- 关键输出（决定性证据）：
  - pending FS 请求创建栈（async_hooks id=1880194，age≥45s）：
    ```
    at rmdir (node:fs:1163:17)
    at _rmdir (node:internal/fs/rimraf:115:3)
    at node:internal/fs/rimraf:76:14
    at FSReqCallback.oncomplete (node:fs:197:5)
    ```
    → 挂起操作 = **`internal/fs/rimraf`（即 `fs.rm(recursive:true)` 内部实现）的 `rmdir`**；发起于所有条目删除完毕后的目录删除收尾。
  - `coverage/.tmp` **目录已被整体删除**（挂死期间实测 "No such file"；`coverage/` 目录 mtime 00:30:44），但该 rmdir 的完成事件从未返回 → `await cleanAfterRun()` 永不 resolve。
  - why-is-node-running 转储：2021 个活跃 async 资源 = **2020 FILEHANDLE + 1 FSREQCALLBACK**（`_getActiveHandles()` 仍为 0）。该 FILEHANDLE 计数未做交叉验证（不排除 tracking 口径假象）；后续最小复现（§2.3，无该计数）独立成立，故不作为机制结论输入。
  - 无 `close timed out` 输出：**vitest 的 `exit()` 兜底（teardownTimeout 定时器）从未获得执行机会**——流程卡死在 `reportCoverage` 的 `cleanAfterRun()` 内，走不到 `exit()`。
- 终止：`00:44:19` 有界超时（timeout 900s）KILL，`EXIT=137`；**记未完成/环境故障，不记通过**。

### 2.3 段三 · 最小复现（不涉及 vitest、不涉及仓库任何代码）

- 工具：`D:/tmp/n1c-rm-stress.mjs`（写 N 个文件后 `fs.rm(dir,{recursive:true})`，30s 超时保护）、`D:/tmp/n1c-single-op-stress.mjs`（单文件 write/unlink）
- **D 盘**（`D:/tmp/n1c-rm-stress`，20 轮 × 127 文件）：
  - `round 0..4: ok ≈4100ms/轮`（≈32ms/文件；异常缓慢）
  - **`round 5: TIMEOUT 30s（HANG 复现）`**；挂死现场残留 **32 个文件（编号集合与 §2.1 vitest 现场完全一致）**
- **C 盘对照**（`C:/Users/20564/AppData/Local/Temp/n1c-rm-stress`，5 轮 × 127 文件）：`20–27ms/轮，全部成功`
- **D 盘另一目录**（`D:/tmp/n1c-rm-stress2`，5 轮）：`≈4100ms/轮`（慢速复现；本轮未挂）→ 非单目录特有
- **单文件操作**（D 盘，300 次）：`unlink 平均 38.5ms`、write 平均 1.4ms（干净小文件、无并发）→ 「每个删除都被拖慢 ~40×」
- **系统工具对照**（bash `rm -rf`，127 文件 ×3 轮）：D≈1358ms vs C≈1518ms——无区分力（msys 工具自身开销 ~1.4s 主导），**不作为证据使用**
- 判定（**修订版，依据 §2.5 扩展勘察**）：**本机 fs 删除行为按「目录位置」分化，而非盘符**——「Temp 类」目录为快区（≈20–35ms/轮）；多数其他位置为慢区（≈4.1s/轮，≈120–200×）并偶发永久挂起（如 `C:\...\AppData\Local\Temp` 快而其同父 `C:\...\AppData\Local` 非 Temp 区首轮即挂）。与 vitest、coverage、仓库代码均无关（最小复现独立成立）。

### 2.4 根因闭环程度（如实边界）

- **已闭环**：挂死机制（vitest `cleanAfterRun → fs.rm(.tmp)` 中一个未完成的 rmdir/unlink 请求 → `await` 永不 resolve → 走不到 `exit()` 兜底）；环境差异的**定量地图**（目录级快/慢分化：快区 20–35ms/轮 vs 慢区 ≈4.1s/轮；慢区偶发永久挂起；最小复现可再现，见 §2.5）。
- **未闭环**：为何「非 Temp 类目录」普遍慢且偶发挂起、而 Temp 类目录稳定快——系统层成因（介质类型、文件系统过滤驱动、索引/安全软件配置等）无法在本机沙箱内枚举取证（`tasklist` 空输出、`reg`/`wmic`/PowerShell 进程与设备查询被策略限制，遵守护栏不绕过）。
- **旧记录修正**：上一批次记录的「报告器调整/直启二进制三次复现」中，`--coverage.reporter=json,text` 一次实为**参数误用**（istanbul 报 `Cannot find module 'json,text'`，见 `D:/tmp/n1c-coverage-rerun.log` 尾部），未构成有效的「去 html」对照；本轮证据表明挂死与 reporter 组合无关（diag1/diag2 均完整产出 text+html+json+summary 后，才在 `.tmp` 清理阶段挂死）。

### 2.5 运行区域勘察（位置地图，扩展对照）

同一最小脚本（写 127 文件 + `fs.rm(recursive)`/轮）在多个位置实测（除注明外均为沙箱内）：

| 位置 | 实测 | 判定 |
|---|---|---|
| `C:\Users\20564\AppData\Local\Temp`（= `os.tmpdir()`） | 19–28ms/轮，稳定（沙箱内外一致） | **快区** |
| `C:\Windows\Temp` | 29–35ms/轮，稳定 | **快区** |
| `C:\`（根） / `C:\Users\Public` / `C:\Users\20564\.workbuddy` | ≈4.1s/轮（3 轮未挂） | 慢区 |
| `D:\Temp` / `D:\tmp`（两个不同目录） | ≈4.1s/轮；**第 6 轮永久挂死（复现；残留 32 分片模式与 §2.1 相同）** | 慢区 + 偶发挂 |
| `C:\Users\20564\AppData\Local`（非 Temp） | **首轮即挂死（30s 无进展）**；无沙箱对照 4.1s/轮（3 轮未挂） | 慢区（沙箱内更易挂） |
| `C:\Temp`（C 根下） / `C:\ProgramData` | **首轮即挂死** | 挂区 |

- 「慢/快」按**目录位置**分化（同父目录即可分化：`…\Local\Temp` 快 vs `…\Local` 非 Temp 首轮挂），与盘符无关。快区恰为两个 Temp 类目录——形状符合「目录级扫描排除策略」，**系统层成因未闭环**（沙箱内禁止进程/设备/过滤驱动枚举）。
- **无沙箱（escalation 批准的一次对照）**：4.1s/轮的「慢」在沙箱内外相同 → 沙箱不是慢的成因；「首轮挂死」在无沙箱下未复现（3 轮）→ 沙箱**可能**放大挂死概率（样本有限，如实记录相关性，不确定因果）。
- 勘察结论的工程含义：本机「非 Temp 类目录」普遍处于慢区并带偶发挂死风险；「Temp 类目录」是唯一稳定快区。验收位置选择见 §4。

## 3. 修复判定

- 挂死入口在**依赖（vitest）的收尾清理**与**本机 D 卷 fs 行为**的交叉点，**非仓库代码缺陷**；仓库侧无可归因修复点（不改 `node_modules`、不做无依据配置绕行、不降门槛）。
- 本轮采用任务书 §三.6 允许的**隔离运行路径**完成门禁验收（见 §4）；原环境（D 盘）不修改，保留最小复现脚本与命令以便复现。
- 证据保留：`D:/tmp/n1c-diag1.log`、`D:/tmp/n1c-diag2.log`、`D:/tmp/n1c-rm-stress.mjs`、`D:/tmp/n1c-single-op-stress.mjs`。

## 4. 工程门禁（隔离运行路径）

### 4.0 位置与准备

- 运行位置（最终）：**`C:/Windows/Temp/n1-verify-c`**（独立 clone；HEAD=起始 SHA；lock/config 同源；`npm ci` 按 lock 安装，56s、exit 0）。
- **位置选择（实测依据；全程透明）**：本机 fs 勘察（§2.5）表明「快区」仅两个 Temp 类目录。① 用户 Temp（`os.tmpdir()`）会令 `run-alerting-drill.test.ts` 因「仓库位于 tmpdir 下」而失败（守卫如实拦截 22 例，记录于 §4.1）；② `C:\Windows\Temp` **不在 `os.tmpdir()` 判定内**（守卫原样执行、如实通过），且经压测为快区（29–35ms/轮）。该位置选择属任务书 §三.6「隔离运行路径」范畴（独立 clone、SHA/lock/config 与门禁不变、零代码改动）；此记录供审查复现与复议。
- 正式命令（与门禁等值）：

  ```powershell
  $env:HUSKY = '0'
  $env:API_CONTRACT_BASE_REF = 'b7dcea4e26b799b05a9b6312d9694908026c4e01'
  $env:COVERAGE_BASE_REF = 'b7dcea4e26b799b05a9b6312d9694908026c4e01'
  $env:ROUTE_COMPLEXITY_BASE_REF = 'b7dcea4e26b799b05a9b6312d9694908026c4e01'
  npm run verify:engineering
  ```

### 4.1 首轮（Temp 位置，失败；保留记录）

- 位置：`…/AppData/Local/Temp/n1-verify-c`；结果：`VERIFY_EXIT=1`（2m59s；非超时终止）。
- **该轮已证明**：`vitest run --coverage` 在 C 卷**完整执行并自然退出**（进程级无挂死）——`Test Files 2 failed | 240 passed | 1 skipped`、`Tests 23 failed | 3578 passed | 6 skipped`、`Duration 93.81s`；失败全部归因于「clone 位于系统 tmpdir 之下」（alerting-drill 22 例 + l3-papers 1 例 flaky）。
- 日志：`D:/tmp/n1c-c-verify.log`。
- 位置修正 + 定向复验：移至 `C:/Users/20564/AppData/Local/n1-verify-c` 后，两文件 **54/54 通过、exit 0**（`D:/tmp/n1c-c-targeted.log`，5.17s）。

### 4.2 正式运行（非 tmpdir 位置；最终）

- 命令与位置：见 §4.0；日志 `D:/tmp/n1c-c-verify4.log`。
- **结果：`VERIFY4_EXIT=0`**（2026-09-20 01:16:56 → 01:19:50，2 分 54 秒）。
  - `vitest run --coverage`（`test:unit` 第一环）：`Test Files 242 passed | 1 skipped (243)`、`Tests 3601 passed | 6 skipped (3607)`、Duration 59.66s；**进程自然退出（0）**，`coverage/.tmp` 清理完成、无残留。
  - `coverage:layered`：Baseline ratchet **PASS**；各层 target 全 **PASS**（domain 98.17/95.04、service 95.09/83.85、repository 93.83/82.69、http 91.67/79.85）；**diff coverage 93.65%（PASS）**。
  - `test:collection`、`db:schema:drift`、`api:governance`（openapi 再生成无 diff / client check / contract / breaking / route complexity ratchet passed）、`frontend:build`、`runtime:verify`、`alerting:verify`、`release:acceptance:contract`、`secret-rotation:evidence:contract`、`release:workflow:verify`：**全部 exit 0**（证据同在日志）。
- 过程备忘（如实）：本轮为第四次运行；前三次详见 §4.1（Temp 位置 22 例守卫拦截 → 修正）与本节修订前记录（AppData\Local 位置二次挂死；Windows\Temp 首跑出现 1 例满负载 flaky 超时 `generate-openapi-client.test.ts`——单文件复跑 3 次全过、第四次全量通过；记备为「满负载下该测试偶发 30s 超时」，非挂死、非位置缺陷）。
- 解释口径：本结果证明「工程门禁在隔离运行路径下自然退出 0」；**原环境（D 盘/沙箱内）挂死根因未闭环**（§2.4），不得转述为「D 盘环境问题已修复」。

## 5. skipped 用例说明（与基线核对）

- 全量 `6 skipped` 全部来自 `tests/ingest/corpus-acceptance.test.ts`（**1 个文件、6 个用例**，`describe.skip`）。
- 跳过条件：`INGEST_CORPUS_DIR` 未设置或指向不存在路径（依赖外部真实语料包，默认不启用）；与 N1 无关，**数量与基线一致**（未新增跳过、未启用需外部资源的测试）。

## 6. Task 07–08 任务书校准

- 交付：`docs/plan/study-notes-frontend-tasks-2026-09-20.md`（可独立执行的前端任务书）+ 既有文档消费合同修正（`study-notes-backend-repair-2026-09-19.md` §8、`study-notes-execution-plan-2026-09-18.md` Task 07–08 指引入口）。
- 本轮只准备任务书，不实施前端（停在 Task 07–08 开工之前）。

## 7. 未关闭项

- 「慢区」（非 Temp 类目录）为何普遍慢且偶发挂起的系统层成因未闭环（§2.4）；工程门禁验收依赖隔离运行路径（§4.2 已完成，原环境挂死不修复）。
- `GET /:noteId/export` 未交付（Task 10）；Task 09 引用侧栏、N2 均后置。
- CI：依赖 PR #126 上仅 `Writing E2E` 自动运行；`ci.yml`（Engineering Gate + Browser E2E）不在 base≠main 的 PR 上触发——三项必需检查待 #125 合并并 retarget 后在新 head 运行（后续授权任务）；不拿旧 CI 充当新绿。

## 8. 推送、PR 与 CI（2026-09-20）

- 提交：**`5a1dbec`**（`docs(notes): close out engineering acceptance and calibrate Task 07-08`；5 files，+494/−3；提交后 `git fsck` exit 0、`git count-objects` 正常）。
- 推送：`git push origin HEAD:refs/heads/study-notes-n1-backend`（**fast-forward 普通推送，非强推、未推 main**）；`git ls-remote` 远端 = 本地 = `5a1dbecabde110d186ce4d739d9cee99351aae73`。
- PR **#126**：保持 **draft / OPEN**，base=`integration/l3-reliability-writing` 不变（未 retarget、未合并）；说明已更新（收尾轮证据、隔离验收、任务书校准）。
- CI（真实口径）：`Writing E2E` @ `5a1dbec` **pass**（run `35457924418`，2m1s）；`ci.yml`（Engineering Gate + Browser E2E）因 base≠main **未触发**——不以本 PR 的现有绿色替代三项必需检查。
- 本轮结束点：**停在 Task 07–08 开工之前**（任务书已校准、未实施；不宣称 N1 完整交付）。
