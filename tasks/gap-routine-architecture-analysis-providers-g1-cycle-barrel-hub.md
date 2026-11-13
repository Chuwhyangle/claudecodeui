---
id: gap-routine-architecture-analysis-providers-g1-cycle-barrel-hub
title: "architecture-analysis: Fresh archguard package-cycle reading (scope
  server, bcc56acf) finds exactly one directory SCC: modules/providers <->
  modules/providers/list/claude <-> modul"
status: done
labels:
  - gap
  - routine-filed
  - architecture-analysis
parent: null
children: []
extra: {}
---
## Finding

Fresh archguard package-cycle reading (scope server, bcc56acf) finds exactly one directory SCC: modules/providers <-> modules/providers/list/claude <-> modules/providers/services, 68 edges — but 56 of them leave modules/providers and 43 of those originate in the 373-line barrel index.ts alone (`export { sessionSynchronizerService } from './services/session-synchronizer.service.js'` at :1, `export { readSessionTurn } from './list/claude/claude-runtime.provider.js'` at :171), so the cycle is a barrel re-export hub, not an intrinsic dependency web; AC-394's budget pin (G1, 3 members) forbids growth but never shrinks it, and no open task targets it.

载体记录（逐字来源）：`.quay/routine-findings.jsonl` · routine `architecture-analysis` · probe `architecture-analysis` · runId `architecture-analysis-1794573630786` · ts `2026-11-13T12:40:30.786Z`。

该 finding 由例程的机械通道产出，本任务由**同一条通道**依赖 `plugin/scripts/routine-file-gate.ts` 的三道闸
（quality / dedup / rate）机械立案 —— ⛔ 不是由人转抄，也不是由探针自行执行。

- 观测符号：`sessionSynchronizerService`、`providerMcpService`、`providerRegistry`、`deriveHeldWorkLeases`
- 涉及文件：
- `server/modules/providers/index.ts:1`
- `server/modules/providers/index.ts:171`
- `server/modules/providers/services/claude-activity-lease-deriver.service.ts:56`
- `server/modules/providers/services/mcp.service.ts:1`
- kind：`dependency-cycle`
- verdict：`confirmed-pinned`

## Requested action

Route the providers -> services and providers -> list/claude re-exports through the shared/ports families (the method used for the earlier G1 shrink from 11 to 8 members) and drop the value re-exports from index.ts; re-measure G1 and lower CYCLE_GROUPS plus server-import-cycle-budget.baseline.json only if the member set actually shrinks.

## Effect Prediction

- metric: concept_recurs_after_merge
- expected: false
- statement: 修复后 `<none>` 不再以同一 subject 复发（同 concept_key 的后续记录数应为 0）
- recorded_at: 2026-11-13T12:40:30.786Z

## 复核与处置（2026-11-13，派发链 worker）

**复核（用仓库自己的读法，与 AC-394 同源）**：`server/shared/imports/import-graph.ts` 在 scope=server 上重测，finding 属实，且树上的非平凡目录 SCC 只有这一个：

- before: `sccs=[[modules/providers, modules/providers/list/claude, modules/providers/services]]`，组内目录边 5 条 / 组内文件边 43 条。其中 barrel `index.ts` 自己贡献 18 条（root->services 12、root->list/claude 6），其余由 `provider.registry.ts`(5)、`provider.routes.ts`(8) 以及反向的 services->root(7)、services->list/claude(3)、list/claude->services(2) 构成。
- 闭环不是 barrel 自己。真正把环闭上的两条腿是：
  (a) 7 个 `services/*.service.ts` 直接 import 父目录的 `provider.registry.ts`（services -> modules/providers）；
  (b) 2 个 `list/claude` 文件 import `services/session-ai-title.service.ts`（list/claude -> services）。
- barrel `index.ts` 的组内出边只是把一个本就存在的环放大成“re-export hub”的形状；只删 barrel 不够，删掉上面两条腿才是修复。

**修复（两个只删边的改动，不新增成员、不合并组）**：

1. 完成既有的 shared/ports 迁移。`shared/ports/provider-registry.port.ts` 的文件头 WHY 段就是为这条父目录边写的，但此前只有 `provider-runtime.service.ts` 转过；其余 7 个解析 provider 的服务（mcp / provider-auth / provider-models / provider-token-usage / sessions / session-synchronizer / skills）改为在方法体内 `readProviderRegistryPort()`。→ 删掉 services -> modules/providers 的 7 条文件边。`provider-models.service.ts` 的默认依赖改为惰性读取，避免在 port 安装前冻结 null。
2. `services/session-ai-title.service.ts` 是 Claude 专属读取器（`row.provider !== 'claude'` 直接返回 null），移入 `list/claude/session-ai-title.service.ts`，barrel 与另外两个 Claude 消费点同步改路径。→ 删掉 list/claude -> services 的 2 条文件边。

**after**：`sccs=[]`（目录图已无非平凡 SCC：G1 是最后一个，3 成员 -> 0 成员）；`staticEdges=2730 dynamicEdges=4 unresolvedInternal=17`（预算 19，未上调）。

- L_G archguard (scope=server, AC-394 scanner, 2026-11-13): directory_cycles=0, before_members=3, after_members=0, staticEdges=2730, dynamicEdges=4, unresolvedInternal=17

**ratchet 只许下调方向的账目**：

- `CYCLE_GROUPS.G1` 与 `server-import-cycle-budget.baseline.json` 的 `cycleGroups.G1`：3 成员 -> 空组，并写入第二十次 RECORDED CHANGE。
- 摘要行判据原本不接受 `sccs=[]`；ratchet 收缩到 0 是合法不动点，判据放宽为允许空列表（数字形状不变）。
- `architecture-ratchet.baseline.json` 的 `providerNameBranches` 读数随文件移动按原值 re-key（1 -> 1，不上调）。

