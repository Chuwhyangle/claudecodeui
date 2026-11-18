---
id: gap-ac309-real-runner-probe-stale-transport-path
title: AC-309 判据 runner 的 probe 路径被 voice-realtime god-package 分裂搬空（transport →
  core/）致判据恒红；重指现存出货模块 + 命名 server tsconfig 注册 + 守用例
status: ready
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-309
---
## Proposal

<!-- dedup-ref --> 立案 checkout `/data/home/yale/work/claudecodeui`，branch `develop`，`HEAD` = `a45bdd558aba60f0307ed7efb67faad02ecd73e9`，`HEAD^{tree}` = `c3c49a2754beff76070a0b0c60f03d85cbd23e92`，`git status --porcelain` 为空。机械扫描：`grep -l '^goal_ac: *AC-309' tasks/*.md` 只命中 `gap-voice-realtime-real-audio-paired-evidence`，其 `status:` 逐字为 **done**；把 `tasks/*.md` 按 `^status: (todo|ready|needs-human)$` 过滤后**无一**认领 AC-309 ⇒ 无在飞认领者。done 不算重复：它正是上一轮把 `run-real.mjs` 落地并通过判据的实现者，而本轮判据在 `run-real.mjs` **一字节未改**的情况下变红——这是「更早的修法没兜住」的证据。同机制姊妹 `gap-ac307-runner-register-tsconfig-alias`（done，AC-307）修的是 `run.mjs` 的 tsx 注册（**另一个机制**），并已登记 `run-real.mjs` 的路径问题属于 AC-309 范围；本条处理的是**probe 的硬编码路径指针**，不是注册。`task-granularity-advice.js --touches experiments/voice-realtime-ambiguity/run-real.mjs --touches server/modules/voice-realtime/tests/voice-realtime-live-executor.test.ts --json` 返回 `peers: []`、`mentions: []` ⇒ 无共享 Touches 的在飞任务，独立立案（separate）。

### 直接测量（本轮直跑，不是台账尾巴）

判据（逐字取自 `goals/AC-309-真实音频 paired 对比：ASR→文本 vs 真实 Qwen Realtime 原生推理+语义工具，四类场景+延迟长尾+GO-NO-GO.md` 的 `criterion:`）：`node experiments/voice-realtime-ambiguity/run-real.mjs`

直跑（`env -u TSX_TSCONFIG_PATH -u TSX_TS_CONFIG_PATH`）→ **EXIT 1**，stderr 逐字：

```
voice-realtime-ambiguity REAL paired reading: 1 failure(s)
  [probe] transport: /data/home/yale/work/claudecodeui/server/modules/voice-realtime/voice-realtime-dashscope-transport.ts does not exist
```

与台账尾巴 `2026-11-16T07:06:35.378Z` 记的 fail reason 逐字一致（同一句 `[probe] transport: … does not exist`）。关键分辨力：stdout 已经把 144 条离线读数全部算完并打印（`n=24 × 2 arm(s) × 3 rep(s)`、四类场景读数齐全、`TOTAL arm A 21/72 arm B 32/72`）——**红只落在 probe 的一条路径断言上，判据本体的读数与冻结快照都没有坏**。

### 根因（机制）

`3cee05605 refactor(voice-realtime): split the connection contract family and TTS leaves out of the god package`（任务 `gap-routine-architecture-analysis-god-package-server-voice-realtime`，done）把 `server/modules/voice-realtime/voice-realtime-dashscope-transport.ts` 移到 `server/modules/voice-realtime/core/voice-realtime-dashscope-transport.ts`，并同步了同批 importers 与测试，**但没有扫到这条不在 import 图里的硬编码路径**：

- `experiments/voice-realtime-ambiguity/run-real.mjs:87-89` 的 `MODULE_PATHS.transport` 仍指旧路径；
- `assertShippingModules()`（同文件 `:892-905`）把它当作 AC4 的「被测真实模块」证据：`existsSync` 失败即记 `[probe] transport: … does not exist`。

