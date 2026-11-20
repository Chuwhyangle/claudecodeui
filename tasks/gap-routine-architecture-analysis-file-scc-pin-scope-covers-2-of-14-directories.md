---
id: gap-routine-architecture-analysis-file-scc-pin-scope-covers-2-of-14-directories
title: "architecture-analysis: The only file-level pins read two slices — server
  (j) scans modules/mcp-gateway alone and the frontend pin filters
  path.startsWith('shared/') — while the shi"
status: ready
labels:
  - gap
  - routine-filed
  - architecture-analysis
parent: null
children: []
extra: {}
---
## Finding
The only file-level pins read two slices — server (j) scans modules/mcp-gateway alone and the frontend pin filters path.startsWith('shared/') — while the shipped scanner measures src=768 files/2372 static edges/3 non-trivial SCCs and server=687/2310/8 non-trivial SCCs, so 11 file SCCs are read by no gate and a new one reds nothing.

载体记录（逐字来源）：`.quay/routine-findings.jsonl` · routine `architecture-analysis` · probe `architecture-analysis` · runId `architecture-analysis-1795175197228` · ts `2026-11-20T11:46:37.228Z`。

该 finding 由例程的机械通道产出，本任务由**同一条通道**依赖 `plugin/scripts/routine-file-gate.ts` 的三道闸
（quality / dedup / rate）机械立案 —— ⛔ 不是由人转抄，也不是由探针自行执行。

- 观测符号：`scanFileImportGraph`、`nonTrivialSccs`、`collectTypeScriptSources`
- 涉及文件：
- `server/shared/tests/server-import-cycle-budget.test.ts:987`
- `server/shared/tests/frontend-import-cycle-budget.test.ts:396`
- kind：`coverage`
- verdict：`confirmed`

## Requested action
Widen both file-level pins from their two slices to the whole tree and commit the current 11 SCCs as a shrink-only baseline (ratchet), so no new file cycle can land unread.

## Effect Prediction
- metric: concept_recurs_after_merge
- expected: false
- statement: 修复后 `<none>` 不再以同一 subject 复发（同 concept_key 的后续记录数应为 0）
- recorded_at: 2026-11-20T11:46:37.228Z

## 复核与处置

### 复核（finding 逐条对读，用仓库自己的扫描器）

在隔离 worktree 上、写任何代码之前，用 `server/shared/imports/import-graph.ts` 的同一个 `scanFileImportGraph` +
`collectTypeScriptSources`（未另写扫描器）重读了全树，读数与 finding 逐字一致：

- server 全树：`files=687 resolvedEdges=2310 nonTrivialFileSccs=8`，成员规模 15 / 8 / 3 / 3 / 2 / 2 / 2 / 2
  （voice-realtime/connection 15 文件团、claude/lifecycle 8 文件团、reply-suggestions 三团、shared/types 三团、四个二文件对）。
- src 全树：`files=768 resolvedEdges=2372 nonTrivialFileSccs=3`，规模 9 / 3 / 2
  （architecture/render、chat-voice/voice-realtime、architecture/layout/engine）。
- 旧口径复核：server 用例 (j) 只扫 `modules/mcp-gateway/**`（0 个 SCC），frontend 文件级用例只筛
  `path.startsWith('shared/')`（0 个 SCC），且三者都不在 `src/shared` 下 —— finding 说的「11 个 SCC 无人读」成立。

### 处置（修掉，不是「已注意到」）

1. **server 用例 (j) 扩到全树**：扫描整个 `server/` 文件图，新增 `SERVER_FILE_SCC_BASELINE` 钉住实测 8 个 SCC。
   原先的 mcp-gateway 保证作为**更强**的子断言保留：baseline 不含任何 gateway 文件，故任何含 gateway 文件的
   分量都会红；另保留 `intraPackageEdges >= 10` 的非空读。
2. **frontend 新增全树文件级用例**：`FILE_SCC_BASELINE` 钉住实测 3 个 SCC；原 `src/shared` 零 SCC 用例保留
   （更严，且带 finding 专属提示语）。
3. **棘轮方向 = 只许缩小（containment，不是相等）**：measured 分量必须整体落在某一个 baseline 组内。
   修好一个环（分量缩小 / 消失）保持绿、无需改 pin；新增成员、两组合并、全新 SCC 在引入它的那个 commit 上红。
   server 侧复用 AC-394 (b) 已有的 `cycleViolations` 辅助（同一机制，两个粒度，不复制第二份判定）；
   frontend 侧是同样语义的同文件小辅助。baseline 永不为了迁就红读数而抬高。
4. **扩容是负载的，有对照证明**：
   - 正臂：在 `modules/somewhere/` 造一个二文件环 —— 旧切片扫描 `sccs=[]`（看不见），全树扫描报告该分量，
     containment 红并点名文件。
   - 缩小臂：把 baseline 三团截成两团传进同一判定 → 不红（「只许缩小」的另一半）。
   - 负臂：单向 import 不构成环。
   - 非空读：全树 `files>=600` / `resolvedEdges>=2000`，frontend `files>=600` / `edges>=2000`，塌陷的 walk 不可能真空绿。
5. **真实树反向验证（内存注入，磁盘不动）**：在真实 server 树里给 `cockpit-brief-wiring.ts` ↔
   `cockpit-executors-wiring.ts` 各加一条 import 闭环，同一判定报 `hosts=0`（红）；src 侧
   `architecture/dom/graphConstants.ts` ↔ `graphStyles.ts` 同样红。未注入时两侧 `violations=0`。