**证据（本 worktree 实跑）**：

- `server/shared/tests/server-import-cycle-budget.test.ts`：18/18 pass，打印 `files=666 staticEdges=2730 dynamicEdges=4 sccs=[]`，`unresolvedInternal=17 budget=19`。
- `server/shared/tests/architecture-ratchet.test.ts`：AC1–AC5 全绿（re-key 后无违规）。
- 受影响 providers 测试全绿：mcp / skills / sessions.service / sessions-details / provider-token-usage / session-ai-title（66 pass）；codex-message-editing / claude-session-name-authority / session-orphan-prune / model-secret-write-only / codex-model-provider-option / codex-provider-model-binding（48 pass, 1 skip）；model-config-write-path（5 pass）；session-fork / session-window-around / provider-runtime / codex-sessions / provider-models / session-synchronizer-coalescing 等在同一批次 pass。
- `tsc --noEmit -p server/tsconfig.json` 无输出。

**测试的显式化**：直接 import 被转换的服务或 `provider.routes`（不经过 barrel / 组装根）的测试，现在显式 `import '@/modules/providers/provider.registry.js'` 来安装 port —— 这正是它们此前经由服务的静态 import 隐式拿到的依赖，port 文件头也补了这条说明。

**续做（2026-11-13，suite-red 复核）**：

- 上一轮 fan-in 的唯一新增红是 `server/modules/voice/tests/voice-provider-cycle.test.ts`：它的“非真空”守卫断言“树上仍至少有一个非平凡 SCC（剩下的 provider 环）”。本任务恰好删掉了最后一个环（`sccs=[]`），所以该守卫的前提被本任务合法推翻 —— 这是真实的任务引入红，不是环境噪声。
- 处置：把该守卫从“必须有剩余环”改为锚在读法本身 —— 仍断言 `graph.files > 0` 且新增 `graph.dirEdges.length > 0`（死走法两者皆 0，仍会误绿），判别力由保留的 false-form 夹具用例证明（同一扫描器在夹具上仍能报出 `[modules/providers, modules/voice]`）。文件头注释同步说明七成员余环已在本任务后不再存在。
- 实跑：`node --import tsx --test server/modules/voice/tests/voice-provider-cycle.test.ts` → 2/2 pass，打印 `[voice-cycle] files=666 staticEdges=2730 dynamicEdges=4 sccs=[]`、`voiceInAnyScc=false`、`fixture SCCs=[["modules/providers","modules/voice"]]`。
- 同轮另外两条红（`src/modules/architecture/tests/plantUmlText.test.ts`、`src/shared/asr/tests/asrContractInvariants.test.ts`，均为 STACK_TRACE_ERROR）不在本任务本次 diff 的 added 集合里，属 develop 基线红（driver 的 baseline A/B 只把 voice 一条列为 added）。

## AC

- [x] `.quay/routine-findings.jsonl` 中 finding `providers-g1-cycle-barrel-hub`（routine `architecture-analysis`，runId `architecture-analysis-1794573630786`）所描述的问题被复核并处置
- [x] 处置结论可核：要么修掉，要么写明「已有机制在管、失败在哪一步」，⛔ 不以「已注意到」结案

## DoD

- [x] 上面的判据实跑通过
- [x] ⛔ 探针只立案不执行：本任务若需要跑产出者/修复，由派发链执行，⛔ 不由例程代跑（本任务的复核与修复由派发链 worker 执行；例程只写了 findings 行）

## Touches

- `server/modules/providers/index.ts`
- `server/modules/providers/list/claude/claude-resident-lifecycle-outcome-handlers.ts`
- `server/modules/providers/list/claude/claude-session-synchronizer.provider.ts`
- `server/modules/providers/list/claude/session-ai-title.service.ts`
- `server/modules/providers/services/session-ai-title.service.ts`
- `server/modules/providers/services/mcp.service.ts`
- `server/modules/providers/services/provider-auth.service.ts`
- `server/modules/providers/services/provider-models.service.ts`
- `server/modules/providers/services/provider-token-usage.service.ts`
- `server/modules/providers/services/session-synchronizer.service.ts`
- `server/modules/providers/services/sessions.service.ts`
- `server/modules/providers/services/skills.service.ts`
- `server/modules/providers/tests/claude-session-name-authority.test.ts`
- `server/modules/providers/tests/codex-message-editing.test.ts`
- `server/modules/providers/tests/codex-model-provider-option.test.ts`
- `server/modules/providers/tests/codex-provider-model-binding.test.ts`
- `server/modules/providers/tests/codex-sessions.test.ts`
- `server/modules/providers/tests/mcp.test.ts`
- `server/modules/providers/tests/model-config-write-path.test.ts`
- `server/modules/providers/tests/model-secret-write-only.test.ts`
- `server/modules/providers/tests/provider-token-usage.service.test.ts`
- `server/modules/providers/tests/session-orphan-prune.test.ts`
- `server/modules/providers/tests/sessions-details.test.ts`
- `server/modules/providers/tests/sessions.service.test.ts`
- `server/modules/providers/tests/skills.test.ts`
- `server/modules/voice/tests/voice-provider-cycle.test.ts`
- `server/shared/ports/provider-registry.port.ts`
- `server/shared/tests/architecture-ratchet.baseline.json`
- `server/shared/tests/server-import-cycle-budget.baseline.json`
- `server/shared/tests/server-import-cycle-budget.test.ts`
- `tasks/gap-routine-architecture-analysis-providers-g1-cycle-barrel-hub.md`
