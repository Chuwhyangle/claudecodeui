---
id: gap-providers-websocket-cycle-port-break
title: 把 websocket 组拉出 5 成员依赖环：providers/services 的 2 处 websocket
  import（broadcastSessionUpserted/Batch + chatRunRegistry）改经端口注入，环缩为 3
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

**机制与去重（立案时实测，2026-10-23，HEAD 5189f5d4a）**：机制词 grep → 命中 `gap-server-provider-websocket-init-cycle-ports`（done，用 ports 拆过 provider/websocket/mcp-gateway/session-hosts 环）、`gap-voice-provider-cycle-port-break`（done，voice 出环）、`gap-projects-services-cycle-port-break`（done，projects 出环）——都是同款断边手法，但**当前 5 成员 providers↔websocket 核心环无人认领**，本条是其继续。granularity `peers: []` ⇒ **separate**。

### 现状（立案时实测，archguard 新鲜读数）

- 唯一目录环 = **5 成员**：`providers / providers/list/claude / providers/services / websocket / websocket/services`。
- 跨组边只有两组：`providers/services → websocket` **2 处**、`websocket/services → providers` **8 处**。
- 最小割在「providers → websocket」这一侧（2 处 < 8 处），全在 providers/services，共 **3 个符号**：
  1. `sessions-watcher.service.ts:9` → `broadcastSessionUpsertedBatch`（:753 用 1 处）
  2. `sessions.service.ts:6` → `broadcastSessionUpserted`（:533/:1121 用 2 处）
  3. `sessions.service.ts:6` → `chatRunRegistry`（:325/:688/:781/:868 用 4 处）
- 断掉这 2 处边后 providers 组不再依赖 websocket，环 **5→3**（剩 providers 组内部 3 成员环：providers / providers/list/claude / providers/services），websocket 组出环。
- 现成资产：`chatRunRegistry` 已有 `server/shared/ports/chat-run-registry.port.ts`（`readChatRunRegistryPort`）；`broadcastSessionUpserted`/`broadcastSessionUpsertedBatch` 需新 port（镜像 projects-session-fetch.port 手法）。

### 改法

把 3 个符号改经端口注入：`broadcastSessionUpserted`/`broadcastSessionUpsertedBatch` 走新 `session-broadcast.port.ts`，`chatRunRegistry` 走既有 `chat-run-registry.port.ts`（read 函数）；assembly 处安装。**行为保持**：广播/运行查询语义不变。

⛔ 护栏：端口落 `server/shared/ports/`（不新建模块目录）；扩展既有 `chat-run-registry.port` 时新成员必须可选、不得加必填成员；判据复用 AC-394 的 `strongComponents`（`server/shared/import-graph.ts`）。

<!-- dedup-ref --> 相关但不同机制：`gap-voice-provider-cycle-port-break`（done）与 `gap-projects-services-cycle-port-break`（done）是同款断边手法的直接前例（各断一环）；`gap-server-provider-websocket-init-cycle-ports`（done）是 ports 手法样板。三者均不构成本条前置。

## Plan

1. **读边**：确认这 2 处 import 是 providers/services → websocket 仅有的出边（以当前树为准）。
2. **定端口**：新增 `session-broadcast.port.ts`（broadcastSessionUpserted / broadcastSessionUpsertedBatch）；确认 chat-run-registry.port 的 read 函数覆盖 `listRunningRuns`/`isProcessing`。
3. **接线**：3 个符号改经 port 读取，删除 2 处 websocket import；调用方路径不变。
4. **判据**：复用 AC-394 扫描器断言「providers 组 ↔ websocket 组」不再双向（websocket 组不在 SCC）；环 5→3。
5. **收口**：既有判据仍绿、tsc/lint、collateral、范围受控。

## AC

