---
id: gap-voice-realtime-contract-hoist
title: voice-realtime 契约提升：把帧/exec status/seam 契约类型从 ws-proxy.service.ts 提升到独立
  voice-realtime-contract.ts，6 个叶子模块改 import 契约模块（依赖倒置走完）
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

**机制与去重（立案时实测，2026-10-22，HEAD 0acd5b0227fd）**：机制词 grep → 命中 `gap-mcp-contract-extract`（done）是**同机制**（契约提取）在 mcp-gateway 上的前例（把 mcp 契约提到 `server/shared/mcp-contract/`）；其余命中均为行为任务。**「把 voice-realtime 的契约类型从 ws-proxy god 文件提升到独立契约模块」无人认领** ⇒ 不重复，`gap-mcp-contract-extract` 作样板。granularity 报 peers：`gap-voice-realtime-ws-proxy-trunk-steps`（ready，共享 ws-proxy.service.ts）与 `gap-voice-settings-single-surface`（ready，共享 index.ts）⇒ 判定 **separate**（机制不同），调度器会按 Touches 串行，排序见下。

### 现状（立案时实测）

- `voice-realtime-ws-proxy.service.ts`（6576 行）里**定义了契约类型**：`VoiceRealtimeInboundFrame`(:976) / `VoiceRealtimeOutboundFrame`(:1025) / `VoiceRealtimeExecStatus`(:741) / `VoiceRealtimeNarratorTtsSeam`(:1654) / `VoiceRealtimeNarratorSeams`(:1667) / `VoiceRealtimeRunEndSummarySeams`(:1848) / `VoiceRealtimeRunEndAckSeam`(:1875) / `VoiceRealtimeProxySeams`(:1889) 等（以盘点为准）。
- **6 个叶子模块从 god 文件 import 契约**：`voice-realtime-tts-local.ts`、`voice-realtime-narrator.ts`、`voice-realtime-live-executor.ts`、`voice-realtime-frame-registry.ts`（刀3 产物）、`voice-realtime-diagnose.service.ts`、`index.ts`（barrel）。
- 后果：一个 TTS/transport/frame 后端作者要满足 `VoiceRealtimeNarratorTtsSeam` 就必须 import 整个 6576 行连接处理器——契约不能独立复用/测试，加后端就拖进 god 文件。这是「seam 有了、依赖倒置没走完」的病灶。

### 改法

把契约类型（帧 / exec status / seam）提升到独立 `voice-realtime-contract.ts`（纯类型搬迁，零运行时行为变化）；6 个叶子模块改从契约模块 import；`ws-proxy.service.ts` 与 barrel `index.ts` 保留 re-export 做向后兼容。收益：新后端 import 契约模块即可、新 seam 与连接处理器解耦、god 文件再瘦。

⛔ 护栏：契约模块是**纯类型/契约**（type-only + 必要的常量），不引入运行时逻辑；re-export 面保持公开签名不变。

<!-- dedup-ref --> 相关但不同机制：`gap-mcp-contract-extract`（done）是同机制在 mcp-gateway 的前例（样板，非前置）；`gap-voice-realtime-ws-proxy-trunk-steps`（ready，拆主干步骤）与本条**共享 ws-proxy.service.ts**、机制不同（它拆逻辑、本条搬契约），调度器串行；理想顺序是**本条先于主干步骤**落地（先把契约搬出去，主干步骤的新文件就能从契约模块 import 而非 god 文件），但本条判据是结构性（类型搬出）不依赖 ws-proxy 行数，故顺序非硬约束。

## Plan

1. **盘点**：列出 ws-proxy.service.ts 里的全部契约类型与 6 个叶子模块对它们的 import 清单。
2. **建契约模块**：`voice-realtime-contract.ts` 承载全部契约类型（帧 / exec status / seam），逐字搬迁。
3. **改 import**：6 个叶子模块改从契约模块 import；ws-proxy 与 barrel 保留 re-export。
4. **判据**：结构性断言「类型定义只在契约模块一处、叶子不再从 ws-proxy import 契约」。
5. **收口**：既有 voice-realtime 判据单跑仍绿、tsc/lint、范围受控。

