---
id: gap-voice-turn-detection-p0-11-finegrained-pareto-sweep
title: Live Voice Turn Detection P0.11：Smart Turn / LiveKit v1-mini
  细化参数网格扫描，补齐帕累托前沿断崖区域
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

### 现状

`...-p0-9-staged-cheap-feasibility`（done）用 P0.7 已有的粗网格（threshold/actionDelay/timeout，5454 组合→帕累托前沿）发现 Smart Turn 与 LiveKit v1-mini 都卡在预算线外一点点或退化成几乎不触发。人 yale 追问"能不能用稍高的漏端点率换更低的误截断率"，复核已有前沿数据后发现：**两个模型的前沿上都存在大段没扫到的空白区间（断崖），不是真的没有中间解，是网格太粗没扫到**，用户要求对这些空白区间做细化扫描。

### 已知的具体断崖区间（供实现直接引用，不必重新推导）

- **Smart Turn v3.2**：已扫点 threshold=0（actionDelay=1s，cutoff=13.79%/missed=0%/F1=0.957）→ threshold=0.75（actionDelay=1s,timeout=1.5s，cutoff=10.34%/missed=2.27%/F1=0.956）→ 断崖到 threshold=0.99（actionDelay=0.2s，cutoff=0%/missed=97.73%/F1=0.044）。threshold∈(0.75, 0.99) 之间、以及高 threshold 下 actionDelay∈(0.2s,1s) 之间完全没扫到。
- **LiveKit v1-mini**：已扫点 threshold=0（cutoff=13.79%/missed=0%）→ threshold=0.64（cutoff=10.34%/missed=27.27%/F1=0.810）→ threshold=0.75（cutoff=6.9%/missed=79.55%/F1=0.327）→ threshold=0.76/0.79 继续恶化。**目前前沿上没有任何点同时满足两条 10% 预算**，空白区在 threshold∈(0, 0.64) 及更细的 actionDelay/timeout 组合。
- **turn-1-mini**：P0.9 确认未安装；本任务重新核实一次是否已安装（零成本检查），若仍未安装如实记录，不为它编造扫描结果。

### 边界 / 不做

- ⛔ **零新增付费调用**：全部复用已有本地模型（Smart Turn 编译版、LiveKit v1-mini 隔离 sandbox）与已有 73 个候选点音频，只是在已识别的空白区间里加密 threshold/actionDelay/timeout 网格，重新跑本地推理/评分，不碰任何 DashScope Realtime 或非实时 Omni 调用。
- ⛔ 不碰 `...-p0-9`/`...-p0-10` 的 worktree 或任务体；本任务只读它们已落地在 develop 的 committed 数据，产出自己的新 artifact。
- ⛔ 不改默认 Live Voice 生产链路；`git diff develop -- server/modules/voice-realtime/voice-realtime-bridge.service.ts server/modules/voice-realtime/voice-realtime-dashscope-transport.ts src/modules/chat/voice-realtime/` 必须为空。
- ⛔ LiveKit 继续只在既有隔离 sandbox 里跑，不新增生产集成路径。
- ⛔ turn-1-mini 若未安装，不得编造扫描数字顶替。

## Plan

1. 在 Smart Turn 的 threshold∈[0.75, 0.99] 区间加密采样（如步长 0.01-0.02），并在该区间内对 actionDelay/timeout 做更细网格，重新跑本地 ONNX 推理评分，找出是否存在同时满足 cutoff≤10% 且 missed≤10% 的中间点。
2. 在 LiveKit v1-mini 的 threshold∈[0, 0.64] 区间加密采样，同样细化 actionDelay/timeout 网格，重新跑本地推理评分；由于该模型目前连最近的已扫点都没同时满足两条预算，重点是找"是否存在任何同时达标点"而不仅是优化已知点。
3. 重新核实 turn-1-mini 是否已安装；若已安装则同样做细化扫描，若未安装则如实记录。
4. 产出新的、更细的帕累托前沿（含原有粗网格点作对照），明确回答："细化后是否出现了之前粗网格漏掉的、同时满足两条 10% 预算的操作点？"每个模型分别给出是/否及具体数字。
5. 若找到达标点，更新 Go/No-Go 的可能性（但不越权改写 P0.9 已落地的结论，只记录新证据供人判断）；若细化后仍找不到，明确记录"已排除网格过粗的可能性，断崖是真实存在的"。

## AC

- [x] AC1 Smart Turn 细化扫描：threshold∈[0.75,0.99] 区间至少 10 个新采样点（含 actionDelay/timeout 细化组合），每点真实运行产出 cutoff/missed/F1，不是插值。
- [x] AC2 LiveKit 细化扫描：threshold∈[0,0.64] 区间同等细化，真实运行产出同口径读数。
- [x] AC3 turn-1-mini 重新核实安装状态；若安装则同样细化扫描，若未安装明确记录、不编数字。
- [x] AC4 新帕累托前沿：每个模型给出细化后的前沿，与原粗网格前沿并列对照，明确标注是否出现了能同时满足两条 10% 预算的新点。
- [x] AC5 明确结论：对每个模型回答"网格过粗导致看不到的中间解是否真实存在"，不得含糊。
- [x] AC6 零新增付费调用：机械证据证明全程没有新的 DashScope Realtime 或非实时 Omni 调用。
- [x] AC7 生产面零改动：`git diff develop` 对三个生产路径文件/目录为空；不碰 P0.9/P0.10 的 worktree 或任务体。
- [x] AC8 静态门：`npm run typecheck` 退出 0；若新增 server/** 测试文件，同步 `server/shared/tests/quay-test-script.test.ts` 文件数钉子与耗时基线。

## DoD

细化扫描的每个新点都必须是真实本地推理产出的数字，不是对已知两点的插值或猜测；turn-1-mini 的安装状态必须真实核查；最终结论必须明确回答"断崖是真实存在还是网格过粗的假象"，每个模型分别给出；不得覆盖/篡改 P0.9/P0.10 已落地的 artifact，本任务产出自己的新文件。零改动生产默认 Live Voice 链路，零新增付费上游调用。

## Touches

- experiments/voice-turn-detection-compare/finegrained-sweep/ (new)
- experiments/voice-turn-detection-compare/finegrained-sweep/smart-turn-densify.mts (new)
- experiments/voice-turn-detection-compare/finegrained-sweep/livekit-densify.mts (new)
- experiments/voice-turn-detection-compare/finegrained-sweep/RESULT.json (new)
- experiments/voice-turn-detection-compare/finegrained-sweep/CONCLUSION.md (new)
- tasks/gap-voice-turn-detection-p0-11-finegrained-pareto-sweep.md