为什么清扫漏了它：`run-real.mjs` 不在被移动文件的 importers 里，3cee05605 的静态扫描（源码 + 同批测试）看不到这种路径字面量耦合——「one-hop import 关系漏掉非 import 的路径字面量」的同族。同一轮 `ff7edd1f4`（更早的分裂）曾更新过 `run-real.mjs` 的 `MODULE_PATHS.bridge`，说明每次分裂都要手工补这张表，而这次漏了 transport 那一行。

**同族第二条（只登记，不在本条修）**：`scripts/voice-realtime-status-cost.mjs:120` 同样加载旧路径，`node --experimental-transform-types scripts/voice-realtime-status-cost.mjs --self-test` 现在 exit 1（`Cannot find module '…/voice-realtime/voice-realtime-dashscope-transport.ts'`，本轮实测）。把路径改到 `core/` 之后它还有第二层断点：该脚本走 `--experimental-transform-types`、不经 tsx，而 `core/voice-realtime-dashscope-transport.ts:122/126` 现在 import `@shared/asr/...`，别名解析不了（`Cannot find package '@shared/asr'`，本轮实测）⇒ 那是**另一个机制**（loader/别名），不得夹带进本条。该脚本不被任何测试或判据派发（全仓 `grep` 只命中它自己与 `docs/operations/voice-realtime-status-cost.md`），不阻塞任何门。

### 为什么上一轮的 done 没守住

`gap-voice-realtime-real-audio-paired-evidence`（done, goal_ac: AC-309）落地 `run-real.mjs` 时把路径写对了，当时判据确实绿：它没有坏，是**之后**落地的 god-package 分裂把被测文件搬走了。done 任务无法预见后来的移动，所以判据 CURRENTLY FALSE 必须在**新树**上重新成立，而不是重开旧任务。

### 方案（最小切片 + 一条防复发）

1. `experiments/voice-realtime-ambiguity/run-real.mjs`：`MODULE_PATHS.transport` 改指 `server/modules/voice-realtime/core/voice-realtime-dashscope-transport.ts`（新文件 `:859` 仍为 `export function createDashscopeTransport`，probe 的签名检查继续成立）。
2. 同一文件把裸 `register()`（`:54`）改成命名 server tsconfig 的注册，形态与 AC-307 已给 `run.mjs` 的完全一致：`register({ tsconfig: fileURLToPath(new URL('../../server/tsconfig.json', import.meta.url)) })`。理由：B 臂 import 的 `server/modules/voice-realtime/index.ts` barrel 的运行时半区一旦再引入 `@/`（AC-310 已发生过一次），裸 `register()` 读根 tsconfig（`@/*` → `src/*`）会在产出任何读数前死掉；`server/tsconfig.json` 同时覆盖 `@/*` 与 `@shared/*`。`fileURLToPath` 已在该文件导入；必须用 `import.meta.url` 形态（`HERE`/`REPO_ROOT` 在其后定义，直接用会 TDZ）。
3. 防复发守：在既有 `server/modules/voice-realtime/tests/voice-realtime-live-executor.test.ts`（AC-307 的守用例就在这个文件；不新建 server 测试文件，避开 `server/shared/tests/quay-test-script.test.ts` 的文件覆盖面地板与 `scripts/suite-duration-baseline.tsv` 的覆盖面地板）追加**一个**用例：以清洗过 `TSX_TSCONFIG_PATH` / `TSX_TS_CONFIG_PATH` 的 env `spawnSync(process.execPath, [run-real.mjs])`，断言 exit 0。清洗是必须的——本仓 worker 环境 ambient 设了这些变量（AC-307 的守用例用同一手法），不清洗会把缺口遮住、守用例永远绿。

### 边界（不做）