## AC

- [x] (a) **契约模块存在且承载类型**：`test -f server/modules/voice-realtime/voice-realtime-contract.ts` 退出 0；`grep -qE "VoiceRealtimeInboundFrame|VoiceRealtimeOutboundFrame|VoiceRealtimeNarratorTtsSeam|VoiceRealtimeProxySeams" server/modules/voice-realtime/voice-realtime-contract.ts` 退出 0。
- [x] (b) **类型定义不再留在 ws-proxy**：`grep -cE "^export type VoiceRealtime(InboundFrame|OutboundFrame|ExecStatus|NarratorTtsSeam|NarratorSeams|RunEndSummarySeams|RunEndAckSeam|ProxySeams)" server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts` 计数 = **0**（ws-proxy 只允许 re-export，不允许再定义）。
- [x] (c) **6 个叶子不再从 ws-proxy import 契约**：`grep -rln "from './voice-realtime-ws-proxy.service.js'" server/modules/voice-realtime/voice-realtime-tts-local.ts server/modules/voice-realtime/voice-realtime-narrator.ts server/modules/voice-realtime/voice-realtime-live-executor.ts server/modules/voice-realtime/voice-realtime-frame-registry.ts server/modules/voice-realtime/voice-realtime-diagnose.service.ts` 计数 = **0**（这 5 个非 barrel 叶子的契约 import 全改指契约模块；barrel `index.ts` 允许 re-export 面保留）。
- [x] (d) **既有行为判据不改一字仍绿**：`server/modules/voice-realtime/tests/voice-realtime-ws-proxy.protocol-simulation.test.ts`、`voice-realtime-bridge.test.ts`、`voice-realtime-scripted-scenarios.test.ts` 各自单跑退出 0。
- [x] (e) **静态门**：`npx tsc --noEmit -p server/tsconfig.json` 退出 0；`npm run lint` 退出 0。
- [x] (f) **范围受控**：`git diff --name-only $(git merge-base HEAD develop) HEAD` ⊆ `## Touches`。

## DoD

真实落地的标准是「契约类型真的**住进了独立契约模块**、叶子模块不再为拿类型而 import god 文件」，不是「多了一个类型文件」。必须贴出：①(a)(b) 的 grep 计数与契约模块的导出清单；②(c) 5 个叶子改指后的 import 行原文（改前改后各一份）；③(d) 三条判据单跑退出码；④(e) tsc/lint；⑤纯搬迁核对（`git diff` 对契约类型是纯移动，公开签名/re-export 面未变；无法搬的类型逐条列出原因）；⑥`git diff` 只含 Touches。运行结束不重启 :3001、不发布。

## Touches

- `server/modules/voice-realtime/voice-realtime-contract.ts` (new)（帧 / exec status / seam 契约类型，纯类型）
- `server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts`（契约类型迁出，保留 re-export）
- `server/modules/voice-realtime/voice-realtime-tts-local.ts`（契约 import 改指契约模块）
- `server/modules/voice-realtime/voice-realtime-narrator.ts`（同上）
- `server/modules/voice-realtime/voice-realtime-live-executor.ts`（同上）
- `server/modules/voice-realtime/voice-realtime-frame-registry.ts`（同上）
- `server/modules/voice-realtime/voice-realtime-diagnose.service.ts`（同上）
- `server/modules/voice-realtime/index.ts`（barrel re-export 面保持）
- `server/modules/voice-realtime/tests/voice-realtime-ws-proxy.protocol-simulation.test.ts`（既有判据，不改一字，作行为覆盖）
- `tasks/gap-voice-realtime-contract-hoist.md`（自触）

## Blocker

**2026-10-22T09:09:34.191Z — worker 未落地（exited-not-landed）**

- 未落地原因：step=suite: not ok - server/modules/providers/tests/provider-capabilities-cancel-queued.test.ts:   AssertionError [ERR_ASSERTION]: the byte budget must still say why it cannot be a cancellation
- run_id：wk-prod-anchor
- session_id：ffec8c48-ff0b-4f97-be11-c2b5e9846b1e
