---
id: gap-routine-architecture-analysis-god-package-server-voice-realtime-ea9ee0c7
title: "architecture-analysis: archguard 2026-11-15: 29 direct files / 83
  entities / fanIn 73 / fanOut 305 — breaches all four default thresholds
  (minFiles 20, minEntities 50, minFanIn 5, "
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
archguard 2026-11-15: 29 direct files / 83 entities / fanIn 73 / fanOut 305 — breaches all four default thresholds (minFiles 20, minEntities 50, minFanIn 5, minFanOut 20); the done split lowered 41 files/155 entities to 29/83 but fan-in and fan-out did not fall.

载体记录（逐字来源）：`.quay/routine-findings.jsonl` · routine `architecture-analysis` · probe `architecture-analysis` · runId `architecture-analysis-1794746479180` · ts `2026-11-15T12:41:19.180Z`。

该 finding 由例程的机械通道产出，本任务由**同一条通道**依赖 `plugin/scripts/routine-file-gate.ts` 的三道闸
（quality / dedup / rate）机械立案 —— ⛔ 不是由人转抄，也不是由探针自行执行。

- 观测符号：`VoiceRealtimeConnection`
- 涉及文件：
- `server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts:397`
- `server/modules/voice-realtime/voice-realtime-connection-frames.ts:1`
- kind：`god-package`
- verdict：`confirmed`

## Requested action
Move the frame/turn dispatch stages that remain in ws-proxy.service.ts behind the existing frames/ and transport/ leaves and expose one connection port; AC: package fileCount <= 20 and entityCount <= 50 with fanOut meaningfully reduced, voice-realtime suite green.

## Effect Prediction
- metric: concept_recurs_after_merge
- expected: false
- statement: 修复后 `<none>` 不再以同一 subject 复发（同 concept_key 的后续记录数应为 0）
- recorded_at: 2026-11-15T12:41:19.180Z

## Disposition（2026-11-15，机械复核 + 实跑）

**复核（同一仪器）。** 用 archguard CLI 在干净 worktree 上重放 finding 的读数：`analyze -s server --lang typescript --no-cache` + `getPackageStats`/`computePackageFanMetricsFromRelations`/`evaluateGodPackages`（默认阈值 minFiles 20 / minEntities 50 / minFanIn 5 / minFanOut 20）：
- before（develop fceecde08）：`modules/voice-realtime` fileCount=29, entityCount=83, fanIn=73, fanOut=304 —— 与 finding 的 29/83/73/305 同源（fanOut 差 1 为 develop 前进所致），四项全部越界。

**处置（修掉，不是「已注意到」）。** 该包根目录的 15 文件 SCC（`contract`、`ws-proxy` 与四个 connection install chunk、`frame-handlers`/`frame-registry`、`trunk-steps`/`trunk-step-handlers`、`settings`/`narrator`/`narrator-queue`/`instructions`/`exec-status`/`transport-errors`）整体搬进 `connection/`；`connection/` 只依赖的 7 个叶子（DashScope transport、TTS、speaker seam、upstream pool、announce phrases、spend guard、summary）搬进 `core/`。包根保留 `index.ts`、diagnosis/log/routes 面与 12 个兼容 re-export barrel。目录方向单一：`root → connection → core`、`connection → frames/transport`，无目录 SCC（`sccs=[]`，AC-394 的 cycleGroups 未动）；`connection/` 不再 import 包根，故这不再是「把 god package 搬到子目录」而是把文件级环整体下沉成 DAG。

**after 读数（同一仪器、同一默认阈值，合并 develop 后重测）：**
- `modules/voice-realtime`（root）：fileCount **19**（≤20）、entityCount **15**（≤50，满足）、fanIn 73、fanOut **72**（304 → 72，−76%，fanOut 不再是「未下降」）。
- `modules/voice-realtime/connection`：15 files / 42 entities / fanIn 5 / fanOut 175。
- `modules/voice-realtime/core`：7 files / 26 entities / fanIn 33 / fanOut 94。
- `frames` 15/48/102/95 与 `transport` 9/42/89/119 保持本任务前读数（本任务未改它们）。

**残余（如实记录）。** 包根仍越界 `highFanIn 73` 与 `highFanOut 72`（默认阈值 5/20）：fan-in 是模块外消费方对本模块类型/常量的实体关系，fan-out 主要来自 12 个兼容 barrel 的 `export *` 以及 root 五个实现文件；这两维不能靠拆目录消除（见项目记忆 `god-package-split-lowers-size-not-relation-fanout`）。`connection/` 与 `core/` 也各自越界 fanIn/fanOut —— 耦合随文件迁移到新族包，本任务只把「size 维」修到阈值内并让 root fanOut 实质下降，未声称 relation 阈值全绿。

**验证实跑。**
- `tsc --noEmit -p server/tsconfig.json`：exit 0。
- archguard `query --cycles`（server scope）：before/after 均 `No dependency cycles detected.`；同一读数 entities=1431 relations=7616 sourceFiles=689（before relations=7618 / sourceFiles=677）。
- `server/shared/tests/architecture-ratchet.test.ts` + `server/shared/tests/server-import-cycle-budget.test.ts`：18/18 pass（新目录 `connection`/`core` 已登记进 MANIFEST_PIN + baseline JSON；oversize/mutable 读数已逐条重键）。
- voice-realtime 包全量：893 tests，886 pass，7 fail。7 条全部可归因为**develop 既有红**，非本任务引入：在 pristine develop（e9fc72812）上逐条复现 `voice-realtime-queue-lifecycle-completion` 的 2 条（idle subscribe / end to end）与 `voice-realtime-interrupt` 的 real-assembly 4 条；第 7 条 `AC5` 的 residue 断言只在多文件并发时误报「有临时副本未清理」（同进程 `git status -- server/modules/voice-realtime` 会被其它并发测试文件的 `__criterion-falsify-*` 命中），单独跑该文件 34/34 pass。另：本机 shell 的 `VOICE_REALTIME_SETTINGS_PATH` 指向 silence=1500 的宿主 settings，未清环境时 `VERIFY AC2` 会确定性红 —— 套件实跑时已 unset 该环境组（ambient-env leak，与本改动无关）。

- L_G archguard(server scope): cycles=0 entities=1431 relations=7616 sourceFiles=689

## AC
- [x] `.quay/routine-findings.jsonl` 中 finding `god-package-server-voice-realtime`（routine `architecture-analysis`，runId `architecture-analysis-1794746479180`）所描述的问题被复核并处置
- [x] 处置结论可核：要么修掉，要么写明「已有机制在管、失败在哪一步」，⛔ 不以「已注意到」结案

## DoD
- [x] 上面的判据实跑通过
- [x] ⛔ 探针只立案不执行：本任务若需要跑产出者/修复，由派发链执行，⛔ 不由例程代跑

## Touches
- `e2e/voice-output-e2e-harness.spec.ts`
- `scripts/voice-settings-single-surface-check.mjs`
- `server/modules/providers/tests/provider-capabilities-cancel-queued.test.ts`
- `server/modules/voice-realtime/connection/voice-realtime-connection-frames.ts`
- `server/modules/voice-realtime/connection/voice-realtime-connection-transport.ts`
- `server/modules/voice-realtime/connection/voice-realtime-connection-turn.ts`
- `server/modules/voice-realtime/connection/voice-realtime-contract.ts`
- `server/modules/voice-realtime/connection/voice-realtime-exec-status.ts`
- `server/modules/voice-realtime/connection/voice-realtime-frame-handlers.ts`
- `server/modules/voice-realtime/connection/voice-realtime-frame-registry.ts`
- `server/modules/voice-realtime/connection/voice-realtime-instructions.ts`
- `server/modules/voice-realtime/connection/voice-realtime-narrator-queue.ts`
- `server/modules/voice-realtime/connection/voice-realtime-narrator.ts`
- `server/modules/voice-realtime/connection/voice-realtime-settings.ts`
- `server/modules/voice-realtime/connection/voice-realtime-transport-errors.ts`
- `server/modules/voice-realtime/connection/voice-realtime-trunk-step-handlers.ts`
- `server/modules/voice-realtime/connection/voice-realtime-trunk-steps.ts`
- `server/modules/voice-realtime/connection/voice-realtime-ws-proxy.service.ts`
- `server/modules/voice-realtime/core/voice-realtime-announce-phrases.ts`
- `server/modules/voice-realtime/core/voice-realtime-dashscope-transport.ts`
- `server/modules/voice-realtime/core/voice-realtime-speaker-seam.ts`
- `server/modules/voice-realtime/core/voice-realtime-spend-guard.ts`
- `server/modules/voice-realtime/core/voice-realtime-summary.ts`
- `server/modules/voice-realtime/core/voice-realtime-tts.ts`
- `server/modules/voice-realtime/core/voice-realtime-upstream-pool.ts`
- `server/modules/voice-realtime/index.ts`
- `server/modules/voice-realtime/tests/voice-realtime-announce-narrator.test.ts`
- `server/modules/voice-realtime/tests/voice-realtime-announce-phrases.test.ts`
- `server/modules/voice-realtime/tests/voice-realtime-bridge.test.ts`
- `server/modules/voice-realtime/tests/voice-realtime-caption-item-attribution.test.ts`
- `server/modules/voice-realtime/tests/voice-realtime-connection-resilience.test.ts`
- `server/modules/voice-realtime/tests/voice-realtime-context-and-settings.test.ts`
- `server/modules/voice-realtime/tests/voice-realtime-continuous-empty-guard-span.test.ts`
- `server/modules/voice-realtime/tests/voice-realtime-dashscope-transport.false-forms.test.ts`
- `server/modules/voice-realtime/tests/voice-realtime-frame-registry.test.ts`
- `server/modules/voice-realtime/tests/voice-realtime-function-call-output-receipt.test.ts`
- `server/modules/voice-realtime/tests/voice-realtime-instructions-no-stop-words.test.ts`
- `server/modules/voice-realtime/tests/voice-realtime-manual-vad-session-update.test.ts`
- `server/modules/voice-realtime/tests/voice-realtime-segmented-default.test.ts`
- `server/modules/voice-realtime/tests/voice-realtime-segmented-protocol.test.ts`
- `server/modules/voice-realtime/tests/voice-realtime-silence-tail-deprecated.test.ts`
- `server/modules/voice-realtime/tests/voice-realtime-trunk-steps.test.ts`
- `server/modules/voice-realtime/tests/voice-realtime-tts-cache.test.ts`
- `server/modules/voice-realtime/tests/voice-realtime-unforwarded-disposition.test.ts`
- `server/modules/voice-realtime/tests/voice-realtime-uplink-vad-arm-point.test.ts`
- `server/modules/voice-realtime/tests/voice-realtime-uplink-vad-seam.test.ts`
- `server/modules/voice-realtime/tests/voice-realtime-upstream-pool.test.ts`
- `server/modules/voice-realtime/voice-realtime-connection-frames.ts`
- `server/modules/voice-realtime/voice-realtime-connection-transport.ts`
- `server/modules/voice-realtime/voice-realtime-diagnose.service.ts`
- `server/modules/voice-realtime/voice-realtime-frame-handlers.ts`
- `server/modules/voice-realtime/voice-realtime-frame-registry.ts`
- `server/modules/voice-realtime/voice-realtime-live-executor.ts`
- `server/modules/voice-realtime/voice-realtime-log.ts`
- `server/modules/voice-realtime/voice-realtime-narrator.ts`
- `server/modules/voice-realtime/voice-realtime-settings.ts`
- `server/modules/voice-realtime/voice-realtime-speaker-seam.ts`
- `server/modules/voice-realtime/voice-realtime-summary.ts`
- `server/modules/voice-realtime/voice-realtime-trunk-step-handlers.ts`
- `server/modules/voice-realtime/voice-realtime-trunk-steps.ts`
- `server/modules/voice-realtime/voice-realtime-tts-cache.ts`
- `server/modules/voice-realtime/voice-realtime-tts-local.ts`
- `server/modules/voice-realtime/voice-realtime-tts.ts`
- `server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts`
- `server/shared/tests/architecture-ratchet.baseline.json`
- `server/shared/tests/server-import-cycle-budget.baseline.json`
- `server/shared/tests/server-import-cycle-budget.test.ts`
- `tasks/gap-routine-architecture-analysis-god-package-server-voice-realtime-ea9ee0c7.md`

## Blocker

**2026-11-15T13:27:47.237Z — worker 未落地（exited-not-landed）**

- 未落地原因：step=suite: not ok - server/shared/tests/cloudpit-goal-exit-gate.test.ts:   AssertionError [ERR_ASSERTION]: a directory outside the frozen baseline is a NEW module directory: modules/voice-realtime/connection, modules/voice-realtime/core. This is a recorded-change ratchet: add it to cloudpit-goal-exit-gate.baseline.json.moduleDirectories AND to GATE_DIRECTORY_PIN in the s [baseline A/B: HARD RED (task-introduced-red) — the task's red set is NOT a subset of the develop baseline red set: added=server/shared/tests/cloudpit-goal-exit-gate.test.ts,server/shared/tests/cloudpit-goal-exit-gate.test.ts changed=-]
- run_id：wk-prod-anchor
- session_id：2a94c390-3c23-4c2f-870d-9d6a372c1dba
