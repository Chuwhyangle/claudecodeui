---
id: gap-routine-architecture-analysis-file-scc-server-voice-realtime-connection-15
title: "architecture-analysis: All 15 files of
  server/modules/voice-realtime/connection form ONE file-level SCC (shortest
  cycle: connection-frames.ts:33 → ws-proxy.service.ts:385 → connect"
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
All 15 files of server/modules/voice-realtime/connection form ONE file-level SCC (shortest cycle: connection-frames.ts:33 → ws-proxy.service.ts:385 → connection-frames.ts) because frames.ts type-imports VoiceRealtimeConnection back from ws-proxy; the AC-394 directory ratchet reads 0 cycles here (single directory), and the 2026-11-15 split registered the package with the note 'edges run one-way, sccs=[]' — a directory-level claim the file-level reading contradicts.

载体记录（逐字来源）：`.quay/routine-findings.jsonl` · routine `architecture-analysis` · probe `architecture-analysis` · runId `architecture-analysis-1794995539540` · ts `2026-11-18T09:52:19.540Z`。

该 finding 由例程的机械通道产出，本任务由**同一条通道**依赖 `plugin/scripts/routine-file-gate.ts` 的三道闸
（quality / dedup / rate）机械立案 —— ⛔ 不是由人转抄，也不是由探针自行执行。

- 观测符号：`createDefaultVoiceRealtimeFrameRegistry`、`VoiceRealtimeConnection`、`installHostQueue`、`createVoiceRealtimeExecStatus`
- 涉及文件：
- `server/modules/voice-realtime/connection/voice-realtime-connection-frames.ts:33`
- `server/modules/voice-realtime/connection/voice-realtime-ws-proxy.service.ts:385`
- `server/modules/voice-realtime/connection/voice-realtime-frame-handlers.ts:134`
- kind：`cycle`
- verdict：`confirmed`

## Requested action
Extract a leaf contract module for the VoiceRealtimeConnection shape that frames.ts can import (breaking frames ⇄ ws-proxy), then re-measure the package with scanFileImportGraph and pin it.

## Effect Prediction
- metric: concept_recurs_after_merge
- expected: false
- statement: 修复后 `<none>` 不再以同一 subject 复发（同 concept_key 的后续记录数应为 0）
- recorded_at: 2026-11-18T09:52:19.540Z

## AC
- [x] `.quay/routine-findings.jsonl` 中 finding `file-scc-server-voice-realtime-connection-15`（routine `architecture-analysis`，runId `architecture-analysis-1794995539540`）所描述的问题被复核并处置
- [x] 处置结论可核：要么修掉，要么写明「已有机制在管、失败在哪一步」，⛔ 不以「已注意到」结案

## DoD
- [x] 上面的判据实跑通过
- [x] ⛔ 探针只立案不执行：本任务若需要跑产出者/修复，由派发链执行，⛔ 不由例程代跑

## Touches
- `server/modules/voice-realtime/connection/voice-realtime-connection-frames.ts`
- `server/modules/voice-realtime/connection/voice-realtime-ws-proxy.service.ts`
- `server/modules/voice-realtime/connection/voice-realtime-frame-handlers.ts`
- `server/modules/voice-realtime/connection/voice-realtime-contract.ts`
- `server/modules/voice-realtime/connection/voice-realtime-connection.ts` (new)
- `server/modules/voice-realtime/connection/voice-realtime-proxy-seams.ts` (new)
- `server/modules/voice-realtime/connection/voice-realtime-frame-registry.ts`
- `server/modules/voice-realtime/connection/voice-realtime-trunk-steps.ts`
- `server/modules/voice-realtime/connection/voice-realtime-trunk-step-handlers.ts`
- `server/modules/voice-realtime/connection/voice-realtime-connection-transport.ts`
- `server/modules/voice-realtime/connection/voice-realtime-connection-turn.ts`
- `server/modules/voice-realtime/voice-realtime-diagnose.service.ts`
- `server/modules/voice-realtime/tests/voice-realtime-bridge.test.ts`
- `server/shared/tests/server-import-cycle-budget.test.ts`
- `tasks/gap-routine-architecture-analysis-file-scc-server-voice-realtime-connection-15.md`

## Evidence

### 复核（before 读数，同一仪器）
`scanFileImportGraph(collectServerSources(server/).filter(path.startsWith('modules/voice-realtime/connection/')))`：
- files=15, intraPackageEdges=44, nonTrivialSccs=1，唯一 SCC 恰为 15 个文件全包（finding 逐字成立）。
- 环不是一条边，而是三处结点：(1) frames/connection-transport/connection-turn 从 ws-proxy 反向 type-import `VoiceRealtimeConnection`；(2) `VoiceRealtimeProxySeams` 住在 wire contract 里却命名 frame registry / settings / trunk step table，两侧互指；(3) trunk-steps/trunk-step-handlers 从 ws-proxy 反向取 `ModelInterruptDecision`/`VoiceRealtimeInboundFrame`/`VoiceRealtimeOutboundFrame`/`VoiceRealtimeProxySeams`，而不是从声明模块取。

### 处置（修掉，不是「已注意」）
- 新增 `voice-realtime-connection.ts`：`VoiceRealtimeConnection` 状态对象下沉为叶子，只命名类型与 bridge 的两个函数；installer 调用顺序留在组合根 `startVoiceRealtimeConnection()`（执行顺序逐行不变）。
- 新增 `voice-realtime-proxy-seams.ts`：`VoiceRealtimeProxySeams` 整体搬出 wire contract，位于其三个协作者之上。
- `VoiceRealtimeFrameContext.seams` / `VoiceRealtimeTrunkContext.seams` 改为窄结构视图（handler 实际只读 `audioCapture`/`log`/`speakerTracker`/`transport`），组合根的 seam bag 结构可赋值。
- trunk-steps / trunk-step-handlers 改从 `voice-realtime-instructions.js` 与 `voice-realtime-contract.js` 取类型。
- wire contract 不再 import registry/settings/trunk（755 行，低于 800 行棘轮线）。
- 依 findng 要求的第一刀（frames ⇄ ws-proxy）由新叶子模块直接完成；其余两处同类结点一并处置，包内 SCC 归零。

### 读数（after，scanFileImportGraph）
- L_G scanFileImportGraph(modules/voice-realtime/connection/): sccs=0 files=17 intraPackageEdges=50
- 判据测试：`server/shared/tests/server-import-cycle-budget.test.ts` case `(k)` —— 含两文件环正控 / 单向非环负控 + 非空性下限（files>=15, intraPackageEdges>=15），实跑 `[file-scc] files=17 intraPackageEdges=50 sccs=[]`。

### 实跑
- `tsc --noEmit -p server/tsconfig.json` → EXIT 0
- `npm run typecheck`（root + server + scripts 三配置）→ EXIT 0
- `server/shared/tests/server-import-cycle-budget.test.ts` → 13/13 pass（含新 case (k)）
- `server/shared/tests/architecture-ratchet.test.ts` → 6/6 pass；contract 1176→0（<800 落地，基线可下调，未上调任何读数）
- `server/modules/voice-realtime/tests/voice-realtime-ws-proxy.protocol-simulation.test.ts` → 24/24 pass
- `voice-realtime-trunk-steps.test.ts` 9/9、`voice-realtime-frame-registry.test.ts` 4/4、`voice-realtime-diagnose.test.ts` + `voice-realtime-segmented-protocol.test.ts` 33/33、`voice-realtime-active-sessions.test.ts` + `voice-realtime-teardown-races.test.ts` 7/7、`voice-realtime-bridge.test.ts` + `voice-realtime-continuous-empty-guard-span.test.ts` 23/23、`provider-capabilities-cancel-queued.test.ts` 2/2。
- `voice-realtime-bridge.test.ts` 的 AC4 false form 原先把 ws-proxy 当作 bridge import 所在的复制源；类下沉后 bridge import 在 `voice-realtime-connection.ts`，该 false form 改为同时复制 state 模块与 proxy 副本并逐级重定向，正控/负控均保持通过。

### 未做 / 边界
- 未下调 `architecture-ratchet.baseline.json` 的 contract 条目（1176）：现读数已低于 800 直接不计数，ratchet 判绿并提示可下调；本任务不改共享基线，避免与并行 SCC 任务争同一文件。
- 目录级 AC-394 读数未变（单目录本来 0 环），`GATE_DIRECTORY_PIN` 无新目录，故未改。

## Blocker

**2026-11-18T10:39:59.229Z — worker 未落地（exited-not-landed）**

- 未落地原因：step=suite: not ok - src/modules/chat/utils/tests/voiceLiveSegmenter.test.ts: AssertionError [ERR_ASSERTION]: the long-corpus sample is missing at /data/home/yale/work/tc-verify/corpus/long/L4-nonstop.wav — the criterion cannot run without it [baseline A/B: HARD RED (changed-assertion) — the task's red set is NOT a subset of the develop baseline red set: added=- changed=src/modules/chat/utils/tests/voiceLiveSegmenter.test.ts]
- run_id：wk-prod-anchor
- session_id：7624f979-42d8-45d6-9473-33dc0093e6e9