不改冻结物：`experiments/voice-realtime-ambiguity/PREREG.md`、`fixtures/*.json`、`fixtures/real-paired.json`、`run.mjs`；不重新 `--live` 取数（本条是离线重算已冻结快照，读数必须与快照逐字一致）；不改 `scripts/voice-realtime-status-cost.mjs`（另一机制，见上）；不改 `goals/AC-309-*.md` 的 `criterion`（逐字保持 `node experiments/voice-realtime-ambiguity/run-real.mjs`）；不改 transport/bridge/barrel 本体。

## AC

- [x] AC1 判据从红变绿：`env -u TSX_TSCONFIG_PATH -u TSX_TS_CONFIG_PATH node experiments/voice-realtime-ambiguity/run-real.mjs` 退出 **0**，输出含 `n=24 × 2 arm(s) × 3 rep(s)` 与 `voice-realtime-ambiguity REAL paired reading: OK`；改前同命令 exit 1、stderr 逐字 `[probe] transport: …/voice-realtime/voice-realtime-dashscope-transport.ts does not exist`（立案读数，完成记录须逐字贴出改前/改后两次）。
- [x] AC2 读数不变（承重）：改后同命令打印的四类场景读数逐字仍为 `homophone-entity-ambiguity arm A 9/18 arm B 10/18`、`self-correction arm A 6/15 arm B 4/15`、`coreference arm A 0/15 arm B 7/15`、`world-model arm A 6/24 arm B 11/24`、`TOTAL arm A 21/72 arm B 32/72`，并含 `7/7 control(s) moved in the predicted direction` 与 `real=7/7 moved  control=inverted=against  runs=straddle=red`；`git diff develop...HEAD -- experiments/voice-realtime-ambiguity/fixtures/ experiments/voice-realtime-ambiguity/PREREG.md experiments/voice-realtime-ambiguity/run.mjs` 输出为**空**。
- [x] AC3 probe 指向现存的出货模块：完成记录给出证明 `MODULE_PATHS.transport` 所指文件存在且含 `export function createDashscopeTransport` 的逐字读数（`ls -l` + `grep -n`），路径为 `server/modules/voice-realtime/core/voice-realtime-dashscope-transport.ts`；并给出 `git show --stat 3cee05605` 中该文件 `{ => core}/` 的移动行作为归因证据。
- [x] AC4 tsx 注册命名 server tsconfig：`run-real.mjs` 的注册行逐字为 `register({ tsconfig: fileURLToPath(new URL('../../server/tsconfig.json', import.meta.url)) })`（形态同 AC-307 给 `run.mjs` 的注册），且 AC1 的清洗 env 命令在该注册下仍 exit 0。
- [x] AC5 守用例证明会红：新用例以清洗 env spawn 裸命令并断言 exit 0；把 `MODULE_PATHS.transport` 临时改回旧路径后该用例**变红**、恢复后变绿（两次读数都给出）；`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-live-executor.test.ts` 退出 0。
- [x] AC6 三条取假形态仍各自非零退出且判词指名原因：`--corpus=empty`（判词含 `the corpus is EMPTY`）、`--control=inverted`（判词含 `朝预测的**反方向**移动`）、`--runs=straddle`（判词含 `the readings come from 2 different runs`）——修好 probe 之后这三条不得被 probe 的噪声掩盖或静默失效。
- [x] AC7 静态门：`npm run typecheck`、`npm run lint` 退出 0。

## DoD