- [x] (a) **providers/services 不再 import websocket**：`grep -rnE "@/modules/websocket" server/modules/providers/services --include='*.ts'` 计数 = **0**（含动态 import 字面量）；`grep -n "session-broadcast" server/index.ts` 命中（assembly 安装）。
- [x] (b) **端口存在**：`test -f server/shared/ports/session-broadcast.port.ts` 退出 0；`grep -q "session-broadcast" server/index.ts` 退出 0。
- [x] (c) **判据存在且跑通（websocket 出环）**：`npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/providers-websocket-cycle.test.ts` 退出 0；复用 AC-394 的 `strongComponents`/`collectServerSources`，打印 `websocketInProvidersScc=false`（并打印每段非平凡 SCC 成员，websocket 组不在 providers 组 SCC 内）。
- [x] (d) **AC-394 棘轮仍绿**：`npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/server-import-cycle-budget.test.ts` 退出 0（G1 5→3 属允许缩小；逐成员仍是基线子集）。
- [x] (e) **既有行为判据不改一字仍绿**：覆盖 sessions-watcher / sessions 的既有 server 判据单跑退出 0（执行时以实测为准；若文件名漂移用等价判据替换并记录）。
- [x] (f) **静态门**：`npx tsc --noEmit -p server/tsconfig.json` 退出 0；`npm run lint` 退出 0。
- [x] (g) **collateral**：新增一个 `server/**/*.test.ts` ⇒ quay-test-script 两条 pin 各 +1 及注释算术；覆盖率地板跌破 90% 才追加 suite-duration-baseline 行；单文件复跑 quay-test-script.test.ts 退出 0。
- [x] (h) **范围受控**：`git diff --name-only $(git merge-base HEAD develop) HEAD` ⊆ `## Touches`。

## DoD

真实落地的标准是「providers 组不再 import websocket、websocket 组退出了 SCC、退出是经端口注入」，不是「多了一个端口文件」。必须贴出：①(a)(b) 的 grep/test 读数与端口安装行；②(c) 判据打印的逐段 SCC 成员与 `websocketInProvidersScc=false`；③(d) AC-394 判据 G1/G2/G3 逐成员（5→3 后仍是基线子集）；④(e) 既有判据退出码；⑤(f) tsc/lint；⑥(g) collateral；⑦纯位移核对（广播/运行查询语义未变）。运行结束不重启 :3001、不发布。

## Evidence

**2026-10-23（续做轮）— 上一轮 suite 三条红同源：端口自安装缺失**

- 三条红（`debug-agent-external-write` / `session-upsert-broadcast` / `session-rename-route`）是同一根因，不是环境抖动：端口只在 `server/index.ts` 安装，而这三条判据都经由 websocket barrel + providers service 组装、不加载 composition root ⇒ `readSessionBroadcastPort()` 返回 null ⇒ rename 与 watcher 批量广播全部变成 no-op（读数 `0 !== 1`、drain `saw 0`），与日志里 `[sessions] rename ...` 之后没有任何帧一致。
- 修法：在 `server/modules/websocket/services/session-upsert-broadcast.service.ts` 模块体底部自安装 `installSessionBroadcastPort({ broadcastSessionUpserted, broadcastSessionUpsertedBatch })`，与 `websocket-state.service.ts:26`（connected-clients）、`chat-run-registry.service.ts:1343`（chat-run-registry）同款；这正是新 port 注释已声明、初版遗漏的装配点。`server/index.ts` 的显式安装保留（重复安装为 no-op，最后安装者胜出）。
- 单文件复跑读数：`session-upsert-broadcast.test.ts` 8/8 pass；`session-rename-route.test.ts` 4/4 pass；`debug-agent-external-write.test.ts` 5/5 pass（drain saw 2 upserts，blind criterion failures=[]）。
- 环不受影响：providers 侧仍只读端口（不新增 providers→websocket 边）；新增的自安装边方向是 websocket→shared，不进 providers/websocket 环。

## Touches

- `server/modules/providers/services/sessions-watcher.service.ts`（broadcastSessionUpsertedBatch 改经 port）
- `server/modules/providers/services/sessions.service.ts`（broadcastSessionUpserted + chatRunRegistry 改经 port）
- `server/shared/ports/session-broadcast.port.ts` (new)（broadcastSessionUpserted / broadcastSessionUpsertedBatch 能力）
- `server/shared/ports/chat-run-registry.port.ts`（条件性：read 函数覆盖 listRunningRuns/isProcessing；新成员可选）
- `server/modules/websocket/services/session-upsert-broadcast.service.ts`（端口自安装，与 websocket-state / chat-run-registry 同款；使不经 server/index.ts 的装配/判据也安装真实广播者）
- `server/index.ts`（assembly 安装 session-broadcast port）
- `server/modules/providers/tests/providers-websocket-cycle.test.ts` (new)（判据：复用 AC-394 扫描器断言 websocket 出环）
- `server/shared/tests/quay-test-script.test.ts`（collateral：两条 pin 各 +1 及注释算术）
- `server/shared/tests/server-import-cycle-budget.test.ts`（棘轮：G1 5→3 成员并同步注释/读数，属允许的缩小）
- `server/shared/tests/server-import-cycle-budget.baseline.json`（棘轮：G1 去掉 websocket 组）
- `scripts/suite-duration-baseline.tsv`（collateral：仅当覆盖率地板跌破 90%）
- `tasks/gap-providers-websocket-cycle-port-break.md`（自触）