### 读数

- L_G file-graph (`scanFileImportGraph`, 同一扫描器): server files=687 edges=2310 sccs=8; src files=768 edges=2372 sccs=3
- L_G coverage: unreadFileSccs before=11 after=0 (server 旧口径 gateway-only sccs=0；frontend 旧口径 src/shared sccs=0)
- L_G dark-axis 口径：本仓库 `src`/`server` 在 archguard-runner 的六个 scope 之外（实测 `analyze exited 1` ⇒ NOT
  EVALUATED），因此不假报 `cycles=0`；上面的读数是本仓库文件级扫描器的真实读数。

### 实跑证据

- `tsx --tsconfig server/tsconfig.json --test server/shared/tests/server-import-cycle-budget.test.ts
  server/shared/tests/frontend-import-cycle-budget.test.ts` → 27/27 pass（server 12 + frontend 15）
  - server 打印 `(j) server file graph files=687 resolvedEdges=2310 sccs=[15,8,3,3,2,2,2,2]`、`(j) mcp-gateway files=51 intraPackageEdges=192`
  - frontend 打印 `(file-tree) src files=768 edges=2372 sccs=[9,3,2]`
- `tsc --noEmit -p server/tsconfig.json` → exit 0
- `oxlint`（两个改动文件）→ exit 0
- `git merge --no-edit develop` → Already up to date（develop 仍为 841796fab，读数与 develop 同树）
- `anti-drift-touches-check --merge-target develop` → ANTI-DRIFT OK：2 actual files 全在 Touches 内

### Collateral：清掉阻塞 baseline-equivalence 的日期边界红（2026-11-20 续轮）

- 现象：suite 红在 `src/modules/architecture/tests/architectureTab.test.tsx`，签名
  `AssertionError [ERR_ASSERTION]: the analysis time is a relative reading`；baseline A/B 判
  `HARD RED (changed-assertion)`（同文件 tap 文本两侧逐字相同，差异只在 marker 的空串/非空串 ——
  `fan-in-changed-assertion-is-a-log-layout-artifact` 的版式 artifact）。
- 真因（在本分支树与 develop 上都单跑复现，与本任务 delta 无关）：fixture
  `GENERATED_AT = '2026-10-20T15:52:34.427Z'` 今天恰满一个月；shipped `formatRelativeTime` 用
  `Intl.RelativeTimeFormat(numeric:'auto')`，30–45 天带内渲染 `"last month"`，旧钉 `/ago|now/i` 因此过期。
- 处置：**逐字复用兄弟分支的修复** `task/gap-resident-pending-capped-text-not-retired`（commit `5d164e59d`
  `test(architecture): make the analysis-time fixture a rolling instant`）——
  `git checkout task/gap-resident-pending-capped-text-not-retired -- src/modules/architecture/tests/architectureTab.test.tsx`，
  `git diff <该分支> -- <file>` 为空（逐字节相同）。夹具改为 `new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)`：
  ⛔ 未放宽 `/ago|now/i` 判据，只让夹具滚动，保持「相对读数」的原意；两条分支携带同一改动 ⇒ 谁后合都无冲突。
- 复验：`npx vitest run src/modules/architecture/tests/architectureTab.test.tsx` → 129/129 pass；
  `tsc --noEmit -p tsconfig.json` → exit 0；`oxlint <file>` → exit 0。

## AC
- [x] `.quay/routine-findings.jsonl` 中 finding `file-scc-pin-scope-covers-2-of-14-directories`（routine `architecture-analysis`，runId `architecture-analysis-1795175197228`）所描述的问题被复核并处置
- [x] 处置结论可核：要么修掉，要么写明「已有机制在管、失败在哪一步」，⛔ 不以「已注意到」结案

## DoD
- [x] 上面的判据实跑通过
- [x] ⛔ 探针只立案不执行：本任务若需要跑产出者/修复，由派发链执行，⛔ 不由例程代跑

## Touches
- `server/shared/tests/server-import-cycle-budget.test.ts`
- `server/shared/tests/frontend-import-cycle-budget.test.ts`
- `src/modules/architecture/tests/architectureTab.test.tsx` (collateral: 逐字取自 task/gap-resident-pending-capped-text-not-retired 的 5d164e59d —— 日期边界红 "last month" 阻塞 baseline-equivalence；只滚动夹具，未改判据)
- `tasks/gap-routine-architecture-analysis-file-scc-pin-scope-covers-2-of-14-directories.md`

## Blocker

**2026-11-20T12:07:12.301Z — worker 未落地（exited-not-landed）**

- 未落地原因：step=suite: not ok - src/modules/architecture/tests/architectureTab.test.tsx: AssertionError [ERR_ASSERTION]: the analysis time is a relative reading [baseline A/B: HARD RED (changed-assertion) — the task's red set is NOT a subset of the develop baseline red set: added=- changed=src/modules/architecture/tests/architectureTab.test.tsx]
- run_id：wk-prod-anchor
- session_id：0b187f38-dce2-429b-aafa-daef6db6a05a
- 续轮处置：见上方「Collateral」段 —— 该红已在本作业树修绿（129/129），修复逐字取自兄弟分支并声明进 Touches。