真实落地判据：不是「台账尾巴碰巧翻绿」，是**那条判据命令本身在净检出上重新 exit 0，且冻结读数逐字不变**。失败只被允许是 probe 的路径指针被 god-package 分裂搬走；修法只能是让指针重新指向现存的出货模块——⛔ 不得靠跳过 probe、放宽 `assertShippingModules`、改判据字面量、改冻结快照或重新 `--live` 取数来变绿。守用例必须被证明**会红**（改回旧路径后红、恢复后绿，两次读数都给），下一次同族移动必须在测试里立刻可见，而不是等 driver 的下一轮。交付面 = `experiments/voice-realtime-ambiguity/run-real.mjs`（路径 + 注册）、`server/modules/voice-realtime/tests/voice-realtime-live-executor.test.ts`（一个用例）与本任务文件三处；`git diff --name-only develop...HEAD` 不得含 `experiments/voice-realtime-ambiguity/fixtures/**`、`experiments/voice-realtime-ambiguity/run.mjs`、`goals/**` 或 `server/modules/voice-realtime/` 下的非测试实现文件。

## Touches

- experiments/voice-realtime-ambiguity/run-real.mjs（edit: `MODULE_PATHS.transport` 重指 core/ + `register` 传 server tsconfig）
- server/modules/voice-realtime/tests/voice-realtime-live-executor.test.ts（edit: 追加一个裸命令 exit-0 守用例）
- experiments/voice-realtime-ambiguity/fixtures/real-paired.json（只读不改：AC2 的逐字读数来源）
- scripts/voice-realtime-status-cost.mjs（只读不改：同族第二条断点的登记，另一机制、不在本条修）
- tasks/gap-ac309-real-runner-probe-stale-transport-path.md（自触）

## 完成记录

实现提交：`c65117122 fix(voice-realtime): re-point the AC-309 runner probe at the moved transport + guard it`（2 文件，+38/−2）。worktree `/data/home/yale/work/claudecodeui-worktrees/gap-ac309-real-runner-probe-stale-transport-path`，分支 `task/gap-ac309-real-runner-probe-stale-transport-path`，基线 `4e0cb5a42`（= 立案时 develop）。

### AC1 判据从红变绿

改前（worktree 净检出、改动前同一棵树，`env -u TSX_TSCONFIG_PATH -u TSX_TS_CONFIG_PATH node experiments/voice-realtime-ambiguity/run-real.mjs`）→ **EXIT 1**，stderr 逐字：

```
voice-realtime-ambiguity REAL paired reading: 1 failure(s)
  [probe] transport: /data/home/yale/work/claudecodeui-worktrees/gap-ac309-real-runner-probe-stale-transport-path/server/modules/voice-realtime/voice-realtime-dashscope-transport.ts does not exist
```

改后同命令 → **EXIT 0**，stdout 逐字含 `n=24 × 2 arm(s) × 3 rep(s) = 144 reading(s) expected`，末行逐字：

```
voice-realtime-ambiguity REAL paired reading: OK — n=24 × 2 arm(s) × 3 rep(s); quality numbers are a reading and are NOT a criterion
```

### AC2 读数不变

改后同命令逐字：

```
n=24 × 2 arm(s) × 3 rep(s) = 144 reading(s) expected
  homophone-entity-ambiguity   arm A 9/18   arm B 10/18
  self-correction              arm A 6/15   arm B 4/15
  coreference                  arm A 0/15   arm B 7/15
  world-model                  arm A 6/24   arm B 11/24
  TOTAL                        arm A 21/72   arm B 32/72
…
  7/7 control(s) moved in the predicted direction
…
  real=7/7 moved  control=inverted=against  runs=straddle=red
```

改前/改后 stdout 逐行 diff（仅剔除含绝对 probe 路径的 5 行头部）除新增的那一行 `… REAL paired reading: OK …` 外**完全一致**。冻结物：`git diff develop...HEAD -- experiments/voice-realtime-ambiguity/fixtures/ experiments/voice-realtime-ambiguity/PREREG.md experiments/voice-realtime-ambiguity/run.mjs | wc -l` → **0**。

### AC3 probe 指向现存的出货模块

```
$ ls -l server/modules/voice-realtime/core/voice-realtime-dashscope-transport.ts
-rw-rw-r-- 1 yale yale 79504 Nov 16 15:12 server/modules/voice-realtime/core/voice-realtime-dashscope-transport.ts
$ grep -n "export function createDashscopeTransport" server/modules/voice-realtime/core/voice-realtime-dashscope-transport.ts
859:export function createDashscopeTransport(options: DashscopeTransportOptions = {}): DashscopeTransport {
```

归因（`3cee05605` 的移动行）：

```
$ git show --stat=200 --find-renames 3cee05605 | grep dashscope-transport
 server/modules/voice-realtime/{ => core}/voice-realtime-dashscope-transport.ts             |    4 +-
$ git show --name-status --find-renames 3cee05605 | grep dashscope-transport
R099	server/modules/voice-realtime/voice-realtime-dashscope-transport.ts	server/modules/voice-realtime/core/voice-realtime-dashscope-transport.ts
```

### AC4 tsx 注册命名 server tsconfig

`experiments/voice-realtime-ambiguity/run-real.mjs:57` 逐字：

```
register({ tsconfig: fileURLToPath(new URL('../../server/tsconfig.json', import.meta.url)) });
```

AC1 的清洗 env 命令在该注册下 exit 0（见 AC1）。

### AC5 守用例证明会红

绿（恢复 `core/` 后）：

```
$ npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-live-executor.test.ts
✔ AC-309 guard: `node experiments/voice-realtime-ambiguity/run-real.mjs` exits 0 under a washed tsx env (2581.128695ms)
ℹ tests 6  ℹ pass 6  ℹ fail 0        (exit 0)
```

红（把 `MODULE_PATHS.transport` 临时改回旧路径，同一命令）：

```
✖ AC-309 guard: `node experiments/voice-realtime-ambiguity/run-real.mjs` exits 0 under a washed tsx env (2812.472688ms)
ℹ tests 6  ℹ pass 5  ℹ fail 1        (exit 1)
  voice-realtime-ambiguity REAL paired reading: 1 failure(s)
    [probe] transport: …/server/modules/voice-realtime/voice-realtime-dashscope-transport.ts does not exist
```

失败集只有这一条新用例（其余 5 条 AC-307 等用例仍绿），恢复后复跑 exit 0。

### AC6 三条取假形态

```
--corpus=empty    → exit 1  [n] the corpus is EMPTY — n=0 × 2 arm(s) = 0 readings, and an empty reading is not a green one
--control=inverted→ exit 1  [control] --control=inverted … —— 朝预测的**反方向**移动
--runs=straddle   → exit 1  [pairing] the readings come from 2 different runs (1970-01-01T00:00:00.000Z (1 reading(s)); run-voice-realtime-paired-live-1 (179 reading(s))) — two arms compared in one run must not straddle runs
```

三者在修好的 probe 下各自非零退出、判词指名原因，未被 probe 噪声掩盖。

### AC7 静态门

`npm run typecheck` → exit 0（三个 tsc 项目全过）；`npm run lint` → exit 0（仅仓库既有 warning，两个改动文件零命中）。

### ADR-007 暗轴

- 该轴仍暗,理由:本任务只把判据 runner 的硬编码 probe 路径重指到被 god-package 分裂搬走的现存模块并补一条守用例，未改任何模块依赖边、未运行 archguard，L_D/L_G 没有本轮可记的量化读数。

## Blocker

**2026-11-18T10:06:42.504Z — worker 未落地（exited-not-landed）**

- 未落地原因：step=suite: not ok - src/modules/chat/utils/tests/voiceLiveSegmenter.test.ts: AssertionError [ERR_ASSERTION]: the long-corpus sample is missing at /data/home/yale/work/tc-verify/corpus/long/L4-nonstop.wav — the criterion cannot run without it [baseline A/B: HARD RED (changed-assertion) — the task's red set is NOT a subset of the develop baseline red set: added=- changed=src/modules/chat/utils/tests/voiceLiveSegmenter.test.ts]
- run_id：wk-prod-anchor
- session_id：bbcba56e-6346-4f1e-9b18-a4e47884ea90
